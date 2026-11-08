"""HTTP サーバーとルーティング。標準ライブラリのみ。"""
import json
import re
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import config, db, line_api, services, switchbot_api

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
CONN = db.connect()
db.init_db(CONN)


# ---------- 共通ヘルパー ----------

def resolve_line_user_id(handler, query):
    """リクエストから LINEユーザーID を確定する。

    - 本番: Authorization: Bearer <IDトークン> を LINE で検証して得る（必須）。
    - デモ: X-Line-User-Id ヘッダー（CSVリンク用に ?as= もデモ時のみ許可）。
    """
    if config.DEMO_MODE:
        uid = handler.headers.get("X-Line-User-Id")
        if not uid and "as" in query:
            uid = query["as"][0]
        return uid
    auth = handler.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return line_api.verify_id_token(auth[7:])
    return None


def member_json(row):
    if not row:
        return None
    return {
        "member_id": row["member_id"],
        "line_user_id": row["line_user_id"],
        "name": row["name"],
        "status": row["status"],
        "registered_at": row["registered_at"],
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # -- 応答ヘルパー --
    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, status, text, content_type, filename=None):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length == 0:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return {}

    def log_message(self, fmt, *args):
        print(f"[{self.address_string()}] {fmt % args}")

    # -- ルーティング --
    def do_GET(self):
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)
        try:
            if path in ("/", "/index.html"):
                return self.serve_static("index.html", "text/html; charset=utf-8")
            if path in ("/admin", "/admin.html"):
                return self.serve_static("admin.html", "text/html; charset=utf-8")
            if path in ("/app.js", "/admin.js"):
                return self.serve_static(path.lstrip("/"), "text/javascript; charset=utf-8")
            if path == "/style.css":
                return self.serve_static("style.css", "text/css; charset=utf-8")
            if path == "/api/config":
                return self.send_json(200, {"demoMode": config.DEMO_MODE, "liffId": config.LIFF_ID or None})
            if path == "/api/me":
                return self.api_me(query)
            if path == "/api/rankings":
                return self.api_rankings(query)
            if path.startswith("/api/admin/"):
                return self.api_admin_get(path, query)
            return self.send_json(404, {"error": "not_found"})
        except Exception as exc:
            print(f"[error] {exc}")
            return self.send_json(500, {"error": "server_error", "message": str(exc)})

    def do_POST(self):
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)
        try:
            if path == "/webhook/line":
                return self.webhook_line()
            if path == "/api/register":
                return self.api_register(query)
            if path == "/api/entry":
                return self.api_entry(query)
            if path == "/api/exit":
                return self.api_exit(query)
            if path == "/api/link/nonce":
                return self.api_link_nonce(query)
            if path.startswith("/api/admin/"):
                return self.api_admin_post(path, query)
            return self.send_json(404, {"error": "not_found"})
        except Exception as exc:
            print(f"[error] {exc}")
            return self.send_json(500, {"error": "server_error", "message": str(exc)})

    def serve_static(self, name, content_type):
        file_path = WEB_DIR / name
        if not file_path.exists():
            return self.send_json(404, {"error": "not_found", "message": f"{name} がまだありません"})
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # -- 利用者API --
    def require_user(self, query):
        uid = resolve_line_user_id(self, query)
        if not uid:
            self.send_json(401, {"error": "unauthorized", "message": "LINE認証が必要です。"})
            return None
        return uid

    def api_register(self, query):
        uid = self.require_user(query)
        if not uid:
            return
        body = self.read_json()
        name = (body.get("name") or "").strip()
        if not name:
            return self.send_json(400, {"error": "name_required", "message": "氏名を入力してください。"})
        member = services.register_member(CONN, uid, name)
        return self.send_json(200, member_json(member))

    def api_me(self, query):
        uid = self.require_user(query)
        if not uid:
            return
        member = services.get_member(CONN, uid)
        if not member:
            return self.send_json(200, {"member": None, "openStay": None, "history": [], "myRank": None})
        stay = services.open_stay(CONN, member["member_id"])
        history = CONN.execute(
            "SELECT type, result, created_at FROM access_logs WHERE member_id = ?"
            " ORDER BY created_at DESC LIMIT 20",
            (member["member_id"],),
        ).fetchall()
        return self.send_json(200, {
            "member": member_json(member),
            "openStay": ({"stay_id": stay["stay_id"], "entry_at": stay["entry_at"]} if stay else None),
            "history": [dict(r) for r in history],
            "myRank": services.my_rank(CONN, member["member_id"], "month"),
        })

    def api_entry(self, query):
        uid = self.require_user(query)
        if not uid:
            return
        body = self.read_json()
        status, payload = services.do_entry(CONN, uid, body.get("method") or "liff")
        return self.send_json(status, payload)

    def api_exit(self, query):
        uid = self.require_user(query)
        if not uid:
            return
        self.read_json()
        status, payload = services.do_exit(CONN, uid)
        return self.send_json(status, payload)

    def api_rankings(self, query):
        uid = self.require_user(query)
        if not uid:
            return
        period = (query.get("period") or ["month"])[0]
        type_ = (query.get("type") or ["count"])[0]
        items = services.rankings(CONN, period, type_)[:10]
        public = [{"rank": i["rank"], "name": i["name"], "count": i["count"], "minutes": i["minutes"]} for i in items]
        return self.send_json(200, {"items": public})

    def api_link_nonce(self, query):
        """アカウント連携（方式B）用 nonce の発行。"""
        uid = self.require_user(query)
        if not uid:
            return
        member = services.get_member(CONN, uid)
        if not member:
            return self.send_json(403, {"error": "unregistered"})
        nonce = secrets.token_urlsafe(32)
        CONN.execute(
            "INSERT INTO link_nonces(nonce, member_id, created_at) VALUES(?, ?, ?)",
            (nonce, member["member_id"], db.now_iso()),
        )
        CONN.commit()
        link_token = line_api.issue_link_token(uid)
        url = None
        if link_token:
            url = f"https://access.line.me/dialog/bot/accountLink?linkToken={link_token}&nonce={nonce}"
        return self.send_json(200, {"nonce": nonce, "accountLinkUrl": url})

    # -- 管理者API --
    def require_admin(self, query):
        uid = resolve_line_user_id(self, query)
        if not config.is_admin(uid):
            self.send_json(403, {"error": "forbidden", "message": "管理者権限が必要です。"})
            return None
        return uid

    def api_admin_get(self, path, query):
        admin_uid = self.require_admin(query)
        if not admin_uid:
            return
        if path == "/api/admin/dashboard":
            today = db.now().date().isoformat()
            entries = CONN.execute(
                "SELECT COUNT(*) c FROM access_logs WHERE type='entry' AND result='success' AND created_at >= ?",
                (today,),
            ).fetchone()["c"]
            unique = CONN.execute(
                "SELECT COUNT(DISTINCT member_id) c FROM access_logs WHERE type='entry' AND result='success' AND created_at >= ?",
                (today,),
            ).fetchone()["c"]
            inside = CONN.execute(
                "SELECT s.member_id, m.name, s.entry_at FROM stays s JOIN members m ON m.member_id = s.member_id"
                " WHERE s.exit_method = 'open' ORDER BY s.entry_at"
            ).fetchall()
            failures = CONN.execute(
                "SELECT created_at, line_user_id, result FROM access_logs"
                " WHERE type='entry' AND result NOT IN ('success') ORDER BY created_at DESC LIMIT 10"
            ).fetchall()
            return self.send_json(200, {
                "todayEntries": entries,
                "todayUniqueUsers": unique,
                "currentlyInside": [dict(r) for r in inside],
                "recentFailures": [dict(r) for r in failures],
            })
        if path == "/api/admin/members":
            q = (query.get("q") or [""])[0]
            rows = CONN.execute(
                "SELECT * FROM members WHERE name LIKE ? OR member_id LIKE ? ORDER BY registered_at",
                (f"%{q}%", f"%{q}%"),
            ).fetchall()
            return self.send_json(200, {"items": [member_json(r) for r in rows]})
        m = re.match(r"^/api/admin/members/([\w-]+)$", path)
        if m:
            row = CONN.execute("SELECT * FROM members WHERE member_id = ?", (m.group(1),)).fetchone()
            if not row:
                return self.send_json(404, {"error": "not_found"})
            history = services.history_rows(CONN, member_id=m.group(1))[:50]
            return self.send_json(200, {"member": member_json(row), "history": [dict(r) for r in history]})
        if path == "/api/admin/history":
            rows = services.history_rows(
                CONN,
                date_from=(query.get("from") or [None])[0],
                date_to=(query.get("to") or [None])[0],
                member_id=(query.get("member_id") or [None])[0],
                result=(query.get("result") or [None])[0],
            )
            return self.send_json(200, {"items": [dict(r) for r in rows[:500]]})
        if path == "/api/admin/history.csv":
            date_from = (query.get("from") or [None])[0]
            date_to = (query.get("to") or [None])[0]
            text = services.history_csv(
                CONN,
                date_from=date_from,
                date_to=date_to,
                member_id=(query.get("member_id") or [None])[0],
                result=(query.get("result") or [None])[0],
            )
            services.record_export(CONN, admin_uid, "history", f"from={date_from},to={date_to}")
            fname = f"abel_usage_{date_from or 'all'}_{date_to or 'all'}.csv"
            return self.send_text(200, text, "text/csv; charset=utf-8", fname)
        if path == "/api/admin/rankings":
            items = services.rankings(
                CONN,
                (query.get("period") or ["month"])[0],
                (query.get("type") or ["count"])[0],
            )
            return self.send_json(200, {"items": items})
        if path == "/api/admin/rankings.csv":
            period = (query.get("period") or ["month"])[0]
            type_ = (query.get("type") or ["count"])[0]
            text = services.ranking_csv(CONN, period, type_)
            services.record_export(CONN, admin_uid, "ranking", f"period={period},type={type_}")
            return self.send_text(200, text, "text/csv; charset=utf-8", f"abel_ranking_{period}_{type_}.csv")
        if path == "/api/admin/settings":
            return self.send_json(200, {
                "unlock_cooldown_sec": services.cooldown_seconds(CONN),
                "auto_exit_hours": services.auto_exit_hours(CONN),
            })
        return self.send_json(404, {"error": "not_found"})

    def api_admin_post(self, path, query):
        admin_uid = self.require_admin(query)
        if not admin_uid:
            return
        body = self.read_json()
        if path == "/api/admin/run-auto-exit":
            closed = services.run_auto_exit(CONN)
            return self.send_json(200, {"closed": closed})
        if path == "/api/admin/unlock":
            mode, ok = switchbot_api.unlock()
            services._log(CONN, None, admin_uid, "unlock_staff", "success" if ok else "error", "admin")
            if not ok:
                return self.send_json(502, {"error": "unlock_failed"})
            return self.send_json(200, {"ok": True, "unlock_mode": mode})
        if path == "/api/admin/settings":
            if "unlock_cooldown_sec" in body:
                db.set_setting(CONN, "unlock_cooldown_sec", int(body["unlock_cooldown_sec"]))
            if "auto_exit_hours" in body:
                db.set_setting(CONN, "auto_exit_hours", int(body["auto_exit_hours"]))
            return self.send_json(200, {"ok": True})
        m = re.match(r"^/api/admin/members/([\w-]+)/status$", path)
        if m:
            status = body.get("status")
            if status not in ("active", "suspended", "withdrawn"):
                return self.send_json(400, {"error": "bad_status"})
            CONN.execute(
                "UPDATE members SET status = ?, updated_at = ? WHERE member_id = ?",
                (status, db.now_iso(), m.group(1)),
            )
            CONN.commit()
            return self.send_json(200, {"ok": True})
        m = re.match(r"^/api/admin/members/([\w-]+)/relink$", path)
        if m:
            new_uid = (body.get("new_line_user_id") or "").strip()
            if not new_uid:
                return self.send_json(400, {"error": "new_line_user_id_required"})
            CONN.execute(
                "UPDATE members SET line_user_id = ?, linked_at = ?, updated_at = ? WHERE member_id = ?",
                (new_uid, db.now_iso(), db.now_iso(), m.group(1)),
            )
            CONN.commit()
            return self.send_json(200, {"ok": True})
        return self.send_json(404, {"error": "not_found"})

    # -- LINE Webhook --
    def webhook_line(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        if not line_api.verify_webhook_signature(raw, self.headers.get("X-Line-Signature")):
            return self.send_json(401, {"error": "bad_signature"})
        payload = json.loads(raw.decode("utf-8"))
        for event in payload.get("events", []):
            self.handle_line_event(event)
        return self.send_json(200, {"ok": True})

    def handle_line_event(self, event):
        etype = event.get("type")
        source = event.get("source", {})
        line_user_id = source.get("userId")
        reply_token = event.get("replyToken")
        if etype == "postback" and line_user_id:
            action = (event.get("postback", {}).get("data") or "")
            params = dict(p.split("=", 1) for p in action.split("&") if "=" in p)
            act = params.get("action")
            if act == "entry":
                status, payload = services.do_entry(CONN, line_user_id, "postback")
                text = "解錠しました。入室を記録しました。" if status == 200 else payload.get("message", "入室できませんでした。")
                if reply_token:
                    line_api.reply_message(reply_token, text)
            elif act == "exit":
                status, payload = services.do_exit(CONN, line_user_id)
                text = (
                    f"退室を記録しました（滞在 {payload.get('stay_minutes')} 分）。"
                    if status == 200 else payload.get("message", "退室を記録できませんでした。")
                )
                if reply_token:
                    line_api.reply_message(reply_token, text)
        elif etype == "accountLink" and line_user_id:
            nonce = event.get("link", {}).get("nonce")
            row = CONN.execute(
                "SELECT * FROM link_nonces WHERE nonce = ? AND used_at IS NULL", (nonce,)
            ).fetchone()
            if row:
                CONN.execute(
                    "UPDATE members SET line_user_id = ?, linked_at = ?, updated_at = ? WHERE member_id = ?",
                    (line_user_id, db.now_iso(), db.now_iso(), row["member_id"]),
                )
                CONN.execute(
                    "UPDATE link_nonces SET used_at = ? WHERE nonce = ?", (db.now_iso(), nonce)
                )
                CONN.commit()
                if reply_token:
                    line_api.reply_message(reply_token, "LINEアカウントとの連携が完了しました。")


def auto_exit_loop():
    interval = config.get_int("AUTO_EXIT_INTERVAL_SEC", 600)
    while True:
        time.sleep(interval)
        try:
            closed = services.run_auto_exit(CONN)
            if closed:
                print(f"[auto-exit] {closed} 件を自動退室扱いにしました")
        except Exception as exc:
            print(f"[auto-exit error] {exc}")


def main():
    threading.Thread(target=auto_exit_loop, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", config.PORT), Handler)
    mode = "DEMO" if config.DEMO_MODE else "PRODUCTION"
    sb = "real" if switchbot_api.configured() else "mock"
    print(f"アーベル入退室システム起動: http://localhost:{config.PORT} (mode={mode}, switchbot={sb})")
    server.serve_forever()


if __name__ == "__main__":
    main()
