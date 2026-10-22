/** PostgreSQL persistence and transactional migration. No in-memory payment state. */
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { canonicalJson, hash } from './crypto.js';
import type { Config } from './config.js';
import type { Invoice, PaymentRequest, PaymentStatus } from './domain.js';

export interface InvoiceRow {
  id: string; external_order_id: string; idempotency_key: string; request_hash: string;
  route_id: string; amount_units: string; recipient: string; status: PaymentStatus;
  created_at: Date; expires_at: Date; monitor_until: Date; last_scanned_block: string;
  last_scanned_hash: string | null; voucher_spec: PaymentRequest['voucher'] | null;
}
export function toInvoice(r: InvoiceRow): Invoice {
  return { id: r.id, externalOrderId: r.external_order_id, routeId: r.route_id, amountUnits: r.amount_units,
    recipient: r.recipient, status: r.status, createdAt: r.created_at, expiresAt: r.expires_at,
    monitorUntil: r.monitor_until, lastScannedBlock: BigInt(r.last_scanned_block),
    lastScannedHash: r.last_scanned_hash, voucher: r.voucher_spec };
}
export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    statement_timeout: 15000, idle_in_transaction_session_timeout: 20000 });
}
export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}
export async function initializeDatabase(pool: Pool, config: Config): Promise<void> {
  await transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(87462001)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const versions = await client.query('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
    const version = versions.rows[0]?.version ?? 0;
    if (version > 3) throw new Error('Unsupported database schema version');
    if (version < 1) await client.query(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
    const routeHash = hash(canonicalJson(config.route));
    const secretHash = hash(config.tokenSecret);
    await client.query('INSERT INTO deployment_settings VALUES(1,$1,$2) ON CONFLICT DO NOTHING', [routeHash, secretHash]);
    const { rows } = await client.query('SELECT route_fingerprint, credential_fingerprint FROM deployment_settings WHERE id=1');
    const secrets = [config.tokenSecret, ...config.previousTokenSecrets];
    if (rows[0].route_fingerprint !== routeHash || !secrets.some(s => hash(s) === rows[0].credential_fingerprint)) {
      throw new Error('Database belongs to a different route or credential keyring; supply its existing key during rotation');
    }
    if (version < 2) await client.query(await readFile(new URL('../migrations/002_reliability.sql', import.meta.url), 'utf8'));
    if (version < 3) await client.query(await readFile(new URL('../migrations/003_invoice_listing.sql', import.meta.url), 'utf8'));
    for (const secret of secrets) await client.query('INSERT INTO credential_keys(fingerprint) VALUES($1) ON CONFLICT DO NOTHING', [hash(secret)]);
    const revoked = await client.query('SELECT 1 FROM credential_keys WHERE fingerprint=$1 AND revoked_at IS NOT NULL', [secretHash]);
    if (revoked.rowCount) throw new Error('Active credential key has been revoked');
    const required = await client.query('SELECT DISTINCT key_fingerprint FROM vouchers v JOIN credential_keys k ON k.fingerprint=v.key_fingerprint WHERE k.revoked_at IS NULL AND v.revoked_at IS NULL AND v.redeemed_at IS NULL AND v.expires_at>now()');
    if (required.rows.some(r => !secrets.some(s => hash(s) === r.key_fingerprint))) throw new Error('Credential keyring is missing a live voucher key');
    await client.query('UPDATE deployment_settings SET credential_fingerprint=$1 WHERE id=1', [secretHash]);
    for (const address of config.addresses) await client.query('INSERT INTO receiving_addresses(address) VALUES($1) ON CONFLICT DO NOTHING', [address]);
  });
}
