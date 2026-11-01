#!/bin/bash
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "[1/5] パッケージをインストール中..."
apt update -qq
apt install -y tor python3 python3-pip

echo "[2/5] Tor を設定中..."
grep -qxF 'ControlPort 9051'      /etc/tor/torrc || echo 'ControlPort 9051'      >> /etc/tor/torrc
grep -qxF 'CookieAuthentication 1' /etc/tor/torrc || echo 'CookieAuthentication 1' >> /etc/tor/torrc

systemctl enable tor
systemctl restart tor

echo "[3/5] Python パッケージをインストール中..."
pip3 install -q -r "$REPO_DIR/requirements.txt"

echo "[4/5] systemd サービスを登録中..."
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
Environment=SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable paypay
systemctl restart paypay

echo ""
echo "[5/5] 完了"
echo "  アプリ状態: systemctl status paypay"
echo "  ログ確認:   journalctl -u paypay -f"
echo "  Tor 状態:   systemctl status tor"
