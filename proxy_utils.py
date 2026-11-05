import os
import requests

# Japanese SOCKS5 proxies (public list, may change)
JP_SOCKS5_PROXIES = [
    "socks5://103.100.158.115:10809",
    "socks5://101.36.104.46:10808",
    "socks5://103.75.118.84:1080",
    "socks5://139.162.78.109:1080",
    "socks5://8.216.40.169:7890",
]

def get_working_jp_proxy():
    """Test proxies and return the first working one."""
    for proxy in JP_SOCKS5_PROXIES:
        try:
            r = requests.get(
                "https://api.ipify.org?format=json",
                proxies={"http": proxy, "https": proxy},
                timeout=10,
            )
            if r.status_code == 200:
                return proxy
        except Exception:
            continue
    return None

# Default to first proxy; override with env var if needed
JP_SOCKS_PROXY = os.environ.get("JP_SOCKS_PROXY") or get_working_jp_proxy() or JP_SOCKS5_PROXIES[0]
