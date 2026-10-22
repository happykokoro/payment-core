# Contributing

Use Node.js 22.14 or newer. Install with `npm ci`, then run `npm run check`,
`npm test` and `npm run build`. Tests create disposable PostgreSQL clusters and
a local EVM; no production secrets or real money are needed. Run tests as an
ordinary user on Linux. Leave `TEST_DATABASE_URL` unset to include the cold
backup/restore drill.

Keep HTTP handlers thin and changes inside the existing service boundaries.
Add regression coverage for payment-state, concurrency or authorization changes.
Discuss scope expansions in an issue before implementing them. Submit a focused
merge request or pull request with the problem, behavior change and validation.

Never commit `.env`, database files, wallet keys, build output or dependencies.
Contributions are provided under this repository's MIT license.
