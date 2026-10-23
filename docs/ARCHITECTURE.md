# Module boundaries

The application is one process and one PostgreSQL database. Modules follow responsibilities; additional chains or merchant products do not require putting new logic into the HTTP server or ledger facade.

| Module | Owns | Must not do |
| --- | --- | --- |
| `domain.ts` | Invoice/transfer types and pure admission rules | SQL, RPC, HTTP |
| `chain.ts` / `PaymentChain` | Network identity, canonical receipts/logs, finalized refund evidence | Change invoices or issue vouchers |
| `monitor.ts` | Durable finalized scan scheduling and checkpoint checks | Decide product entitlement |
| `observations.ts` | Reversible, unfinalized checkout progress | Mark paid or generate fulfillment events |
| `services/invoices.ts` | Invoice creation, address allocation, read models | Admit transfers or redeem vouchers |
| `services/settlement.ts` | Atomic transfer admission, payment/voucher/outbox commit | Trust browser payment claims |
| `services/vouchers.ts` | Single-use redemption and refund/key restrictions | Send funds |
| `services/exceptions.ts` | Cancellation and audited transfer resolutions | Rewrite evidence or turn an exception into payment |
| `services/refunds.ts` | Amount reservations, voucher freeze/revocation, external refund verification | Sign or broadcast refunds |
| `services/credentials.ts` | Key lifecycle, old-key verification, revocation/reissue | Store plaintext keys in SQL |
| `operations.ts`, `events.ts` | Transactional command replay, audit and outbox helpers | Host business workflows |
| `database.ts`, `migrations/` | Connection/transaction handling and versioned schema | Contain HTTP rules |
| `webhooks.ts`, `health.ts` | Delivery retries and observable operational state | Infer settlement from delivery success |
| `http/`, `api.ts` | Validation, authentication, thin route mapping, application composition | Implement payment workflows |
| `ledger.ts` | Small compatibility facade composing services | Accumulate new business rules |
| Separate `crypto-payment-ui` repository | Checkout, read-only dashboard and server-side API proxy | Access the payment database, issue credentials or claim settlement |
| `examples/merchant/` | Separate merchant inbox and entitlement transaction | Become part of the core's database |

## Separate state machines

Invoices are pending, expired, paid or cancelled. Exceptions are transfer records with dispositions and optional review resolutions. The old `needs_review` invoice state is migrated to pending/expired; it is retained in the type/schema only for compatibility. A dust transfer does not close an invoice.

Refunds are prepared, recorded or cancelled. Vouchers independently track redemption, freezing and revocation. A paid invoice remains a historical paid invoice after a refund; the refund is a separate financial fact. An unfinalized observation has no financial authority.

## Transaction boundaries and concurrency

- Creating an invoice reserves its address in the same transaction. Addresses are never recycled.
- Settlement holds the invoice row lock and commits evidence, paid status, optional voucher and outbox together. Unique transfer identity and the one-accepted-transfer constraint prevent double fulfillment.
- Cancellation competes for that invoice lock. If cancellation commits first, even an earlier sent but not yet settled transfer is recorded as an exception. If settlement commits first, cancellation returns `already_paid`.
- Refund preparation locks invoice then voucher. Redemption locks the voucher. One wins; a redeemed voucher requires an explicit merchant entitlement-resolution note before refund preparation.
- Refund reservations are summed while holding the invoice lock. One chain log may prove only one recorded refund. RPC verification occurs before business locks; the transaction rechecks the refund state.
- Merchant commands persist their response and audit records with the state change. Identical retries return the original result; changed arguments under the same command key conflict.
- The reference webhook consumer commits deduplication and its local entitlement together. External provisioning would need its own durable outbox; a database transaction cannot atomically commit an unrelated external API call.

## Extension rule and stopping point

Add a new chain only through the evidence interface plus route-specific adapter tests and an explicit scope decision. Add product policies in the merchant application. Keep signing/custody, swaps, subscriptions, accounting balances, automatic refunds and multi-tenancy outside this release. No workflow engine, plugin registry or microservice split is needed for the current boundaries.
