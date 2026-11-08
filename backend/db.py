"""SQLite のスキーマと接続。仕様書 §7 に対応する。"""
import sqlite3
import threading
from datetime import datetime, timedelta, timezone

from . import config

JST = timezone(timedelta(hours=9))
# RLock（再入可能）必須: 設定保存のように「ロック保持中に接続を遅延生成し、
# その初期化(init_db)で同じロックを取る」経路があるため、通常の Lock だと
# 同一スレッドでデッドロックする。
_lock = threading.RLock()


def now():
    return datetime.now(JST)


def now_iso():
    return now().isoformat(timespec="seconds")


def parse_iso(value):
    if not value:
        return None
    return datetime.fromisoformat(value)


def connect():
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    # 同時アクセス対策: WALモード＋busy_timeoutで「database is locked」を避ける
    conn = sqlite3.connect(config.DB_PATH, check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS members (
    member_id     TEXT PRIMARY KEY,
    line_user_id  TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active',  -- active / suspended / withdrawn
    registered_at TEXT NOT NULL,
    linked_at     TEXT,
    updated_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS access_logs (
    log_id       TEXT PRIMARY KEY,
    member_id    TEXT,
    line_user_id TEXT NOT NULL,
    type         TEXT NOT NULL,  -- entry / exit / auto_exit / unlock_staff
    result       TEXT NOT NULL,  -- success / denied_unregistered / denied_suspended / error / cooldown
    method       TEXT,           -- qr / nfc / richmenu / liff / postback / admin
    created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stays (
    stay_id      TEXT PRIMARY KEY,
    member_id    TEXT NOT NULL,
    entry_at     TEXT NOT NULL,
    exit_at      TEXT,
    exit_method  TEXT NOT NULL DEFAULT 'open',  -- open / actual / auto / forced
    stay_minutes INTEGER
);
CREATE TABLE IF NOT EXISTS link_nonces (
    nonce      TEXT PRIMARY KEY,
    member_id  TEXT NOT NULL,
    created_at TEXT NOT NULL,
    used_at    TEXT
);
CREATE TABLE IF NOT EXISTS export_logs (
    export_id          TEXT PRIMARY KEY,
    admin_line_user_id TEXT NOT NULL,
    kind               TEXT NOT NULL,  -- history / ranking
    condition          TEXT,
    exported_at        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def init_db(conn):
    with _lock:
        conn.executescript(SCHEMA)
        conn.commit()


def get_setting(conn, key, default):
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(conn, key, value):
    with _lock:
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value)),
        )
        conn.commit()


def delete_setting(conn, key):
    with _lock:
        conn.execute("DELETE FROM settings WHERE key = ?", (key,))
        conn.commit()
