/** Real cold PostgreSQL restore into a separate cluster; no production database is read or changed. */
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { databaseFixture, testConfig, FixtureChain } from './helpers.js';
import { createPool, initializeDatabase } from '../src/database.js';
import { Ledger } from '../src/ledger.js';
import { Monitor } from '../src/monitor.js';
it.skipIf(Boolean(process.env.TEST_DATABASE_URL))('restores payment evidence, address reservations, redeemed credentials and undelivered events from a stopped-cluster backup', async () => {
  const database = await databaseFixture(); let pool = createPool(database.url);
  let restore: Awaited<ReturnType<typeof database.coldRestore>> | undefined;
  let restoredPool: ReturnType<typeof createPool> | undefined;
  let poolClosed = false;
  try {
    const config = testConfig(database.url); await initializeDatabase(pool, config); const chain = new FixtureChain();
    const ledger = new Ledger(pool, config, chain); const monitor = new Monitor(pool, config, chain, ledger);
    const invoice = await ledger.create({ externalOrderId: randomUUID(), amountUnits: '2500000', expiresInSeconds: 3600,
      voucher: { entitlement: { product: 'restored-access' }, validForSeconds: 3600 } }, randomUUID());
    chain.emit(invoice, config); await monitor.tick(); const code = (await ledger.receipt(invoice.id)).voucher!.code!;
    const redemptionKey = randomUUID(); await ledger.redeem(code, 'customer', redemptionKey);
    const paidBefore = await ledger.get(invoice.id);
    const eventIds = (await pool.query('SELECT id FROM outbox ORDER BY id')).rows.map(r => r.id);
    await pool.end(); poolClosed = true;
    restore = await database.coldRestore(); restoredPool = createPool(restore.url);
    const restoredConfig = { ...config, databaseUrl: restore.url };
    await initializeDatabase(restoredPool, restoredConfig); const restored = new Ledger(restoredPool, restoredConfig, chain);
    expect((await restored.get(invoice.id)).lastScannedBlock).toBe(paidBefore.lastScannedBlock);
    expect((await restored.receipt(invoice.id)).voucher!.code).toBe(code);
    expect((await restored.redeem(code, 'customer', redemptionKey)).entitlement).toEqual({ product: 'restored-access' });
    await expect(restored.redeem(code, 'someone-else', randomUUID())).rejects.toMatchObject({ code: 'voucher_redeemed' });
    expect((await restoredPool.query('SELECT id FROM outbox ORDER BY id')).rows.map(r => r.id)).toEqual(eventIds);
    expect((await restoredPool.query('SELECT reserved_invoice_id FROM receiving_addresses WHERE address=$1', [invoice.recipient])).rows[0].reserved_invoice_id).toBe(invoice.id);
    await expect(initializeDatabase(restoredPool, { ...restoredConfig, tokenSecret: 'wrong-restore-key'.repeat(4) })).rejects.toThrow('credential keyring');
  } finally {
    if (!poolClosed) await pool.end();
    await restoredPool?.end(); await restore?.close(); await database.close();
  }
}, 60000);
