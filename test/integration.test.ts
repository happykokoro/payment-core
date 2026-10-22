import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { databaseFixture, FixtureChain, testConfig } from './helpers.js';
import { createPool, initializeDatabase } from '../src/database.js';
import { Ledger } from '../src/ledger.js';
import { Monitor } from '../src/monitor.js';
import { WebhookWorker } from '../src/webhooks.js';
import { buildApp } from '../src/api.js';
import { verifyWebhook } from '../src/crypto.js';
import type { Config } from '../src/config.js';

let database: Awaited<ReturnType<typeof databaseFixture>>; let pool: Pool; let config: Config;
let chain: FixtureChain; let ledger: Ledger; let monitor: Monitor;
const request = (externalOrderId = randomUUID()) => ({ externalOrderId, amountUnits: '2500000', expiresInSeconds: 3600,
  voucher: { entitlement: { product: 'example-access', quantity: 1 }, validForSeconds: 86400 } });
beforeAll(async () => { database = await databaseFixture(); config = testConfig(database.url); pool = createPool(database.url); await initializeDatabase(pool, config); });
beforeEach(async () => {
  await pool.query('TRUNCATE invoices,transfers,vouchers,outbox,receiving_addresses CASCADE');
  await initializeDatabase(pool, config); chain = new FixtureChain(); ledger = new Ledger(pool, config, chain); monitor = new Monitor(pool, config, chain, ledger);
});
afterAll(async () => { await pool?.end(); await database?.close(); });

describe('PostgreSQL payment lifecycle', () => {
  it('lists invoices with authenticated, validated filters and deterministic pagination, without checkout credentials', async () => {
    const first = await ledger.create(request('list-order-first'), randomUUID());
    const second = await ledger.create(request('list-order-second'), randomUUID());
    chain.emit(second, config); await monitor.tick();
    // Make ties explicit so the secondary ID ordering is exercised.
    await pool.query('UPDATE invoices SET created_at=$1', [first.createdAt]);
    const app = await buildApp(ledger, monitor);
    try {
      const headers = { authorization: `Bearer ${config.apiKey}` };
      expect((await app.inject({ url: '/v1/invoices' })).statusCode).toBe(401);
      expect((await app.inject({ url: '/v1/invoices', headers: { authorization: `Bearer ${ledger.merchantView(first).checkoutToken}` } })).statusCode).toBe(401);
      const page = (await app.inject({ url: '/v1/invoices?limit=1', headers })).json();
      expect(page.hasMore).toBe(true); expect(page.invoices).toHaveLength(1);
      expect(page.invoices[0].checkoutToken).toBeUndefined(); expect(page.invoices[0].checkoutUrl).toBeUndefined();
      const next = (await app.inject({ url: '/v1/invoices?limit=1&offset=1', headers })).json();
      expect(next.hasMore).toBe(false); expect(next.invoices[0].id).not.toBe(page.invoices[0].id);
      expect([page.invoices[0].id, next.invoices[0].id]).toEqual([first.id, second.id].sort().reverse());
      const paid = (await app.inject({ url: '/v1/invoices?status=paid&externalOrderId=list-order-second', headers })).json();
      expect(paid.invoices.map((i: { id: string }) => i.id)).toEqual([second.id]);
      expect((await app.inject({ url: '/v1/invoices?externalOrderId=missing', headers })).json().invoices).toEqual([]);
      for (const query of ['limit=101', 'offset=-1', 'status=unknown', 'extra=field'])
        expect((await app.inject({ url: '/v1/invoices?' + query, headers })).statusCode).toBe(400);
      expect((await app.inject({ url: '/checkout/' })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
  it('works without a checkout deployment and gives merchants a scoped checkout token', async () => {
    const apiOnly = new Ledger(pool, { ...config, checkoutUrl: null }, chain);
    const invoice = await apiOnly.create(request(), randomUUID());
    const view = apiOnly.merchantView(invoice);
    expect(view.checkoutUrl).toBeNull(); expect(view.checkoutToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const app = await buildApp(apiOnly, monitor);
    try {
      expect((await app.inject({ url: `/v1/checkout/${invoice.id}`, headers: { authorization: `Bearer ${view.checkoutToken}` } })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
  it('concurrent create retries reserve one address and reject different payloads', async () => {
    const payload = request(); const key = 'same-idempotency-key';
    const invoices = await Promise.all(Array.from({ length: 8 }, () => ledger.create(payload, key)));
    expect(new Set(invoices.map(i => i.id)).size).toBe(1);
    expect((await pool.query('SELECT count(*) FROM receiving_addresses WHERE reserved_invoice_id IS NOT NULL')).rows[0].count).toBe('1');
    chain.fail = true;
    expect((await ledger.create(payload, key)).id).toBe(invoices[0]!.id);
    await expect(ledger.create({ ...payload, amountUnits: '2500001' }, key)).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
  it('same-amount orders receive different addresses and only the paid order gets a voucher', async () => {
    const [one, two] = await Promise.all([ledger.create(request(), randomUUID()), ledger.create(request(), randomUUID())]);
    expect(one.recipient).not.toBe(two.recipient);
    chain.emit(two, config); await monitor.tick();
    expect((await ledger.get(one.id)).status).toBe('pending'); expect((await ledger.get(two.id)).status).toBe('paid');
    await monitor.tick();
    expect((await pool.query('SELECT count(*) FROM vouchers')).rows[0].count).toBe('1');
    expect((await pool.query("SELECT count(*) FROM outbox WHERE event_type='payment.paid'")).rows[0].count).toBe('1');
  });
  it('rolls back paid status, voucher, evidence and cursor when outbox insertion fails, then recovers after restart', async () => {
    const invoice = await ledger.create(request(), randomUUID()); chain.emit(invoice, config);
    await pool.query("CREATE FUNCTION reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated crash'; END $$");
    await pool.query('CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION reject_event()');
    try {
      await expect(monitor.tick()).rejects.toThrow('simulated crash');
      expect((await ledger.get(invoice.id)).status).toBe('pending');
      expect((await ledger.get(invoice.id)).lastScannedBlock).toBe(100n);
      expect((await pool.query('SELECT count(*) FROM vouchers')).rows[0].count).toBe('0');
      expect((await pool.query('SELECT count(*) FROM transfers')).rows[0].count).toBe('0');
    } finally { await pool.query('DROP TRIGGER fail_outbox ON outbox'); await pool.query('DROP FUNCTION reject_event()'); }
    const restarted = new Monitor(pool, config, chain, new Ledger(pool, config, chain));
    await restarted.tick(); expect((await ledger.receipt(invoice.id)).voucher).not.toBeNull();
  });
  it('allows one simultaneous redemption and idempotent replay by the same consumer', async () => {
    const invoice = await ledger.create(request(), randomUUID()); chain.emit(invoice, config); await monitor.tick();
    const voucher = (await ledger.receipt(invoice.id)).voucher!;
    const attempts = await Promise.allSettled(Array.from({ length: 10 }, (_, n) => ledger.redeem(voucher.code, `consumer-${n}`, `redemption-${n}`)));
    const winners = attempts.filter(r => r.status === 'fulfilled'); expect(winners).toHaveLength(1);
    const winnerIndex = attempts.findIndex(r => r.status === 'fulfilled');
    const replay = await ledger.redeem(voucher.code, `consumer-${winnerIndex}`, `redemption-${winnerIndex}`);
    expect(replay.entitlement).toEqual({ product: 'example-access', quantity: 1 });
    expect((await pool.query("SELECT count(*) FROM outbox WHERE event_type='voucher.redeemed'")).rows[0].count).toBe('1');
  });
  it('handles optional vouchers and refuses redemption after voucher expiry', async () => {
    const noVoucher = await ledger.create({ externalOrderId: randomUUID(), amountUnits: '1000000', expiresInSeconds: 60 }, randomUUID());
    chain.emit(noVoucher, config); await monitor.tick(); expect((await ledger.receipt(noVoucher.id)).voucher).toBeNull();
    const withVoucher = await ledger.create(request(), randomUUID()); chain.emit(withVoucher, config); await monitor.tick();
    const voucher = (await ledger.receipt(withVoucher.id)).voucher!;
    await pool.query("UPDATE vouchers SET expires_at=now()-interval '1 second' WHERE id=$1", [voucher.id]);
    await expect(ledger.redeem(voucher.code, 'customer', 'redeem-expired')).rejects.toMatchObject({ code: 'voucher_expired' });
  });
  it.each(['2499999', '2500001'])('records incorrect amount %s for review without a receipt or voucher', async amount => {
    const invoice = await ledger.create(request(), randomUUID()); chain.emit(invoice, config, { amountUnits: amount }); await monitor.tick();
    expect((await ledger.get(invoice.id)).status).toBe('pending');
    await expect(ledger.receipt(invoice.id)).rejects.toMatchObject({ code: 'not_paid' });
    expect((await pool.query('SELECT count(*) FROM vouchers')).rows[0].count).toBe('0');
  });
  it('accepts an on-time transfer finalized after expiry, but flags a late transfer', async () => {
    const ontime = await ledger.create(request(), randomUUID()); const late = await ledger.create(request(), randomUUID());
    await pool.query("UPDATE invoices SET created_at=now()-interval '2 minutes',expires_at=now()-interval '10 seconds' WHERE id=ANY($1::uuid[])", [[ontime.id, late.id]]);
    chain.emit(ontime, config, { blockTime: new Date(Date.now() - 30000) }); chain.emit(late, config);
    await monitor.tick(); expect((await ledger.get(ontime.id)).status).toBe('paid'); expect((await ledger.get(late.id)).status).toBe('expired');
  });
  it('does not advance during RPC outage and detects a changed finalized checkpoint', async () => {
    const invoice = await ledger.create(request(), randomUUID()); chain.emit(invoice, config); chain.fail = true;
    await expect(monitor.tick()).rejects.toThrow(); expect((await ledger.get(invoice.id)).lastScannedBlock).toBe(100n);
    chain.fail = false; await monitor.tick();
    chain.blocks.get(101n)!.hash = '0x' + 'ff'.repeat(32);
    await expect(monitor.tick()).rejects.toThrow('checkpoint changed'); expect(monitor.lastError).toBe('finalized_checkpoint_changed');
    expect((await pool.query('SELECT count(*) FROM vouchers')).rows[0].count).toBe('1');
  });
  it('keeps an already-paid receipt and records an extra transfer without duplicate fulfillment', async () => {
    const invoice = await ledger.create(request(), randomUUID()); chain.emit(invoice, config); await monitor.tick();
    chain.emit(invoice, config); await monitor.tick();
    expect((await ledger.get(invoice.id)).status).toBe('paid');
    expect((await pool.query('SELECT count(*) FROM vouchers')).rows[0].count).toBe('1');
    expect((await pool.query("SELECT disposition FROM transfers WHERE disposition='extra_payment'")).rowCount).toBe(1);
  });
  it('persists authenticated webhook retries and permits explicit retry from the failed queue', async () => {
    const invoice = await ledger.create(request(), randomUUID()); chain.emit(invoice, config); await monitor.tick();
    const deliveries: Array<{ id: string; body: string }> = [];
    let succeed = false;
    const send: typeof fetch = async (_url, init) => {
      const headers = new Headers(init?.headers); const body = String(init?.body);
      expect(verifyWebhook(config.webhookSecret, headers.get('X-Payment-Timestamp')!, body, headers.get('X-Payment-Signature')!)).toBe(true);
      deliveries.push({ id: headers.get('X-Payment-Event-Id')!, body });
      return new Response(null, { status: succeed ? 204 : 503 });
    };
    await new WebhookWorker(pool, { ...config, webhookMaxAttempts: 1 }, send).tick();
    expect((await pool.query('SELECT dead_at FROM outbox')).rows[0].dead_at).not.toBeNull();
    const app = await buildApp(ledger, monitor);
    const retried = await app.inject({ method: 'POST', url: `/v1/events/${deliveries[0]!.id}/retry`, headers: { authorization: `Bearer ${config.apiKey}` } });
    expect(retried.statusCode).toBe(200); succeed = true;
    await new WebhookWorker(pool, config, send).tick();
    expect(deliveries[0]).toEqual(deliveries[1]);
    expect((await pool.query('SELECT delivered_at FROM outbox')).rows[0].delivered_at).not.toBeNull(); await app.close();
  });
  it('does not double-deliver a concurrently claimed event', async () => {
    const invoice = await ledger.create(request(), randomUUID()); chain.emit(invoice, config); await monitor.tick();
    let calls = 0;
    const send: typeof fetch = async () => { calls++; await new Promise(r => setTimeout(r, 50)); return new Response(null, { status: 204 }); };
    await Promise.all([new WebhookWorker(pool, config, send).tick(), new WebhookWorker(pool, config, send).tick()]);
    expect(calls).toBe(1);
  });
  it('enforces HTTP credential scopes and never accepts client assertions that a payment succeeded', async () => {
    const app = await buildApp(ledger, monitor);
    const payload = request(); const headers = { authorization: `Bearer ${config.apiKey}`, 'idempotency-key': randomUUID() };
    expect((await app.inject({ method: 'POST', url: '/v1/invoices', payload })).statusCode).toBe(401);
    const response = await app.inject({ method: 'POST', url: '/v1/invoices', headers, payload }); expect(response.statusCode).toBe(201);
    const invoice = response.json(); const checkoutToken = new URLSearchParams(new URL(invoice.checkoutUrl).hash.slice(1)).get('token');
    const checkout = await app.inject({ method: 'GET', url: `/v1/checkout/${invoice.id}`, headers: { authorization: `Bearer ${checkoutToken}` } });
    expect(checkout.statusCode).toBe(200); expect(checkout.json().externalOrderId).toBeUndefined(); expect(checkout.json().voucher).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: `/v1/invoices/${invoice.id}/receipt`, headers: { authorization: `Bearer ${checkoutToken}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/v1/invoices/${invoice.id}/confirm`, headers, payload: { paid: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/v1/invoices', headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { ...payload, externalOrderId: randomUUID(), amountUnits: '0.5' } })).statusCode).toBe(400);
    await app.close();
  });
  it('refuses changing networks or credential secret on an existing database', async () => {
    await expect(initializeDatabase(pool, { ...config, tokenSecret: 'different'.repeat(8) })).rejects.toThrow('different route');
    await expect(initializeDatabase(pool, { ...config, route: { ...config.route, chainId: 1 } })).rejects.toThrow('different route');
  });
});
