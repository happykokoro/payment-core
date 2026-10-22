# Validation

Verified locally on 2026-10-22. Node.js 22.14.0, Windows x64.

## Separate repositories: current result

The API/UI split passed core TypeScript checks, **47 tests across six suites**, and the API-only production build. The added tests cover authenticated invoice listing, status/order filters, bounded pagination with tied timestamps, omission of checkout credentials from lists, and operation without a UI URL. Migration 003 adds listing indexes and preserves existing voucher credentials.

The separate payment-ui repository passed its own type checks, eight tests, production build and the cross-repository browser run against real temporary PostgreSQL. Checkout, dashboard sign-in/out, filtered invoices, evidence, webhook deliveries and health passed; desktop/mobile dashboard screenshots were visually reviewed. All test services were stopped after the run.

Core runtime dependencies contain no React, Wagmi, QR encoder or static-file server. Its build compiles only API code; Vite remains only as an internal development dependency of Vitest. Browser acceptance and its Playwright dependency now belong to payment-ui. Both npm installs reported zero vulnerabilities. No new payment or live-chain transfer was needed for this structural change.

See [UI integration](UI-INTEGRATION.md) for the new `CHECKOUT_URL` setting and upgrade instructions. The records below describe the earlier combined prototype and reliability validation; their browser commands and asset paths belong to that historical run.

## Earlier combined prototype

| Check | Result |
| --- | --- |
| `npm run check` | Backend, checkout and durable merchant example TypeScript checks passed |
| `npm test` | 46 tests passed across six suites: domain, PostgreSQL integration, reliability, EVM adapter, migration and restore |
| PostgreSQL | Real temporary PostgreSQL 18.4; concurrent creation/redemption, rollback and restart recovery exercised |
| EVM | Local Anvil 1.7.1; successful, reverted, wrong-token/wrong-recipient transfers and multiple logs per transaction exercised |
| `npm run build` | API and production checkout built successfully |
| `npm run test:checkout` | Headless Chrome passed desktop/mobile QR layout, EIP-1193 discovery/connection, network switch, rejected approval, exact transfer encoding, submitted-vs-paid distinction, reload duplicate guard, confirmed receipt and voucher privacy; no browser errors |
| `npm audit` | Zero reported vulnerabilities, including development dependencies, after compatible dependency updates |
| Secret / diff checks | Gitleaks found no credentials after narrowly allowing the two public Circle contract addresses; `git diff --check` passed |
| Public Base Sepolia probe | Read-only network/USDC decimals/finalized-head check succeeded; block 48762900, chain timestamp 2026-10-22 13:07:28 UTC |
| Live Base Sepolia acceptance | Passed using 20 free faucet USDC: actual transfer, finalized verification, HTTP receipt, signed payment/redemption webhooks, single-use voucher and checkout confirmation |

The browser test uses a simulated wallet provider, not a real MetaMask/Phantom extension. Backend failure cases include mismatched amounts, late payments, expiry during confirmation, RPC outages, changed finalized checkpoints, duplicate polling, additional transfers, failed webhook delivery and credential-scope enforcement.

The build reports an upstream `ox` browser externalization notice for `node:worker_threads` from its unused Tempo support and a bundle-size warning (checkout about 594 kB minified / 182 kB gzip). The exercised checkout paths execute without browser errors.

No real-money payment is required for development validation or publishing this repository. The completed public-testnet acceptance run used Circle's faucet to fund an invoice directly, exercising the manual-transfer path. Installed MetaMask/Phantom signing has not been tested; an actual wallet can exercise that path on Base Sepolia with test USDC and test ETH for gas. A mainnet transfer is an optional deployment check, not a prerequisite for this release.

Official documentation reviewed on 2026-10-22:

- [Circle's USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses) distinguish mainnet from testnet tokens and state that testnet tokens have no financial value. Both configured Base USDC addresses match the published addresses.
- [Circle's EVM transfer quickstart](https://developers.circle.com/stablecoins/quickstarts/transfer-usdc-evm) uses Viem, test USDC and test native gas tokens, and checks transaction receipt success.
- [Base's funding guide](https://docs.base.org/get-started/get-funds) provides sources of free Base Sepolia ETH and USDC.
- [The ERC-20 standard](https://eips.ethereum.org/EIPS/eip-20) defines `transfer` and the `Transfer` event used by our checkout and verifier.

Documentation review supports the protocol choices; runtime tests verify the application behaviors. Mainnet deployment configuration remains separately verifiable; a passing testnet run does not establish production readiness.

## Live public-testnet evidence

Completed on 2026-10-22 at 14:15:53 UTC using the actual HTTP API, a temporary PostgreSQL database, the unmodified chain verifier, a local HTTP webhook receiver and the real checkout. No fixture chain evidence was supplied. A second monitor instance drained normal 200-block scan pages after finality advanced; it used the same database locks and finality checks.

- Network: Base Sepolia, chain ID `84532`.
- Asset: Circle's test USDC, `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.
- Amount: 20 test USDC (`20000000` base units).
- Invoice: `063ae140-1c90-48cd-8fc3-c0f154922110`.
- Recipient: `0xc7191f2113dd9bb1687bde83973871050c771a4d`.
- [Successful transaction](https://base-sepolia.blockscout.com/tx/0x973ef87dc6362731eb275c2296d2996b9e3decef1f50f0ce487bbe18dbf367b9), block `48778103`, log index `0`, included at 13:58:09 UTC.
- The observed finalized head reached block `48778507` before acceptance. Fulfillment was withheld while the transaction was successful but unfinalized: receipt HTTP 409, zero vouchers and zero outbox events.
- After finality: one accepted transfer, one voucher, two delivered signed events (`payment.paid`, `voucher.redeemed`); same-key redemption replay succeeded, a different redemption key returned HTTP 409, and another scan did not duplicate fulfillment. The live checkout displayed **Payment confirmed**.

The first attempt exposed the public RPC's 200-block `eth_getLogs` limit. The previous default of 500 caused rejected scans while preserving the checkpoint. `SCAN_BLOCK_RANGE` now defaults to 200 and `.env.example` reflects that limit. The fresh acceptance run above passed after this correction, as did all 27 automated tests, type checks and the production build.

Sanitized payment evidence is saved in [testnet-2026-10-22.json](testnet-2026-10-22.json). Screenshots and one-off test runners remain under ignored `.local/testnet-rerun/` and `.local/`; test-only keys and configuration are not part of the repository. No real funds, existing user wallet, production host, original Kokoro Pay checkout, remote repository or CI configuration was changed. The completed run stopped its API, webhook receiver and temporary PostgreSQL instance. Deletion of the first interrupted run's unused database files was blocked by automatic approval review; that stopped cluster's files remain under ignored `.local/`.


## Modular reliability increment — 2026-10-22

The final automated run passed **46 tests across six suites**. Type checks cover the backend, checkout and durable merchant example. The production build and browser checkout test passed. No dependencies were added for this increment.

Additional verified behaviors:

- Dust/incorrect transfers retain individual review records while a subsequent exact payment succeeds once.
- Cancellation competes safely with settlement and continues recording later detected transfers.
- Refund reservations cannot exceed the incoming transfer; redemption and refund freezing cannot both win.
- Preparation/recording crashes roll back refund, voucher and outbox effects together. Replays return the committed response without another RPC call.
- Refund proofs require the exact approved transfer, cannot reuse one outgoing log, and revoked/frozen vouchers cannot be redeemed or replayed as active.
- Already redeemed benefits require an explicit merchant resolution. Refunding an extra transfer preserves the original entitlement in the merchant example.
- Unfinalized observations never fulfill; changed blocks remove their progress hints.
- Health detects startup/staleness, scan lag, depleted addresses and failed webhook delivery.
- Key rotation preserves old credentials, durable revocation disables them, and explicit reissue restores an eligible voucher under the current key.
- Version-1 database migration preserves existing voucher credentials and address reservations.
- Merchant event deduplication and local entitlement grants commit together; a failed grant is retried safely. Refund-before-payment delivery leaves the entitlement inactive when appropriate.
- A real, stopped-cluster PostgreSQL backup was restored into a separate cluster. Payment evidence, scan checkpoint, address reservation, redeemed voucher replay protection and pending event IDs survived. Incorrect restored credential configuration was rejected. The drill does not test hosting-provider backups or recovery of changes made after a snapshot.

The extended browser test passed desktop/mobile layouts, wallet rejection, exact token encoding, unknown-transaction retry blocking, finalized-failure recovery, manual-payment progress, same-page invoice-link changes, cancellation and ambiguous wallet-response persistence after reload. It uses a simulated EIP-1193 provider; installed-wallet signing remains untested.

The updated adapter also reverified the already recorded public Base Sepolia transaction above through the live RPC, including canonical finalized receipt/log, recipient and 20-test-USDC amount. This was read-only; no additional funds were sent. Refund execution was exercised using local EVM evidence and PostgreSQL failure/concurrency tests, not a new public-testnet refund.

A restore-test harness connection initially emitted a reset during the deliberate database stop. Closing the harness connection pool before stopping PostgreSQL fixed it; the targeted restore test and subsequent complete suite passed without unhandled errors.
