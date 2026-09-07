# ANANDA Website + M-PESA STK Push

This package converts the web content found inside the ANANDA APK into a normal website and adds a secure server-side M-PESA STK Push flow.

## What is included
- Existing ANANDA website design/content extracted from the APK
- Local images from the APK
- Firebase product/category loading already present in the app
- M-PESA STK Push backend using Safaricom Daraja
- M-PESA callback endpoint
- Automatic payment-status polling in the checkout page
- Local order record in `data/orders.json` for testing

## Important
Never put the Daraja consumer secret or STK passkey in browser JavaScript. They belong only in the server environment variables.

The backend currently accepts the checkout amount from the browser. Before a high-volume production launch, move the authoritative product catalogue/prices to the server (or securely read them with Firebase Admin SDK) so customers cannot manipulate the amount.

## Run locally
1. Install Node.js 20+.
2. Open this folder in a terminal.
3. Run `npm install`.
4. Copy `.env.example` to `.env`.
5. Create a Safaricom Daraja app and put the sandbox credentials in `.env`.
6. Set `MPESA_CALLBACK_URL` to a public HTTPS address that forwards to this app. A local tunnel such as ngrok can be used for testing.
7. Run `npm start`.
8. Open `http://localhost:3000`.

## Go live in Kenya
1. Create/complete your Daraja account and application.
2. Test STK Push in sandbox.
3. Complete Safaricom's production/go-live process and obtain production credentials.
4. Deploy this Node app to a host that supports Node.js and HTTPS (for example Render, Railway, or a VPS).
5. Set the production environment variables on the host. Do not upload `.env` to GitHub.
6. Set `MPESA_ENV=production`.
7. Set `MPESA_CALLBACK_URL` to your real HTTPS domain.
8. In your domain DNS, point your domain to the host.
9. Test a small real payment and confirm the callback changes the order to `paid`.

## Domain
Example: `ananda.co.ke` or another domain you own. The domain itself is not included; it must be registered separately.

## Daraja
Official Safaricom developer portal: https://developer.safaricom.co.ke/
