import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { databaseFixture, testConfig, FixtureChain } from './helpers.js';
import { createPool, initializeDatabase } from '../src/database.js';
import { canonicalJson, credential, hash } from '../src/crypto.js';
import { Ledger } from '../src/ledger.js';
it('upgrades the original schema while preserving old voucher credentials and separating review from payment state', async () => {
  const db = await databaseFixture(); const pool = createPool(db.url);
  try {
    const config = testConfig(db.url);
    await pool.query(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
    await pool.query('INSERT INTO deployment_settings VALUES(1,$1,$2)', [hash(canonicalJson(config.route)), hash(config.tokenSecret)]);
    const invoiceId = randomUUID(); const voucherId = randomUUID(); const recipient = config.addresses[0]!;
    await pool.query('INSERT INTO receiving_addresses(address,reserved_invoice_id) VALUES($1,$2)', [recipient, invoiceId]);
    await pool.query(`INSERT INTO invoices(id,external_order_id,idempotency_key,request_hash,route_id,amount_units,recipient,status,created_at,expires_at,monitor_until,last_scanned_block)
      VALUES($1,'legacy-order','legacy-key','legacy-hash',$2,2500000,$3,'paid',now(),now()+interval '1 hour',now()+interval '1 day',100)`, [invoiceId, config.route.id, recipient]);
    const code = credential(config.tokenSecret, 'voucher', voucherId);
    await pool.query("INSERT INTO vouchers(id,invoice_id,code_hash,entitlement,expires_at) VALUES($1,$2,$3,'{}',now()+interval '1 day')", [voucherId, invoiceId, hash(code)]);
    await initializeDatabase(pool, config); await initializeDatabase(pool, config);
    const ledger = new Ledger(pool, config, new FixtureChain());
    expect((await ledger.receipt(invoiceId)).voucher!.code).toBe(code);
    await ledger.redeem(code, 'legacy-customer', randomUUID());
    expect((await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r => r.version)).toEqual([1, 2, 3]);
    const invoice = await ledger.create({ externalOrderId: randomUUID(), amountUnits: '100', expiresInSeconds: 60 }, randomUUID());
    expect(invoice.recipient).not.toBe(recipient);
  } finally { await pool.end(); await db.close(); }
});
