"""SwitchBot API v1.1 連携。仕様書 §8-2 に対応する。

- 認証情報（トークン／シークレット）はサーバー側にのみ置く。
- ロックは BLE 機器のため、ハブでクラウドサービスが有効なことが前提。
- 未設定の場合はモック解錠（ログ出力のみ）で動作し、開発・検証ができる。
"""
import base64
import hashlib
import hmac
import json
import time
import urllib.request
import uuid

from . import config

COMMAND_URL = "https://api.switch-bot.com/v1.1/devices/{device_id}/commands"


def configured():
    return bool(
        config.SWITCHBOT_TOKEN
        and config.SWITCHBOT_SECRET
        and config.SWITCHBOT_LOCK_DEVICE_ID
    )


def _send_command(command):
    token = config.SWITCHBOT_TOKEN
    secret = config.SWITCHBOT_SECRET
    t = str(int(round(time.time() * 1000)))
    nonce = str(uuid.uuid4())
    sign = base64.b64encode(
        hmac.new(
            secret.encode(),
            f"{token}{t}{nonce}".encode(),
            digestmod=hashlib.sha256,
        ).digest()
    ).decode()
    body = json.dumps(
        {"command": command, "parameter": "default", "commandType": "command"}
    ).encode()
    req = urllib.request.Request(
        COMMAND_URL.format(device_id=config.SWITCHBOT_LOCK_DEVICE_ID),
        data=body,
        method="POST",
        headers={
            "Authorization": token,
            "sign": sign,
            "t": t,
            "nonce": nonce,
            "Content-Type": "application/json; charset=utf8",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as res:
        return json.loads(res.read().decode())


def unlock():
    """解錠する。戻り値: (mode, ok) 。mode は 'real' か 'mock'。"""
    if not configured():
        print("[SwitchBot MOCK] unlock (認証情報未設定のためモック動作)")
        return "mock", True
    try:
        payload = _send_command("unlock")
        ok = payload.get("statusCode") == 100
        if not ok:
            print(f"[SwitchBot unlock failed] {payload}")
        return "real", ok
    except Exception as exc:
        print(f"[SwitchBot unlock error] {exc}")
        return "real", False
