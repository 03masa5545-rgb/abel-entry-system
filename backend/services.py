"""入退室のコアロジック。仕様書 §5 / §14 に対応する。"""
import csv
import io
import threading
import uuid
from datetime import timedelta

from . import config, db, switchbot_api

# 解錠API呼び出しの直列化（一斉入室時に SwitchBot API へ同時多重リクエストしない）
_unlock_lock = threading.Lock()


def _uid():
    return uuid.uuid4().hex


def _log(conn, member_id, line_user_id, type_, result, method):
    conn.execute(
        "INSERT INTO access_logs(log_id, member_id, line_user_id, type, result, method, created_at)"
        " VALUES(?, ?, ?, ?, ?, ?, ?)",
        (_uid(), member_id, line_user_id, type_, result, method, db.now_iso()),
    )
    conn.commit()


def get_member(conn, line_user_id):
    return conn.execute(
        "SELECT * FROM members WHERE line_user_id = ?", (line_user_id,)
    ).fetchone()


def register_member(conn, line_user_id, name):
    existing = get_member(conn, line_user_id)
    ts = db.now_iso()
    if existing:
        conn.execute(
            "UPDATE members SET name = ?, updated_at = ? WHERE member_id = ?",
            (name, ts, existing["member_id"]),
        )
        conn.commit()
        return get_member(conn, line_user_id)
    member_id = "m_" + _uid()[:12]
    # linked_at は公式LINE連携（アカウント連携フロー）の完了時にセットする。登録時点では未連携。
    conn.execute(
        "INSERT INTO members(member_id, line_user_id, name, status, registered_at, linked_at, updated_at)"
        " VALUES(?, ?, ?, 'active', ?, NULL, ?)",
        (member_id, line_user_id, name, ts, ts),
    )
    conn.commit()
    return get_member(conn, line_user_id)


def open_stay(conn, member_id):
    return conn.execute(
        "SELECT * FROM stays WHERE member_id = ? AND exit_method = 'open'"
        " ORDER BY entry_at DESC LIMIT 1",
        (member_id,),
    ).fetchone()


def _close_stay(conn, stay, exit_dt, exit_method):
    minutes = int((exit_dt - db.parse_iso(stay["entry_at"])).total_seconds() // 60)
    conn.execute(
        "UPDATE stays SET exit_at = ?, exit_method = ?, stay_minutes = ? WHERE stay_id = ?",
        (exit_dt.isoformat(timespec="seconds"), exit_method, minutes, stay["stay_id"]),
    )
    conn.commit()
    return minutes


def get_switchbot_creds(conn):
    """SwitchBot 認証情報を返す (token, secret, device_id, source)。

    管理者画面で保存した DB の値を優先し、無い項目は環境変数で補う。
    """
    env_token, env_secret, env_device = switchbot_api.env_creds()
    sb_token = db.get_setting(conn, "sb_token", "") or env_token
    sb_secret = db.get_setting(conn, "sb_secret", "") or env_secret
    sb_device = db.get_setting(conn, "sb_device_id", "") or env_device
    from_db = bool(
        db.get_setting(conn, "sb_token", "")
        or db.get_setting(conn, "sb_secret", "")
        or db.get_setting(conn, "sb_device_id", "")
    )
    return sb_token, sb_secret, sb_device, ("db" if from_db else "env")


def switchbot_status(conn):
    token, secret, device_id, source = get_switchbot_creds(conn)
    configured = bool(token and secret and device_id)
    masked = ""
    if device_id:
        masked = "****" + device_id[-4:] if len(device_id) > 4 else "****"
    return {
        "configured": configured,
        "source": source if configured else None,
        "device_id_masked": masked,
        "has_token": bool(token),
        "has_secret": bool(secret),
    }


def cooldown_seconds(conn):
    return int(db.get_setting(conn, "unlock_cooldown_sec", config.get_int("UNLOCK_COOLDOWN_SEC", 30)))


def unlock_share_seconds(conn):
    """解錠の共有ウィンドウ（秒）。この間に誰かが解錠済みなら、次の人はAPIを呼ばずに入れる。"""
    return int(db.get_setting(conn, "unlock_share_sec", config.get_int("UNLOCK_SHARE_SEC", 10)))


def event_mode_until(conn):
    value = db.get_setting(conn, "event_mode_until", "")
    if not value:
        return None
    until = db.parse_iso(value)
    if until and until > db.now():
        return until
    return None


def event_mode_active(conn):
    return event_mode_until(conn) is not None


def set_event_mode(conn, minutes):
    until = db.now() + timedelta(minutes=int(minutes))
    db.set_setting(conn, "event_mode_until", until.isoformat(timespec="seconds"))
    return until


def clear_event_mode(conn):
    db.delete_setting(conn, "event_mode_until")


def _recently_unlocked(conn):
    """共有ウィンドウ内に解錠成功があるか。"""
    last = db.get_setting(conn, "last_unlock_at", "")
    if not last:
        return False
    last_dt = db.parse_iso(last)
    if not last_dt:
        return False
    return (db.now() - last_dt).total_seconds() < unlock_share_seconds(conn)


def _perform_unlock(conn, line_user_id, member_id, method):
    """解錠を実行する。戻り値: (unlock_mode, error_payload_or_None)

    - イベントモード中: 解錠しない（ドア開放前提で記録のみ）→ unlock_mode='event'
    - 共有ウィンドウ内: 直前の解錠でドアが開いている前提でAPIを呼ばない → 'shared'
    - それ以外: ロックを取り、ウィンドウを再確認してからAPIを呼ぶ → 'real' / 'mock'
    """
    if event_mode_active(conn):
        return "event", None
    if _recently_unlocked(conn):
        return "shared", None
    with _unlock_lock:
        # ロック待ちの間に他の人が解錠した可能性があるので再確認
        if _recently_unlocked(conn):
            return "shared", None
        sb_token, sb_secret, sb_device, _ = get_switchbot_creds(conn)
        mode, ok = switchbot_api.unlock(sb_token, sb_secret, sb_device)
        if not ok:
            _log(conn, member_id, line_user_id, "entry", "error", method)
            return None, (502, {"error": "unlock_failed", "message": "解錠に失敗しました。スタッフにお声がけください。"})
        db.set_setting(conn, "last_unlock_at", db.now_iso())
        return mode, None


def auto_exit_hours(conn):
    return int(db.get_setting(conn, "auto_exit_hours", config.get_int("AUTO_EXIT_HOURS", 12)))


def do_entry(conn, line_user_id, method="liff"):
    """入室（解錠）。戻り値: (http_status, payload)"""
    member = get_member(conn, line_user_id)
    if not member:
        _log(conn, None, line_user_id, "entry", "denied_unregistered", method)
        return 403, {"error": "unregistered", "message": "会員登録がまだです。先に登録してください。"}
    if member["status"] != "active":
        _log(conn, member["member_id"], line_user_id, "entry", "denied_suspended", method)
        return 403, {"error": "suspended", "message": "この会員は現在利用停止中です。スタッフにお声がけください。"}

    # クールダウン: 直近の解錠成功から一定秒以内の再リクエストは抑止
    cd = cooldown_seconds(conn)
    last = conn.execute(
        "SELECT created_at FROM access_logs WHERE member_id = ? AND type = 'entry' AND result = 'success'"
        " ORDER BY created_at DESC LIMIT 1",
        (member["member_id"],),
    ).fetchone()
    if last:
        elapsed = (db.now() - db.parse_iso(last["created_at"])).total_seconds()
        if elapsed < cd:
            _log(conn, member["member_id"], line_user_id, "entry", "cooldown", method)
            return 429, {"error": "cooldown", "message": "解錠済みです。そのままお入りください。"}

    # 退室忘れのまま再入室した場合は、先のセッションをこの時刻で閉じる（二重計上防止）
    stay = open_stay(conn, member["member_id"])
    if stay:
        _close_stay(conn, stay, db.now(), "forced")

    mode, error = _perform_unlock(conn, line_user_id, member["member_id"], method)
    if error:
        return error

    stay_id = "s_" + _uid()[:12]
    entry_at = db.now_iso()
    conn.execute(
        "INSERT INTO stays(stay_id, member_id, entry_at) VALUES(?, ?, ?)",
        (stay_id, member["member_id"], entry_at),
    )
    conn.commit()
    _log(conn, member["member_id"], line_user_id, "entry", "success", method)
    return 200, {
        "ok": True,
        "stay_id": stay_id,
        "entry_at": entry_at,
        "unlock_mode": mode,
        "event_mode": mode == "event",
    }


def do_exit(conn, line_user_id):
    """退室。戻り値: (http_status, payload)"""
    member = get_member(conn, line_user_id)
    if not member:
        return 403, {"error": "unregistered", "message": "会員登録がまだです。"}
    stay = open_stay(conn, member["member_id"])
    if not stay:
        return 404, {"error": "not_inside", "message": "入室中の記録がありません。"}
    minutes = _close_stay(conn, stay, db.now(), "actual")
    _log(conn, member["member_id"], line_user_id, "exit", "success", "liff")
    return 200, {"ok": True, "stay_minutes": minutes}


def run_auto_exit(conn):
    """入室から設定時間（初期12時間）を過ぎた未退室セッションを自動退室扱いにする。"""
    hours = auto_exit_hours(conn)
    threshold = db.now() - timedelta(hours=hours)
    rows = conn.execute(
        "SELECT * FROM stays WHERE exit_method = 'open'"
    ).fetchall()
    closed = 0
    for stay in rows:
        entry_dt = db.parse_iso(stay["entry_at"])
        if entry_dt <= threshold:
            exit_dt = entry_dt + timedelta(hours=hours)
            minutes = _close_stay(conn, stay, exit_dt, "auto")
            member = conn.execute(
                "SELECT line_user_id FROM members WHERE member_id = ?", (stay["member_id"],)
            ).fetchone()
            _log(
                conn,
                stay["member_id"],
                member["line_user_id"] if member else "",
                "auto_exit",
                "success",
                "system",
            )
            closed += 1
    return closed


def period_bounds(period):
    """期間の (開始ISO, 終了ISO) を返す。all の場合は (None, None)。"""
    today = db.now().date()
    if period == "month":
        start = today.replace(day=1)
        return start.isoformat(), None
    if period == "last_month":
        first_this = today.replace(day=1)
        last_month_end = first_this - timedelta(days=1)
        start = last_month_end.replace(day=1)
        return start.isoformat(), first_this.isoformat()
    return None, None


def rankings(conn, period="month", type_="count"):
    """ランキングを全件返す（順位つき）。type_ は count / duration。"""
    start, end = period_bounds(period)
    cond = "m.status = 'active'"
    params = []
    if start:
        cond += " AND s.entry_at >= ?"
        params.append(start)
    if end:
        cond += " AND s.entry_at < ?"
        params.append(end)
    rows = conn.execute(
        f"""
        SELECT m.member_id, m.name,
               COUNT(s.stay_id) AS cnt,
               COALESCE(SUM(CASE WHEN s.exit_method != 'open' THEN s.stay_minutes ELSE 0 END), 0) AS minutes
        FROM members m
        LEFT JOIN stays s ON s.member_id = m.member_id
        WHERE {cond}
        GROUP BY m.member_id
        """,
        params,
    ).fetchall()
    items = [
        {"member_id": r["member_id"], "name": r["name"], "count": r["cnt"], "minutes": r["minutes"]}
        for r in rows
        if r["cnt"] > 0
    ]
    key = "count" if type_ == "count" else "minutes"
    items.sort(key=lambda x: (-x[key], x["name"]))
    rank, prev = 0, None
    for i, item in enumerate(items):
        if item[key] != prev:
            rank = i + 1
            prev = item[key]
        item["rank"] = rank
    return items


def my_rank(conn, member_id, period="month"):
    result = {}
    for type_ in ("count", "duration"):
        items = rankings(conn, period, type_)
        key = "count" if type_ == "count" else "minutes"
        mine = next((i for i in items if i["member_id"] == member_id), None)
        label = "count" if type_ == "count" else "duration"
        result[label] = (
            {"rank": mine["rank"], "value": mine[key]} if mine else {"rank": None, "value": 0}
        )
    return result


def history_rows(conn, date_from=None, date_to=None, member_id=None, result=None):
    cond, params = [], []
    if date_from:
        cond.append("l.created_at >= ?")
        params.append(date_from)
    if date_to:
        cond.append("l.created_at < ?")
        # 終了日はその日の終わりまで含める
        end_dt = db.parse_iso(date_to + "T00:00:00+09:00") + timedelta(days=1)
        params[-1] = end_dt.isoformat(timespec="seconds")
    if member_id:
        cond.append("l.member_id = ?")
        params.append(member_id)
    if result:
        cond.append("l.result = ?")
        params.append(result)
    where = ("WHERE " + " AND ".join(cond)) if cond else ""
    return conn.execute(
        f"""
        SELECT l.created_at, l.member_id, COALESCE(m.name, '') AS name,
               l.type, l.result, COALESCE(l.method, '') AS method
        FROM access_logs l
        LEFT JOIN members m ON m.member_id = l.member_id
        {where}
        ORDER BY l.created_at DESC, l.rowid DESC
        """,
        params,
    ).fetchall()


def history_csv(conn, **filters):
    rows = history_rows(conn, **filters)
    # 滞在時間は stays と突き合わせて付ける。
    # actual は退室時刻≒ログ時刻、auto は退室時刻（入室+12h）が処理時刻より前に来る。
    closed = [
        (s["member_id"], db.parse_iso(s["exit_at"]), s["exit_method"], s["stay_minutes"])
        for s in conn.execute(
            "SELECT member_id, exit_at, exit_method, stay_minutes FROM stays WHERE exit_at IS NOT NULL"
        ).fetchall()
    ]

    def find_minutes(member_id, created_at, log_type):
        target = db.parse_iso(created_at)
        if log_type == "auto_exit":
            candidates = [
                (exit_dt, minutes)
                for mid, exit_dt, method, minutes in closed
                if mid == member_id and method == "auto" and exit_dt <= target
            ]
            if candidates:
                return max(candidates)[1]
            return ""
        for mid, exit_dt, method, minutes in closed:
            if mid == member_id and abs((exit_dt - target).total_seconds()) <= 5:
                return minutes
        return ""

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["日時", "会員ID", "氏名", "種別", "結果", "方法", "滞在時間（分）"])
    type_label = {"entry": "入室", "exit": "退室", "auto_exit": "自動退室", "unlock_staff": "スタッフ解錠"}
    for r in reversed(rows):
        minutes = ""
        if r["type"] in ("exit", "auto_exit") and r["member_id"]:
            minutes = find_minutes(r["member_id"], r["created_at"], r["type"])
        writer.writerow(
            [r["created_at"], r["member_id"] or "", r["name"], type_label.get(r["type"], r["type"]),
             r["result"], r["method"], minutes]
        )
    return "﻿" + buf.getvalue()


def ranking_csv(conn, period="month", type_="count"):
    items = rankings(conn, period, type_)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["順位", "会員ID", "氏名", "利用回数", "利用時間（分）"])
    for i in items:
        writer.writerow([i["rank"], i["member_id"], i["name"], i["count"], i["minutes"]])
    return "﻿" + buf.getvalue()


def record_export(conn, admin_line_user_id, kind, condition):
    conn.execute(
        "INSERT INTO export_logs(export_id, admin_line_user_id, kind, condition, exported_at)"
        " VALUES(?, ?, ?, ?, ?)",
        (_uid(), admin_line_user_id, kind, condition or "", db.now_iso()),
    )
    conn.commit()
