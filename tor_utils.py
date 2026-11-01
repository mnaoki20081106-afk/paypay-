import os
import threading
from contextlib import contextmanager

TOR_SOCKS_PROXY = os.environ.get("TOR_SOCKS_PROXY", "socks5h://127.0.0.1:9050")
TOR_CONTROL_HOST = os.environ.get("TOR_CONTROL_HOST", "127.0.0.1")
TOR_CONTROL_PORT = int(os.environ.get("TOR_CONTROL_PORT", 9051))
TOR_CONTROL_PASSWORD = os.environ.get("TOR_CONTROL_PASSWORD", "")

# 同時ログインが env var を競合しないように serialize する
_tor_lock = threading.Lock()


@contextmanager
def via_tor():
    """HTTP/HTTPS リクエストを Tor SOCKS5 経由にルーティングする。"""
    proxy_keys = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
                  "http_proxy", "https_proxy", "all_proxy")
    with _tor_lock:
        saved = {k: os.environ.get(k) for k in proxy_keys}
        for k in proxy_keys:
            os.environ[k] = TOR_SOCKS_PROXY
        try:
            yield
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


def tor_check() -> dict:
    """Tor 経由で接続できているか確認する。現在の出口 IP を返す。"""
    import requests
    proxies = {
        "http": TOR_SOCKS_PROXY,
        "https": TOR_SOCKS_PROXY,
    }
    try:
        r = requests.get(
            "https://check.torproject.org/api/ip",
            proxies=proxies,
            timeout=15,
        )
        r.raise_for_status()
        data = r.json()
        return {
            "ok": data.get("IsTor", False),
            "ip": data.get("IP"),
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def renew_tor_circuit() -> dict:
    """Tor コントロールポートに NEWNYM シグナルを送り、出口 IP を変える。"""
    try:
        from stem import Signal
        from stem.control import Controller
        with Controller.from_port(
            address=TOR_CONTROL_HOST,
            port=TOR_CONTROL_PORT,
        ) as ctrl:
            ctrl.authenticate(password=TOR_CONTROL_PASSWORD)
            ctrl.signal(Signal.NEWNYM)
        return {"ok": True}
    except ImportError:
        return {"ok": False, "error": "stem がインストールされていません。pip install stem を実行してください。"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
