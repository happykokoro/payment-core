#!/usr/bin/env bash
set -euo pipefail

# Run as an ordinary user: PostgreSQL refuses to initialize as root.
test "$(id -u)" -ne 0
unset TEST_DATABASE_URL
npm ci --no-fund
npm audit --audit-level=high
npm run check
npm test
npm run build
