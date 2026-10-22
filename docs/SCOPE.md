# v0.1 implementation boundary

## Accepted purpose

Create a request; let a customer pay from an existing wallet or exchange; verify settlement; produce a payment record and webhook; optionally issue and redeem a voucher. The user authorized implementation on 2026-10-22 and allowed one widely used stablecoin if multi-network support distracts from that purpose.

The concrete first route is USDC on Base, with Base Sepolia for development. This reuses the original EVM library (`viem`) and a standard wallet framework (`Wagmi`). It avoids claiming unverified coverage for BTC plus four stablecoin routes. The other routes are excluded from this release, not hidden unfinished adapters.

## Structure

`domain.ts` contains pure admission rules. Focused `services/` modules own invoice creation, settlement, vouchers, exceptions, refunds and credential lifecycle. `ledger.ts` only composes these services. `chain.ts` supplies verified evidence, `monitor.ts` scans finalized blocks, and `observations.ts` supplies advisory progress. `webhooks.ts` delivers events, `health.ts` reports operational state, and `http/` holds thin authenticated route handlers. The optional checkout and dashboard live in the separate payment-ui repository. See [architecture](ARCHITECTURE.md) for dependencies and transaction boundaries.

One merchant per deployment, one route per database, one process, PostgreSQL. No generalized plugin registry or microservice fleet. A small Fastify shell is used instead of transplanting Kokoro Pay's entire NestJS application and its unrelated modules; the independent domain can be embedded behind either framework. Raw parameterized SQL makes row locks and the outbox transaction explicit without copying the large Prisma schema.

No upstream framework is forked. EVM transactions are decoded with viem; wallet connections and requests use Wagmi; QR encoding uses qrcode; database concurrency uses PostgreSQL.

On 2026-10-22 the owner accepted separate API and UI repositories. The bounded UI addition is a read-only dashboard: invoice listing/filtering and detail, transfers/reviews, receipt/voucher state, recorded refunds, audit history, webhook deliveries and health. The core adds only a paginated read endpoint and its indexes. This does not authorize a new merchant platform or changes to payment rules; wallet/QR dependencies belong exclusively to payment-ui.

## Extraction provenance

Behavior was inspected at `kokoro-tech/platform/kokoro-pay`, GitLab main commit `8e1d517ca6b0b8b33c6d32c08f5ca5c865ca5f0f`.

The narrow workflow is independently implemented here rather than copying the existing package wholesale. The original has subscription-bound order/voucher records, amount-based matching gaps and separate confirmation/fulfillment writes. This implementation replaces those with generic entitlements, unique per-request receiving addresses, exact asset/network matching, atomic payment/voucher/outbox persistence and atomic redemption.

Original proprietary license text, credentials, branding, deployment files, production addresses, subscription catalogs and Git history are not copied. New public distribution still requires a license choice; no license rights are asserted for the original repository.

## Invariants and stopping criteria

- One externally identified order and one idempotent create result.
- No payment can be credited using a browser assertion or transaction hash alone.
- Asset, network, recipient, amount, successful execution and finality are checked.
- Transfer identity is network + transaction hash + log index.
- No receiving address is reused, even after expiry.
- A crash cannot leave a paid invoice without its voucher/outbox event.
- One voucher per qualifying invoice; one successful redemption.
- Bounded scans and webhook retries, with durable recovery and explicit failed delivery.
- Merchant keys stay out of browser code; customer keys stay in wallets.
- Wallet connection is optional; manual transfer identification uses the reserved address.

Stop after implementing this flow, testing its failure boundaries and documenting operation. No automated expansion to additional assets, networks, merchant accounts, dashboards, automatic refund execution/sweeping systems, subscriptions, swaps, bridges, Lightning, fiat pricing, legal invoices or NFT credentials.


## Accepted reliability increment

On 2026-10-22, the owner explicitly included cancellation, per-transfer exception review, externally executed refund recording, voucher/refund consistency, durable merchant fulfillment, wallet recovery, advisory unfinalized progress, operational health, supported key rotation/revocation and a tested database restore. These are implemented as separate modules within the single-route boundary.

Refunds remain merchant-signed and are verified against one recorded incoming transfer. No signing keys, automated sending, exchange-rate pricing, generalized balance accounting or additional networks are introduced. This increment ends after these workflows, concurrency/failure tests and operating documentation.
