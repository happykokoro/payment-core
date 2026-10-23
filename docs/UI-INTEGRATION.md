# Optional Crypto Payment UI integration

Crypto Payment Core runs independently on its own `main` branch. Crypto Payment UI is a separate Git repository, not a branch of the core. Production UI code imports no core source and has no database connection.

## Local pair

| Setting | crypto-payment-core | crypto-payment-ui |
| --- | --- | --- |
| Listener | `PORT=4004` | `UI_PORT=4006` |
| Browser address | none | `UI_PUBLIC_URL=http://127.0.0.1:4006` |
| Core connection | — | `CORE_URL=http://127.0.0.1:4004` |
| Merchant secret | `API_KEY` | same value in server-only `CORE_API_KEY` |
| Checkout location | `CHECKOUT_URL=http://127.0.0.1:4006/checkout/` | serves `/checkout/` |
| Operator authentication | merchant API bearer | separate password + encrypted HttpOnly session |

Both repositories run `npm ci`, `npm run build`, then `npm start` with their own `.env`. The core also needs PostgreSQL, its route and address pool, and webhook configuration. Browser requests stay on the UI origin; its server proxies explicit JSON routes. No wildcard CORS or merchant key in browser code is needed.

For API-only deployment, leave `CHECKOUT_URL` empty. Create/get responses return `checkoutUrl: null` and `checkoutToken`. Your own frontend can use this token for only that invoice's checkout read endpoints. Keep all merchant API calls on your backend.

## Contract v1

- Create/get merchant invoice: existing fields plus `checkoutToken` and nullable `checkoutUrl`.
- List: `GET /v1/invoices?limit=25&offset=0&status=paid&externalOrderId=order-123`. Status and exact order ID are optional; both filters apply when supplied.
- List response: `{ invoices, limit, offset, hasMore }`. Entries omit checkout credentials and voucher secrets. Sort is `created_at DESC, id DESC`. Limit is 1–100; offset is 0–100000. Offset pages are a live view and can shift when records arrive; this is not a snapshot export.
- Customer reads: `GET /v1/checkout/:id` and `GET /v1/checkout/:id/transactions/:hash`, with the scoped checkout token.
- Dashboard reads: invoice, receipt, transfers, refunds, audit, events and operations health. Dashboard does not expose write routes.
- The core alone controls settlement, evidence, vouchers, refunds and outbox delivery. UI state cannot confirm a payment.

## Upgrade from the combined local prototype

Replace `PUBLIC_URL` with `CHECKOUT_URL` pointing to the separate UI's full checkout path. The core no longer hosts `/checkout/`. Existing links to the old core origin need to be replaced with links from the updated invoice endpoint (or handled by your deployment's reverse proxy); the token itself is unchanged. Do not change credential secrets for this move.

Migration 003 adds invoice listing indexes only. No payment rows or credential identities change. Deploy core support for the list endpoint before this dashboard. Browser acceptance moved to crypto-payment-ui; both projects otherwise build and test independently.
