# Operating and recovery guide

## Commands and audit

All mutation routes below require the merchant bearer key and an `Idempotency-Key`. Reuse the same key and exact body after a timeout. Operator notes contain `actor` (1–128 characters) and `reason` (1–2000). `actor` is an audit label supplied by the single merchant; it is not independent proof of a user's identity.

| Method/path | Body or result |
| --- | --- |
| `POST /v1/invoices/:id/cancel` | Operator note; stops automatic acceptance, continues monitoring |
| `POST /v1/invoices/:id/reviews` | Note, `transactionHash`, `logIndex`, `resolution`: `acknowledged` or `refund_required` |
| `GET /v1/invoices/:id/audit` | Paginated invoice audit entries |
| `POST /v1/invoices/:id/refunds` | Note, `sourceTransactionHash`, `sourceLogIndex`, positive integer `amountUnits`, verified customer `recipient`; optionally `redeemedVoucherResolution` |
| `GET /v1/invoices/:id/refunds` | Paginated prepared/recorded/cancelled refunds and proofs |
| `POST /v1/refunds/:id/record` | Note, externally sent `transactionHash`, `logIndex` |
| `POST /v1/refunds/:id/cancel` | Note and `fundsNotSent: true` |
| `GET /v1/credentials/keys` | Key fingerprints, revocation timestamps, active fingerprint; no secrets |
| `POST /v1/credentials/keys/:fingerprint/revoke` | Note; active key must first be rotated |
| `POST /v1/invoices/:id/credentials/reissue` | Note; regenerate an eligible voucher credential under the active key |
| `GET /v1/operations/health` | Authenticated worker freshness, scan lag, address count and delivery backlog |

List endpoints accept `limit` (1–100) and `offset`. Reviews are immutable resolutions, separate from raw evidence. Review acknowledgment never issues a receipt or voucher. Marking `refund_required` records a decision; prepare a refund separately.

## Cancellation and refund policy

Invoice cancellation cannot cancel a blockchain transaction or prevent an address from receiving funds. Cancelled invoices keep their reserved address and remain monitored until their original monitoring window ends. Any transfer found afterward is an exception, including an on-time transfer sent before cancellation but finalized afterward. A settled invoice requires the refund workflow.

Prepare a refund against a specific recorded incoming transfer. Confirm the destination with the customer through an authenticated merchant channel; do not automatically refund the transaction sender, which may be an exchange. The API rejects destinations in the merchant's configured receiving pool. Preparation reserves an amount so all prepared/recorded refunds together cannot exceed that source transfer.

For a refund of the accepted payment, preparation freezes its voucher in the same transaction. If already redeemed, the merchant must record how the delivered entitlement was resolved in `redeemedVoucherResolution` (at least 10 characters). The core cannot revoke access in another application. Refunds of extra/incorrect transfers do not affect the accepted payment's voucher.

Send the approved amount from the original invoice receiving address using the merchant's external wallet, then record the transaction and log index. The verifier checks network, USDC contract, exact sender/recipient/amount, preparation time, successful execution, canonicality and finality. This release requires that sender; treasury/swept-address refunds need a future explicit policy. Recording an accepted-payment refund permanently revokes its voucher, even for a partial refund. The original payment receipt remains as history.

Cancel a prepared refund only before sending it. `fundsNotSent: true` is the merchant's attestation, not blockchain evidence. A broadcast or uncertain transaction must be investigated instead. Cancellation releases its reservation; the voucher unfreezes only when no other noncancelled accepted-payment refund remains. The core does not automatically send money or prevent an operator from making extra external transfers.

## Checkout progress and recovery

The observation worker scans bounded pages independently of final settlement. Matching unfinalized transfers show “awaiting confirmation”; reorgs remove those hints and stale observations show a delay. No observation produces a receipt or webhook.

A returned wallet hash blocks another submission while pending/unknown. Speedups and cancellations detected by viem update the tracked hash. Retry becomes available only after the server verifies a finalized failed transaction or a finalized transaction with no transfer to this invoice. Missing receipts and timeouts do not permit retry. A wallet response interrupted before returning a hash remains blocked after reload and needs wallet/merchant investigation. Merely choosing another payment tab does not cancel or refund anything.

## Health and reconciliation

`/health` returns only `ok`/`degraded` (200/503). Authenticated operational health includes alerts for a worker that has never succeeded or is stale, a saved scan cursor far behind the observed finalized head, dead/old webhooks and a low receiving-address pool. Thresholds are in `.env.example`. Integrate these results with the deployment's existing monitoring; this repository does not send external notifications or configure a monitoring service.

For `scan_behind`, check provider identity, finalized support, RPC quotas and backlog. Fix the provider before increasing scan ranges. For `finalized_checkpoint_changed`, stop automatic fulfillment and compare canonical history using a trusted node/provider; do not delete checkpoints or clear the halt blindly. For stale workers, inspect process logs and database connectivity. Low addresses require fresh wallet-controlled addresses and a restart; restarting alone does not add addresses. Repeated restarts do not resolve a finality discrepancy or dead-letter queue.

Use `/v1/events` to inspect failed deliveries and retry their existing event IDs after fixing the receiver. For incorrect/late/extra/cancelled transfers, inspect `/transfers`, record a review and prepare a refund if appropriate. Monitoring ends seven days after invoice expiry by default, using chain time; transfers outside that window need external reconciliation. Unsupported assets/networks are not monitored.

## Credential rotation and revocation

1. Back up the database and secret configuration through the deployment's protected secret store.
2. Stop the single service instance. Set a fresh `TOKEN_SECRET`; put the previous value in the JSON array `TOKEN_SECRET_PREVIOUS`. Restart. Startup requires the prior active key to authorize the transition and rejects a changed network.
3. Existing checkout links and voucher codes continue to work while their keys are retained and unrevoked. Newly issued credentials use the current key. The database stores fingerprints and voucher hashes, not plaintext secrets.
4. For a compromised old key, call the revoke endpoint with its fingerprint. Old checkout links and old voucher credentials stop working. Get a fresh checkout link from the merchant invoice endpoint. Explicitly reissue eligible, unredeemed vouchers, then retrieve their new codes from the authenticated receipt endpoint. Redemption and refund history are preserved. Reissue also changes a generation counter so the previous voucher code stops working even under the same key.
5. Remove retired secrets only when no live, unrevoked vouchers require them. Startup checks that requirement. Revocation records remain durable; restoring a key to configuration cannot un-revoke it. An active key cannot be revoked before rotation.

Rotate `API_KEY` by stopping the service, replacing it, and updating the merchant client; old API keys immediately stop working after restart. For planned `WEBHOOK_SECRET` rotation, first configure the merchant receiver to accept the new and old secrets, then restart the sender with the new secret. The durable merchant example accepts `WEBHOOK_SECRET_PREVIOUS` during this overlap. Remove the old verifier key after the overlap; on compromise, remove it immediately. Event IDs remain stable across webhook-signing changes. These policies follow the [OWASP secret lifecycle guidance](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html).

## Backups and restoration

Back up the entire payment database, the merchant's deduplication/entitlement database and the protected secret configuration. Preserve route/address settings, credential-key versions, voucher redemption/revocation state, refund reservations/proofs, audit, outbox and scan cursors together. Receiving wallet keys require their own wallet backup; they never enter this service.

`npm run test:restore` creates a disposable PostgreSQL cluster, settles and redeems a payment, stops it cleanly, copies the whole cluster to a separate directory, restarts the copy and checks state/credentials/replay protection. It also rejects a wrong restored token secret. This is a real **cold-cluster restore drill**, not a test of a production provider's backup system. It is skipped when `TEST_DATABASE_URL` points to an external test server. The [PostgreSQL filesystem-backup rules](https://www.postgresql.org/docs/current/backup-file.html) require a clean stop for this copying method; never copy individual live database files.

Use the hosting provider's supported backups/PITR for deployment and test restoration to an isolated database with the matching secrets. A [custom-format pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html) is also useful for migration/export; backup retention and recovery objectives belong to deployment configuration. Do not run two restored copies against the same merchant webhook destination.

After restoring an older snapshot, pause external fulfillment until reconciling later redemptions, key revocations, refunds and merchant-side grants. Blockchain rescanning can recover transfers, but cannot reconstruct off-chain redemptions that were lost after the backup. Reapply any later key revocations before exposing checkout. A successful snapshot drill is not a claim of zero data loss.

## Durable merchant example

Set a separate `MERCHANT_DATABASE_URL` and run `npm run example:merchant`. The example verifies raw-body signatures, records event IDs, and updates a local entitlement table in one transaction, matching [documented webhook duplicate-delivery handling](https://docs.stripe.com/webhooks#handle-duplicate-events). Payment without a voucher grants once; voucher payment grants only on redemption. Refund events include `affectsEntitlement`; only a recorded refund of the accepted payment marks a local hold, including if delivered before the payment event. Refunding an unrelated extra transfer preserves the purchased entitlement. The merchant must adapt this simple entitlement policy to its product. The older `example:webhook` command is only a logging diagnostic and is not a durable fulfillment consumer.
