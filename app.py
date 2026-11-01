import os
import secrets
import json
from flask import Flask, request, jsonify, send_from_directory, session

app = Flask(__name__, static_folder="docs")
app.secret_key = os.environ.get("SECRET_KEY", secrets.token_hex(32))

_paypay_sessions: dict = {}


def _get_paypay_instance(token: str):
    return _paypay_sessions.get(token)


@app.route("/")
def index():
    return send_from_directory("docs", "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory("docs", filename)


@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json(force=True)
    phone = (data.get("phone") or "").strip()
    password = (data.get("password") or "").strip()

    if not phone or not password:
        return jsonify({"error": "phone と password は必須です"}), 400

    try:
        from PayPaython_mobile import PayPay, PayPayLoginError
    except ImportError:
        return jsonify({"error": "PayPaython-mobile がインストールされていません。pip install PayPaython-mobile を実行してください。"}), 500

    try:
        paypay = PayPay(phone, password)
        paypay.login()
    except Exception as exc:
        return jsonify({"error": str(exc)}), 401

    token = secrets.token_urlsafe(32)
    _paypay_sessions[token] = paypay
    session["paypay_token"] = token

    return jsonify({"status": "sms_required"})


@app.route("/api/sms_confirm", methods=["POST"])
def api_sms_confirm():
    token = session.get("paypay_token")
    if not token:
        return jsonify({"error": "セッションが見つかりません。再度ログインしてください。"}), 401

    paypay = _get_paypay_instance(token)
    if paypay is None:
        return jsonify({"error": "セッションの有効期限が切れました。再度ログインしてください。"}), 401

    data = request.get_json(force=True)
    code = (data.get("code") or "").strip()
    if not code:
        return jsonify({"error": "認証コードを入力してください"}), 400

    try:
        paypay.login_confirm(code)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 401

    result = {
        "access_token": getattr(paypay, "access_token", None),
        "refresh_token": getattr(paypay, "refresh_token", None),
        "device_uuid": getattr(paypay, "device_uuid", None),
    }
    _paypay_sessions.pop(token, None)
    session.pop("paypay_token", None)

    return jsonify({"status": "ok", **result})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
