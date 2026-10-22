/** Durable reference consumer. Event receipt and local entitlement change commit together. */
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { z } from 'zod';
import { hash, verifyWebhook } from '../../src/crypto.js';
import { transaction } from '../../src/database.js';
const eventSchema = z.object({ id: z.uuid(), type: z.string(), data: z.object({ invoiceId: z.uuid(), voucherId: z.uuid().nullable().optional() }).passthrough() });
export async function initializeMerchant(pool: Pool) {
  await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
}
export async function consumeEvent(pool: Pool, secrets: string[], rawBody: string, timestamp: string, signature: string, eventId: string) {
  if (!secrets.some(secret => verifyWebhook(secret, timestamp, rawBody, signature))) throw new Error('Invalid webhook signature');
  const event = eventSchema.parse(JSON.parse(rawBody));
  if (event.id !== eventId) throw new Error('Event header and payload disagree');
  return transaction(pool, async client => {
    // Serialize order effects, including refund-before-payment delivery.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`merchant:${event.data.invoiceId}`]);
    const inserted = await client.query('INSERT INTO merchant_events(id,body_hash) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id', [event.id, hash(rawBody)]);
    if (!inserted.rowCount) {
      const previous = (await client.query('SELECT body_hash FROM merchant_events WHERE id=$1', [event.id])).rows[0];
      if (previous.body_hash !== hash(rawBody)) throw new Error('Reused event ID with different bytes');
      return { duplicate: true };
    }
    if (event.type === 'refund.recorded' && event.data.affectsEntitlement === true) {
      await client.query('INSERT INTO merchant_refund_holds(invoice_id) VALUES($1) ON CONFLICT DO NOTHING', [event.data.invoiceId]);
      await client.query('UPDATE merchant_entitlements SET active=false WHERE invoice_id=$1', [event.data.invoiceId]);
    }
    const grant = event.type === 'voucher.redeemed' || (event.type === 'payment.paid' && event.data.voucherId === null);
    if (grant) await client.query(`INSERT INTO merchant_entitlements(invoice_id,active)
      SELECT $1,NOT EXISTS(SELECT 1 FROM merchant_refund_holds WHERE invoice_id=$1) ON CONFLICT DO NOTHING`, [event.data.invoiceId]);
    return { duplicate: false };
  });
}
