# Payment Core

A small, single-merchant service for USDC payment requests, verified payment records, signed webhooks and optional single-use vouchers. It is a standalone implementation of the narrow payment-to-voucher workflow identified in Kokoro Pay. No original deployment configuration or Git history is included.

**Implemented route:** native USDC on Base; Base Sepolia is the default test environment. BTC, USDT, Solana and Tron are outside this first implementation. This uses the single-stablecoin fallback agreed during scope review.

## What runs

- TypeScript/Fastify API and three independent background workers in one process.
- PostgreSQL for payments, address reservations, transfer evidence, vouchers and the delivery outbox.
- `viem` for read-only chain queries and ERC-20 decoding; only finalized blocks can produce a receipt.
- JSON APIs, including an invoice-scoped read API for any customer checkout. The backend detects payment even if a browser closes.

This repository is API-only. The optional **payment-ui** repository owns the React/Wagmi customer checkout and a read-only merchant dashboard. They have independent dependencies, builds and servers; no UI source or static server is included here. See [the HTTP boundary](docs/UI-INTEGRATION.md).

No custom blockchain, token, wallet, signing service or on-chain voucher contract is needed. Fastify replaces the original broad NestJS application shell; the payment domain is independent of either HTTP framework. Redis, subscriptions, plans, organizations, Stripe, treasury, branding and private infrastructure are not carried over.

## Quick start

Requires Node.js 22.14+ and PostgreSQL 16+. Commands run from the repository root.

1. Run `npm ci`.
2. Copy `.env.example` to `.env`, then run `npm run keys` and put its three different values in `.env`. Back up the credential keyring with the database; use the documented rotation workflow when replacing `TOKEN_SECRET`.
3. Set `DATABASE_URL`. For an isolated local database, run `docker compose up -d postgres`.
4. Set `RECEIVE_ADDRESSES` to fresh public addresses controlled by your wallet, separated by commas. Keep the private keys in that wallet. **Do not use random sample addresses for real payments.**
5. Set `RPC_URL` for the selected Base network. The endpoint must support finalized block queries, historical logs and receipts. Start with Base Sepolia and its test USDC.
6. Set `WEBHOOK_URL` to your merchant application's endpoint. For a durable example, configure a separate `MERCHANT_DATABASE_URL` and run `npm run example:merchant` in another terminal. `example:webhook` is only a logging diagnostic.
7. Run `npm run build`, then `npm start`. The service validates the chain and token decimals, applies the transactional migration and starts polling.
8. Create an invoice through the merchant API. For the optional UI, start payment-ui separately and set `CHECKOUT_URL` to its checkout page (locally `http://127.0.0.1:4006/checkout/`). The response then includes a `checkoutUrl`; without this setting it is `null` and the scoped `checkoutToken` remains available for your own integration.

`npm run dev` runs only the API and workers directly from TypeScript. `npm run probe` checks RPC identity, USDC decimals and finalized head without signing or sending a transaction.

Mainnet requires both `PAYMENT_NETWORK=base` and `ALLOW_MAINNET=true`, plus a matching RPC. Use a separate database and receiving-address pool for each environment. A database refuses a different route or an unauthorized credential-key change on startup; planned rotation retains the prior key in `TOKEN_SECRET_PREVIOUS`. Token contracts are explicitly allowlisted in `config/routes.json` using [Circle's published addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses).

## Merchant API

Private routes require `Authorization: Bearer <API_KEY>`. Create, redeem and audited merchant commands require an `Idempotency-Key` of 8–128 letters, digits, periods, underscores, colons or hyphens. Never send the merchant key to the checkout browser.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/invoices` | Create or replay a payment request |
| GET | `/v1/invoices?limit=25&offset=0` | Newest-first listing; optional `status` and exact `externalOrderId` filters; `hasMore` pagination |
| GET | `/v1/invoices/:id` | Merchant view, including checkout link |
| GET | `/v1/invoices/:id/receipt` | Confirmed payment evidence and optional voucher code |
| GET | `/v1/invoices/:id/transfers?limit=25&offset=0` | Recorded transfers and review reasons |
| POST | `/v1/vouchers/redeem` | Atomically redeem a voucher |
| GET | `/v1/events?limit=25&offset=0` | Delivery status; maximum page size 100 |
| POST | `/v1/events/:id/retry` | Requeue a dead-letter webhook without changing its event ID |
| GET | `/v1/checkout/:id` | Limited read-only view using its checkout bearer credential |
| GET | `/health` | Public readiness status; authenticated details at `/v1/operations/health` |
| POST | `/v1/invoices/:id/cancel` | Cancel automatic acceptance while retaining transfer monitoring |
| POST | `/v1/invoices/:id/reviews` | Record an audited transfer resolution |
| POST | `/v1/invoices/:id/refunds` | Prepare an external-wallet refund and reserve its amount |
| POST | `/v1/refunds/:id/record` | Verify and record a finalized refund transfer |
| POST | `/v1/refunds/:id/cancel` | Cancel an unsent prepared refund |

See the [operating guide](docs/OPERATIONS.md) for request fields, refund policy, credential lifecycle and audit endpoints.

Create request:

```json
{
  "externalOrderId": "order-123",
  "amountUnits": "2500000",
  "expiresInSeconds": 3600,
  "voucher": {
    "entitlement": { "product": "example-access", "quantity": 1 },
    "validForSeconds": 2592000
  }
}
```

`2500000` means 2.5 USDC (six decimals). The application supplies the crypto amount; no exchange-rate conversion is performed. Omit `voucher` for receipt + webhook only. Reusing an idempotency key with a different body returns 409. Reusing an external order ID with a new key also returns 409.

Redeem request:

```json
{ "code": "<code-from-authenticated-receipt>", "redeemedBy": "customer-123" }
```

The first redemption succeeds. Repeating the same redemption key and customer returns that success; another redemption returns 409. Your application grants the entitlement. A voucher is an off-chain bearer credential, not an NFT or legal invoice. Voucher codes and entitlements are never returned by the public checkout endpoint.

The server-side helper is `src/client.ts` (`dist/client.js` after building).

## Matching and settlement

Each invoice permanently reserves one address from the merchant-supplied pool. Addresses are never recycled, including after expiry. Empty pools reject new invoices with `address_pool_empty`; adding fresh addresses and restarting replenishes the pool. Wallet derivation, backups and subsequent fund consolidation remain the merchant's responsibility. Moving USDC later incurs network fees; the core does not fund gas or sweep balances.

An accepted payment is one successful USDC Transfer event to that invoice's address, for the exact amount, included on-chain during the request's validity period. Fees must not reduce the amount arriving. Confirmation may happen after expiry if the transfer was included on time. Partial transfers are not aggregated. Underpayments, overpayments and late transfers create individual review records/events with no automatic voucher or refund. They do not block a later exact on-time payment. Cancellation prevents automatic acceptance and routes later detected transfers to review. Additional transfers after a paid invoice are recorded and emit a review event without changing its existing receipt.

The scanner records accepted-token transfers for seven days after expiry by default, using **chain time and durable cursors**, so downtime does not skip historical pages. Payments after that window need external reconciliation. Wrong-network or other-token transfers are not credited or monitored by this one-route service.

`SCAN_BLOCK_RANGE` defaults to 200, matching the limit observed on Base's public Sepolia RPC during the live testnet run. Keep an existing deployment's setting at or below its provider's log-query limit; oversized queries fail without advancing the saved checkpoint.

Finality uses the RPC's `finalized` tag, never an arbitrary number of Base sequencer confirmations. This can take several minutes. RPC failures retain the cursor. A changed finalized checkpoint halts verification for operator reconciliation; already redeemed benefits cannot be automatically undone. See [Base's finality model](https://docs.base.org/base-chain/specs/protocol/consensus/derivation).

## Webhooks

Events: `payment.paid`, `payment.review_required`, `payment.reviewed`, `invoice.cancelled`, `voucher.redeemed`, `refund.prepared`, `refund.recorded`, `refund.cancelled`.

The exact JSON body contains `id`, `type`, `createdAt`, `data`. Verify `X-Payment-Signature` as HMAC-SHA256 using `WEBHOOK_SECRET` over `X-Payment-Timestamp + "." + rawBody`, reject timestamps outside five minutes, and deduplicate the body's `id` in your database. `verifyWebhook` in the server client implements signature verification. `X-Payment-Event-Id` repeats the body's ID for convenience.

Return 2xx only after durable handling. Delivery is at least once; duplicates are possible if the receiver accepts a request and the sender loses its acknowledgment. Event ordering is not guaranteed; retrieve the current invoice when reconciling state. A database transaction commits the payment, optional voucher and outgoing event together. Retries preserve the exact event body and ID, use a fresh timestamp/signature, have a 10-second timeout, and stop after eight attempts by default. Redirects are not followed. Inspect `/v1/events` and explicitly requeue failed events when the receiver is fixed. Do not deduplicate on a signature, which changes between attempts.

## Verification and release boundary

Run `npm run check`, `npm test` and `npm run build`. Integration tests create a real, temporary PostgreSQL cluster by default (or an isolated schema using `TEST_DATABASE_URL`). Local EVM adapter tests use Anvil and test-only token bytecode. Browser acceptance lives in payment-ui and starts both servers over HTTP; core checks require no UI checkout or browser dependency. No real funds are required. Test-only private keys must never be used outside the local EVM.

A live Base Sepolia acceptance test passed using 20 free faucet USDC sent directly to an invoice: finalized payment, receipt, signed webhooks, single-use voucher and checkout confirmation. See the [validation record](docs/VALIDATION.md) for the transaction and results. Installed-wallet signing remains untested; it can also run without real money using test USDC and test ETH for gas from [Base's funding sources](https://docs.base.org/get-started/get-funds). No mainnet payment is required for development validation or open-source publication.

Released under the [MIT license](LICENSE). GitLab CI checks types, the full PostgreSQL/EVM/restore suite, the production build, dependency advisories and committed-history secrets. GitHub CI runs the same checks. Publication follows a successful GitLab pipeline for the exact commit; CI does not deploy a service, publish an npm package or migrate production databases. The package stays `private: true` to prevent accidental npm publication. See [contributing](CONTRIBUTING.md) and [security](SECURITY.md).

See [module boundaries](docs/ARCHITECTURE.md), [operating and recovery guide](docs/OPERATIONS.md), [scope and extraction decisions](docs/SCOPE.md) and [validation record](docs/VALIDATION.md).
