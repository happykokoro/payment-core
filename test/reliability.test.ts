import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { databaseFixture, FixtureChain, testConfig } from './helpers.js';
import { createPool, initializeDatabase } from '../src/database.js';
import { Ledger } from '../src/ledger.js';
import { Monitor } from '../src/monitor.js';
import { ObservationWorker, paymentProgress } from '../src/observations.js';
import { HealthService } from '../src/health.js';
import { buildApp } from '../src/api.js';
import { hash, credential, signWebhook } from '../src/crypto.js';
import { consumeEvent, initializeMerchant } from '../examples/merchant/consumer.js';
import type { Config } from '../src/config.js';
let db: Awaited<ReturnType<typeof databaseFixture>>, pool: Pool, config: Config, chain: FixtureChain, ledger: Ledger, monitor: Monitor;
const note = { actor: 'test-operator', reason: 'Customer request verified through the merchant support channel' };
const destination = '0x' + 'cc'.repeat(20);
const request = () => ({ externalOrderId: randomUUID(), amountUnits: '2500000', expiresInSeconds: 3600,
  voucher: { entitlement: { product: 'test-access' }, validForSeconds: 3600 } });
beforeAll(async () => { db = await databaseFixture(); pool = createPool(db.url); config = testConfig(db.url); await initializeDatabase(pool, config); await initializeMerchant(pool); });
beforeEach(async () => {
  await pool.query('TRUNCATE invoices,receiving_addresses,credential_keys,deployment_settings,operations,merchant_events,merchant_entitlements,merchant_refund_holds CASCADE');
  await initializeDatabase(pool, config); chain = new FixtureChain(); ledger = new Ledger(pool, config, chain); monitor = new Monitor(pool, config, chain, ledger);
});
afterAll(async () => { await pool?.end(); await db?.close(); });
async function paid() {
  const invoice = await ledger.create(request(), randomUUID()); const transfer = chain.emit(invoice, config); await monitor.tick();
  const voucher = (await ledger.receipt(invoice.id)).voucher!;
  return { invoice, transfer, voucher, refund: { ...note, sourceTransactionHash: transfer.transactionHash, sourceLogIndex: transfer.logIndex, amountUnits: '2500000', recipient: destination } };
}
describe('bounded reliability workflows', () => {
  it('keeps dust review separate and accepts the subsequent exact payment exactly once', async () => {
    const invoice = await ledger.create(request(), randomUUID()); const dust = chain.emit(invoice, config, { amountUnits: '1' }); await monitor.tick();
    expect((await ledger.get(invoice.id)).status).toBe('pending');
    const reviewKey = randomUUID();
    await ledger.exceptions.review(invoice.id, dust.transactionHash, 0, 'acknowledged', note, reviewKey);
    await ledger.exceptions.review(invoice.id, dust.transactionHash, 0, 'acknowledged', note, reviewKey);
    chain.emit(invoice, config); await monitor.tick(); await monitor.tick();
    expect((await ledger.get(invoice.id)).status).toBe('paid');
    expect((await pool.query('SELECT count(*) FROM vouchers')).rows[0].count).toBe('1');
    expect((await pool.query("SELECT count(*) FROM audit_log WHERE action='transfer.reviewed'")).rows[0].count).toBe('1');
  });
  it('serializes cancellation and settlement; cancelled invoices still record transfers', async () => {
    const invoice = await ledger.create(request(), randomUUID()); chain.emit(invoice, config);
    await ledger.exceptions.cancel(invoice.id, note, randomUUID()); await monitor.tick();
    expect((await ledger.get(invoice.id)).status).toBe('cancelled');
    expect((await pool.query('SELECT disposition FROM transfers')).rows[0].disposition).toBe('cancelled');
    expect((await pool.query('SELECT count(*) FROM vouchers')).rows[0].count).toBe('0');
    const next = await ledger.create(request(), randomUUID()); chain.emit(next, config);
    await Promise.allSettled([monitor.tick(), ledger.exceptions.cancel(next.id, note, randomUUID())]);
    const status = (await ledger.get(next.id)).status;
    const count = (await pool.query('SELECT count(*) FROM vouchers WHERE invoice_id=$1', [next.id])).rows[0].count;
    expect(count).toBe(status === 'paid' ? '1' : '0');
  });
  it('serializes refund preparation with redemption and caps concurrent refund reservations', async () => {
    const { invoice, voucher, refund } = await paid();
    const results = await Promise.allSettled([ledger.refunds.prepare(invoice.id, refund, randomUUID()), ledger.redeem(voucher.code!, 'customer', randomUUID())]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const other = await paid();
    const preparations = await Promise.allSettled([ledger.refunds.prepare(other.invoice.id, other.refund, randomUUID()), ledger.refunds.prepare(other.invoice.id, other.refund, randomUUID())]);
    expect(preparations.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('freezes a voucher on preparation and unfreezes only when all prepared refunds are cancelled', async () => {
    const { invoice, voucher, refund } = await paid();
    const first = await ledger.refunds.prepare(invoice.id, { ...refund, amountUnits: '1000000' }, randomUUID());
    const second = await ledger.refunds.prepare(invoice.id, { ...refund, amountUnits: '1000000' }, randomUUID());
    await expect(ledger.redeem(voucher.code!, 'customer', randomUUID())).rejects.toMatchObject({ code: 'voucher_unavailable' });
    await ledger.refunds.cancel(first.id, note, randomUUID());
    await expect(ledger.redeem(voucher.code!, 'customer', randomUUID())).rejects.toMatchObject({ code: 'voucher_unavailable' });
    await ledger.refunds.cancel(second.id, note, randomUUID());
    expect((await ledger.redeem(voucher.code!, 'customer', randomUUID())).id).toBe(voucher.id);
  });
  it('records only matching finalized refund evidence, revokes the voucher and replays without RPC', async () => {
    const { invoice, voucher, refund } = await paid(); const prepared = await ledger.refunds.prepare(invoice.id, refund, randomUUID());
    const wrong = chain.emit(invoice, config, { sender: invoice.recipient, recipient: destination, amountUnits: '1' });
    await expect(ledger.refunds.record(prepared.id, wrong.transactionHash, 0, note, randomUUID())).rejects.toMatchObject({ code: 'refund_proof_mismatch' });
    const transfer = chain.emit(invoice, config, { sender: invoice.recipient, recipient: destination });
    const key = randomUUID(); const result = await ledger.refunds.record(prepared.id, transfer.transactionHash, 0, note, key);
    chain.fail = true;
    expect(await ledger.refunds.record(prepared.id, transfer.transactionHash, 0, note, key)).toEqual(result);
    expect((await ledger.receipt(invoice.id)).voucher!.revokedAt).not.toBeNull();
    await expect(ledger.redeem(voucher.code!, 'customer', randomUUID())).rejects.toMatchObject({ code: 'voucher_unavailable' });
    await expect(ledger.refunds.cancel(prepared.id, note, randomUUID())).rejects.toMatchObject({ code: 'refund_state' });
  });
  it('requires an explicit entitlement resolution before refunding a redeemed voucher', async () => {
    const { invoice, voucher, refund } = await paid(); const redemptionKey = randomUUID(); await ledger.redeem(voucher.code!, 'customer', redemptionKey);
    await expect(ledger.refunds.prepare(invoice.id, refund, randomUUID())).rejects.toMatchObject({ code: 'redeemed_voucher' });
    expect((await ledger.refunds.prepare(invoice.id, { ...refund, redeemedVoucherResolution: 'Access revoked in merchant service; customer agreed to refund' }, randomUUID())).status).toBe('prepared');
    await expect(ledger.redeem(voucher.code!, 'customer', redemptionKey)).rejects.toMatchObject({ code: 'voucher_unavailable' });
  });
  it('rolls back refund preparation and recording with their voucher effects if the outbox fails', async () => {
    const { invoice, voucher, refund } = await paid();
    await pool.query("CREATE FUNCTION fail_refund_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type LIKE 'refund.%' THEN RAISE EXCEPTION 'refund crash'; END IF; RETURN NEW; END $$");
    await pool.query('CREATE TRIGGER crash_refund BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_refund_event()');
    const preparationKey = randomUUID();
    try {
      await expect(ledger.refunds.prepare(invoice.id, refund, preparationKey)).rejects.toThrow('refund crash');
      expect((await pool.query('SELECT count(*) FROM refunds')).rows[0].count).toBe('0');
      expect((await ledger.receipt(invoice.id)).voucher!.frozenAt).toBeNull();
    } finally { await pool.query('DROP TRIGGER crash_refund ON outbox'); }
    const prepared = await ledger.refunds.prepare(invoice.id, refund, preparationKey);
    const transfer = chain.emit(invoice, config, { sender: invoice.recipient, recipient: destination });
    await pool.query('CREATE TRIGGER crash_refund BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_refund_event()');
    const recordKey = randomUUID();
    try {
      await expect(ledger.refunds.record(prepared.id, transfer.transactionHash, 0, note, recordKey)).rejects.toThrow('refund crash');
      expect((await pool.query('SELECT status FROM refunds WHERE id=$1', [prepared.id])).rows[0].status).toBe('prepared');
      expect((await ledger.receipt(invoice.id)).voucher!.revokedAt).toBeNull();
    } finally { await pool.query('DROP TRIGGER crash_refund ON outbox'); await pool.query('DROP FUNCTION fail_refund_event()'); }
    await ledger.refunds.record(prepared.id, transfer.transactionHash, 0, note, recordKey);
    await expect(ledger.redeem(voucher.code!, 'customer', randomUUID())).rejects.toMatchObject({ code: 'voucher_unavailable' });
  });
  it('never credits the same outgoing refund log to two reservations', async () => {
    const { invoice, refund } = await paid();
    const one = await ledger.refunds.prepare(invoice.id, { ...refund, amountUnits: '1000000' }, randomUUID());
    const two = await ledger.refunds.prepare(invoice.id, { ...refund, amountUnits: '1000000' }, randomUUID());
    const transfer = chain.emit(invoice, config, { sender: invoice.recipient, recipient: destination, amountUnits: '1000000' });
    await ledger.refunds.record(one.id, transfer.transactionHash, 0, note, randomUUID());
    await expect(ledger.refunds.record(two.id, transfer.transactionHash, 0, note, randomUUID())).rejects.toMatchObject({ code: '23505' });
    expect((await pool.query("SELECT count(*) FROM refunds WHERE status='recorded'")).rows[0].count).toBe('1');
  });
  it('observes a manual payment without fulfillment, removes reorg hints and retains settlement independence', async () => {
    const invoice = await ledger.create(request(), randomUUID()); chain.emit(invoice, config);
    const observation = new ObservationWorker(pool, config, chain); await observation.tick();
    expect((await paymentProgress(pool, invoice.id, 120)).state).toBe('confirming');
    await expect(ledger.receipt(invoice.id)).rejects.toMatchObject({ code: 'not_paid' });
    expect((await pool.query('SELECT count(*) FROM outbox')).rows[0].count).toBe('0');
    chain.blocks.get(chain.head)!.hash = '0x' + 'ee'.repeat(32); chain.evidence = [];
    await observation.tick(); expect((await paymentProgress(pool, invoice.id, 120)).state).toBe('awaiting_payment');
    chain.emit(invoice, config); await observation.tick(); await monitor.tick();
    expect((await ledger.receipt(invoice.id)).status).toBe('paid');
  });
  it('reports startup, stale scanning, lag, address depletion and dead webhooks as degraded', async () => {
    const health = new HealthService(pool, config, monitor);
    expect((await health.inspect()).alerts).toContain('monitor_unavailable');
    await monitor.tick(); expect((await health.inspect()).status).toBe('ok');
    const { invoice } = await paid();
    await pool.query('UPDATE outbox SET dead_at=now()');
    await pool.query('DELETE FROM receiving_addresses WHERE reserved_invoice_id IS NULL');
    monitor.lastHead = { ...chain.blocks.get(chain.head)!, number: chain.head + 10000n };
    monitor.lastSuccess = new Date(0);
    expect((await health.inspect()).alerts).toEqual(expect.arrayContaining(['monitor_unavailable', 'scan_behind', 'webhook_dead_letters', 'receiving_addresses_low']));
    expect((await ledger.get(invoice.id)).status).toBe('paid');
  });
  it('rotates keys with old credentials preserved, then revokes and explicitly reissues', async () => {
    const { invoice, voucher } = await paid();
    const rotated = { ...config, tokenSecret: 'rotated-credential-key-'.repeat(3), previousTokenSecrets: [config.tokenSecret] };
    await initializeDatabase(pool, rotated); const next = new Ledger(pool, rotated, chain);
    const oldCheckout = `Bearer ${credential(config.tokenSecret, 'checkout', invoice.id)}`;
    expect(await next.credentials.verifyCheckout(invoice.id, oldCheckout)).toBe(true);
    expect((await next.receipt(invoice.id)).voucher!.code).toBe(voucher.code);
    await next.credentials.revoke(hash(config.tokenSecret), note, randomUUID());
    expect(await next.credentials.verifyCheckout(invoice.id, oldCheckout)).toBe(false);
    await expect(next.redeem(voucher.code!, 'customer', randomUUID())).rejects.toMatchObject({ code: 'credential_revoked' });
    expect((await next.receipt(invoice.id)).voucher!.code).toBeNull();
    await next.credentials.reissue(invoice.id, note, randomUUID()); const newCode = (await next.receipt(invoice.id)).voucher!.code!;
    expect(newCode).not.toBe(voucher.code); await next.redeem(newCode, 'customer', randomUUID());
    await expect(ledger.create(request(), randomUUID())).rejects.toMatchObject({ code: 'credential_key_inactive' });
  });
  it('applies new merchant-only scope and idempotency at the HTTP boundary', async () => {
    const invoice = await ledger.create(request(), randomUUID()); const app = await buildApp(ledger, monitor);
    try {
      const headers = { authorization: `Bearer ${config.apiKey}`, 'idempotency-key': randomUUID() };
      const payload = note; const url = `/v1/invoices/${invoice.id}/cancel`;
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url, headers, payload: { ...note, reason: 'changed' } })).statusCode).toBe(409);
      expect((await app.inject('/v1/operations/health')).statusCode).toBe(401);
    } finally { await app.close(); }
  });
});
describe('merchant transaction boundary', () => {
  async function deliver(event: { id: string; type: string; data: Record<string, unknown> }) {
    const body = JSON.stringify(event); const timestamp = Math.floor(Date.now() / 1000).toString();
    return consumeEvent(pool, [config.webhookSecret], body, timestamp, signWebhook(config.webhookSecret, timestamp, body), event.id);
  }
  it('deduplicates concurrent delivery and keeps refund-before-payment inactive', async () => {
    const invoiceId = randomUUID(); const event = { id: randomUUID(), type: 'payment.paid', data: { invoiceId, voucherId: null } };
    await Promise.all(Array.from({ length: 5 }, () => deliver(event)));
    expect((await pool.query('SELECT count(*) FROM merchant_entitlements')).rows[0].count).toBe('1');
    const second = randomUUID(); await deliver({ id: randomUUID(), type: 'refund.recorded', data: { invoiceId: second, affectsEntitlement: true } });
    await deliver({ id: randomUUID(), type: 'payment.paid', data: { invoiceId: second, voucherId: null } });
    expect((await pool.query('SELECT active FROM merchant_entitlements WHERE invoice_id=$1', [second])).rows[0].active).toBe(false);
  });
  it('does not revoke the paid entitlement when an unrelated extra transfer is refunded', async () => {
    const invoiceId = randomUUID();
    await deliver({ id: randomUUID(), type: 'payment.paid', data: { invoiceId, voucherId: null } });
    await deliver({ id: randomUUID(), type: 'refund.recorded', data: { invoiceId, affectsEntitlement: false } });
    expect((await pool.query('SELECT active FROM merchant_entitlements WHERE invoice_id=$1', [invoiceId])).rows[0].active).toBe(true);
  });
  it('rolls back event deduplication if granting the benefit fails; retry succeeds', async () => {
    const event = { id: randomUUID(), type: 'payment.paid', data: { invoiceId: randomUUID(), voucherId: null } };
    await pool.query("CREATE FUNCTION fail_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'grant crash'; END $$");
    await pool.query('CREATE TRIGGER crash_grant BEFORE INSERT ON merchant_entitlements FOR EACH ROW EXECUTE FUNCTION fail_grant()');
    try {
      await expect(deliver(event)).rejects.toThrow('grant crash');
      expect((await pool.query('SELECT count(*) FROM merchant_events')).rows[0].count).toBe('0');
    } finally { await pool.query('DROP TRIGGER crash_grant ON merchant_entitlements'); await pool.query('DROP FUNCTION fail_grant()'); }
    await deliver(event); expect((await pool.query('SELECT count(*) FROM merchant_entitlements')).rows[0].count).toBe('1');
  });
});
