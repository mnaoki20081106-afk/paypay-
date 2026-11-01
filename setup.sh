#!/bin/bash
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "[1/6] パッケージをインストール中..."
apt update -qq
apt install -y tor python3 python3-pip nginx

echo "[2/6] Tor を設定中..."
grep -qxF 'ControlPort 9051'       /etc/tor/torrc || echo 'ControlPort 9051'       >> /etc/tor/torrc
grep -qxF 'CookieAuthentication 1' /etc/tor/torrc || echo 'CookieAuthentication 1' >> /etc/tor/torrc

systemctl enable tor
systemctl restart tor

echo "[3/6] Python パッケージをインストール中..."
pip3 install -q -r "$REPO_DIR/requirements.txt"

echo "[4/6] systemd サービスを登録中..."
SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
cat > /etc/systemd/system/paypay.service <<EOF
[Unit]
Description=PayPay Flask App
After=network.target tor.service

[Service]
WorkingDirectory=$REPO_DIR
ExecStart=/usr/bin/python3 app.py
Restart=always
RestartSec=5
Environment=PORT=5000
Environment=SECRET_KEY=$SECRET_KEY

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable paypay
systemctl restart paypay

echo "[5/6] nginx を設定中..."
cat > /etc/nginx/sites-available/paypay <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;

    client_max_body_size 4m;

    location / {
        proxy_pass         http://127.0.0.1:5000;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_read_timeout 60s;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/paypay /etc/nginx/sites-enabled/paypay
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl restart nginx

echo ""
echo "[6/6] 完了"
VPS_IP=$(curl -s https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
echo "  URL:        http://$VPS_IP/"
echo "  管理画面:   http://$VPS_IP/admin"
echo ""
echo "  Flask:  systemctl status paypay"
echo "  ログ:   journalctl -u paypay -f"
echo "  nginx:  systemctl status nginx"
echo "  Tor:    systemctl status tor"
