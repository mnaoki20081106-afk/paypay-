import os
import requests

# Tor SOCKS5 proxy (default)
TOR_SOCKS_PROXY = os.environ.get("TOR_SOCKS_PROXY", "socks5h://127.0.0.1:9050")

# Prefer Japanese exit if possible via Tor control, otherwise use default Tor
# For strict Japanese exit, set ExitNodes {jp} in torrc and restart Tor
JP_SOCKS_PROXY = TOR_SOCKS_PROXY

def get_tor_exit_ip():
    """Check current Tor exit IP."""
    try:
        r = requests.get(
            "https://check.torproject.org/api/ip",
            proxies={"http": TOR_SOCKS_PROXY, "https": TOR_SOCKS_PROXY},
            timeout=15,
        )
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return None
