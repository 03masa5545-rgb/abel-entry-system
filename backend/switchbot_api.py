"""SwitchBot API v1.1 連携。仕様書 §8-2 に対応する。

- 認証情報（トークン／シークレット）はサーバー側にのみ置く。
  管理者画面から保存された値は DB の settings に入り、環境変数より優先される。
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

BASE_URL = "https://api.switch-bot.com/v1.1"


def env_creds():
    return config.SWITCHBOT_TOKEN, config.SWITCHBOT_SECRET, config.SWITCHBOT_LOCK_DEVICE_ID


def _headers(token, secret):
    t = str(int(round(time.time() * 1000)))
    nonce = str(uuid.uuid4())
    sign = base64.b64encode(
        hmac.new(
            secret.encode(),
            f"{token}{t}{nonce}".encode(),
            digestmod=hashlib.sha256,
        ).digest()
    ).decode()
    return {
        "Authorization": token,
        "sign": sign,
        "t": t,
        "nonce": nonce,
        "Content-Type": "application/json; charset=utf8",
    }


def _request(method, path, token, secret, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE_URL + path, data=data, method=method, headers=_headers(token, secret)
    )
    with urllib.request.urlopen(req, timeout=15) as res:
        return json.loads(res.read().decode())


def unlock(token=None, secret=None, device_id=None):
    """解錠する。戻り値: (mode, ok)。mode は 'real' か 'mock'。

    引数なしの場合は環境変数の認証情報を使う。3点が揃わない場合はモック。
    """
    env_token, env_secret, env_device = env_creds()
    token = token or env_token
    secret = secret or env_secret
    device_id = device_id or env_device
    if not (token and secret and device_id):
        print("[SwitchBot MOCK] unlock (認証情報未設定のためモック動作)", flush=True)
        return "mock", True
    try:
        payload = _request(
            "POST",
            f"/devices/{device_id}/commands",
            token,
            secret,
            {"command": "unlock", "parameter": "default", "commandType": "command"},
        )
        ok = payload.get("statusCode") == 100
        if not ok:
            print(f"[SwitchBot unlock failed] {payload}")
        return "real", ok
    except Exception as exc:
        print(f"[SwitchBot unlock error] {exc}")
        return "real", False


def list_devices(token, secret):
    """接続テスト用: 登録デバイス一覧を取得する。(ok, devices or error_message)"""
    if not (token and secret):
        return False, "トークン／シークレットが未設定です"
    try:
        payload = _request("GET", "/devices", token, secret)
        if payload.get("statusCode") != 100:
            return False, f"SwitchBot API エラー: {payload.get('message', payload)}"
        devices = (payload.get("body") or {}).get("deviceList", [])
        return True, [
            {
                "deviceId": d.get("deviceId"),
                "deviceName": d.get("deviceName"),
                "deviceType": d.get("deviceType"),
                "hubDeviceId": d.get("hubDeviceId"),
            }
            for d in devices
        ]
    except Exception as exc:
        return False, f"接続に失敗しました: {exc}"
