"""環境変数の読み込み。標準ライブラリのみで動作する。"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


_load_dotenv()


def get(name, default=""):
    return os.environ.get(name, default)


def get_int(name, default):
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


DEMO_MODE = get("DEMO_MODE", "1") == "1"
PORT = get_int("PORT", 8000)
LIFF_ID = get("LIFF_ID")
LINE_CHANNEL_ID = get("LINE_CHANNEL_ID")
LINE_CHANNEL_SECRET = get("LINE_CHANNEL_SECRET")
LINE_CHANNEL_ACCESS_TOKEN = get("LINE_CHANNEL_ACCESS_TOKEN")
SWITCHBOT_TOKEN = get("SWITCHBOT_TOKEN")
SWITCHBOT_SECRET = get("SWITCHBOT_SECRET")
SWITCHBOT_LOCK_DEVICE_ID = get("SWITCHBOT_LOCK_DEVICE_ID")
ADMIN_LINE_USER_IDS = [s.strip() for s in get("ADMIN_LINE_USER_IDS").split(",") if s.strip()]
DB_PATH = ROOT / "data" / "abel_entry.db"


def is_admin(line_user_id):
    if not line_user_id:
        return False
    if DEMO_MODE and line_user_id == "demo-admin":
        return True
    return line_user_id in ADMIN_LINE_USER_IDS
