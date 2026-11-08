"""LINE プラットフォーム連携。仕様書 §4 / §8-1 に対応する。

- IDトークンの検証は必ずサーバー側で行い、クライアントから送られた
  プロフィール情報は信用しない。
- 応答メッセージ（Reply API）はメッセージ通数の課金対象外。
"""
import hashlib
import hmac
import json
import urllib.parse
import urllib.request

from . import config

VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify"
REPLY_URL = "https://api.line.me/v2/bot/message/reply"
LINK_TOKEN_URL = "https://api.line.me/v2/bot/user/{user_id}/linkToken"


def verify_id_token(id_token):
    """IDトークンを検証して LINEユーザーID(sub) を返す。失敗時は None。"""
    if not id_token or not config.LINE_CHANNEL_ID:
        return None
    data = urllib.parse.urlencode(
        {"id_token": id_token, "client_id": config.LINE_CHANNEL_ID}
    ).encode()
    req = urllib.request.Request(VERIFY_URL, data=data, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            payload = json.loads(res.read().decode())
        return payload.get("sub")
    except Exception:
        return None


def reply_message(reply_token, text):
    """応答メッセージを送る（通数課金対象外）。トークン未設定時はログのみ。"""
    if not config.LINE_CHANNEL_ACCESS_TOKEN:
        print(f"[LINE reply skipped: no access token] {text}")
        return False
    body = json.dumps(
        {"replyToken": reply_token, "messages": [{"type": "text", "text": text}]}
    ).encode()
    req = urllib.request.Request(
        REPLY_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config.LINE_CHANNEL_ACCESS_TOKEN}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10):
            return True
    except Exception as exc:
        print(f"[LINE reply failed] {exc}")
        return False


def issue_link_token(line_user_id):
    """アカウント連携（方式B）用のリンクトークンを発行する。"""
    if not config.LINE_CHANNEL_ACCESS_TOKEN:
        return None
    url = LINK_TOKEN_URL.format(user_id=urllib.parse.quote(line_user_id))
    req = urllib.request.Request(
        url,
        method="POST",
        headers={"Authorization": f"Bearer {config.LINE_CHANNEL_ACCESS_TOKEN}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            payload = json.loads(res.read().decode())
        return payload.get("linkToken")
    except Exception:
        return None


def verify_webhook_signature(body_bytes, signature):
    """Webhook の署名検証（チャネルシークレット設定時のみ）。"""
    if not config.LINE_CHANNEL_SECRET:
        return True
    digest = hmac.new(
        config.LINE_CHANNEL_SECRET.encode(), body_bytes, hashlib.sha256
    ).digest()
    import base64

    expected = base64.b64encode(digest).decode()
    return hmac.compare_digest(expected, signature or "")
