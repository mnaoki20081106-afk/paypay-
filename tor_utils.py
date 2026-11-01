import os
import threading
from contextlib import contextmanager

TOR_SOCKS_PROXY = os.environ.get("TOR_SOCKS_PROXY", "socks5h://127.0.0.1:9050")
TOR_CONTROL_HOST = os.environ.get("TOR_CONTROL_HOST", "127.0.0.1")
TOR_CONTROL_PORT = int(os.environ.get("TOR_CONTROL_PORT", 9051))
TOR_CONTROL_PASSWORD = os.environ.get("TOR_CONTROL_PASSWORD", "")

_tor_lock = threading.Lock()
_tor_enabled: bool = True


def set_tor_enabled(v: bool) -> None:
    global _tor_enabled
    _tor_enabled = bool(v)


def get_tor_enabled() -> bool:
    return _tor_enabled


@contextmanager
def via_tor():
    if not _tor_enabled:
        yield
        return
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


def get_exit_ip() -> dict:
    import requests
    proxies = {"http": TOR_SOCKS_PROXY, "https": TOR_SOCKS_PROXY}
    try:
        r = requests.get(
            "https://check.torproject.org/api/ip",
            proxies=proxies,
            timeout=15,
        )
        r.raise_for_status()
        data = r.json()
        return {"ok": data.get("IsTor", False), "ip": data.get("IP")}
    except Exception as exc:
        return {"ok": False, "ip": None, "error": str(exc)}


def renew_tor_circuit() -> dict:
    try:
        from stem import Signal
        from stem.control import Controller
        with Controller.from_port(address=TOR_CONTROL_HOST, port=TOR_CONTROL_PORT) as ctrl:
            ctrl.authenticate(password=TOR_CONTROL_PASSWORD)
            ctrl.signal(Signal.NEWNYM)
        return {"ok": True}
    except ImportError:
        return {"ok": False, "error": "stem がインストールされていません"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
