/** Invoice creation, read models and scan scheduling. */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import type { PaymentChain } from '../chain.js';
import { canonicalJson, credential, hash } from '../crypto.js';
import { PaymentError, type Invoice, type PaymentRequest, type PaymentStatus } from '../domain.js';
import { transaction, toInvoice, type InvoiceRow } from '../database.js';
import { CredentialService } from './credentials.js';

export class InvoiceService {
  constructor(readonly pool: Pool, readonly config: Config, private chain: PaymentChain) {}
  async create(request: PaymentRequest, idempotencyKey: string): Promise<Invoice> {
    const fingerprint = hash(canonicalJson(request));
    const retry = await this.pool.query<InvoiceRow>('SELECT * FROM invoices WHERE idempotency_key=$1', [idempotencyKey]);
    if (retry.rows[0]) return this.replay(retry.rows[0], fingerprint);
    const head = await this.chain.finalizedHead();
    return transaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`create:${idempotencyKey}`]);
      const existing = await client.query<InvoiceRow>('SELECT * FROM invoices WHERE idempotency_key=$1', [idempotencyKey]);
      if (existing.rows[0]) return this.replay(existing.rows[0], fingerprint);
      await new CredentialService(this.pool, this.config).assertActive(client);
      const external = await client.query('SELECT id FROM invoices WHERE external_order_id=$1', [request.externalOrderId]);
      if (external.rowCount) throw new PaymentError('order_exists', 'External order ID already exists', 409);
      const address = await client.query<{ address: string }>('SELECT address FROM receiving_addresses WHERE reserved_invoice_id IS NULL ORDER BY address LIMIT 1 FOR UPDATE SKIP LOCKED');
      if (!address.rows[0]) throw new PaymentError('address_pool_empty', 'Add unused receiving addresses before creating more requests', 409);
      const clock = await client.query<{ now: Date }>("SELECT date_trunc('second',clock_timestamp()) AS now");
      const createdAt = clock.rows[0]!.now;
      const expiresAt = new Date(createdAt.getTime() + request.expiresInSeconds * 1000);
      const monitorUntil = new Date(expiresAt.getTime() + this.config.latePaymentWindowSeconds * 1000);
      const id = randomUUID();
      const rows = await client.query<InvoiceRow>(`INSERT INTO invoices
        (id,external_order_id,idempotency_key,request_hash,route_id,amount_units,recipient,status,created_at,expires_at,monitor_until,last_scanned_block,last_scanned_hash,voucher_spec)
        VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11,$12,$13) RETURNING *`,
      [id, request.externalOrderId, idempotencyKey, fingerprint, this.config.route.id, request.amountUnits, address.rows[0].address,
        createdAt, expiresAt, monitorUntil, head.number.toString(), head.hash, request.voucher ? JSON.stringify(request.voucher) : null]);
      await client.query('UPDATE receiving_addresses SET reserved_invoice_id=$1 WHERE address=$2', [id, address.rows[0].address]);
      return toInvoice(rows.rows[0]!);
    });
  }
  private replay(row: InvoiceRow, fingerprint: string): Invoice {
    if (row.request_hash !== fingerprint) throw new PaymentError('idempotency_conflict', 'Idempotency key was used for a different request', 409);
    return toInvoice(row);
  }
  async get(id: string): Promise<Invoice> {
    const r = await this.pool.query<InvoiceRow>('SELECT * FROM invoices WHERE id=$1', [id]);
    if (!r.rows[0]) throw new PaymentError('not_found', 'Payment request not found', 404);
    return toInvoice(r.rows[0]);
  }
  async list(query: { limit: number; offset: number; status?: PaymentStatus; externalOrderId?: string }) {
    const rows = await this.pool.query<InvoiceRow>(`SELECT * FROM invoices
      WHERE ($1::text IS NULL OR status=$1) AND ($2::text IS NULL OR external_order_id=$2)
      ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`,
    [query.status ?? null, query.externalOrderId ?? null, query.limit + 1, query.offset]);
    return { invoices: rows.rows.slice(0, query.limit).map(row => {
      const invoice = toInvoice(row);
      return { ...this.publicView(invoice), externalOrderId: invoice.externalOrderId };
    }), limit: query.limit, offset: query.offset, hasMore: rows.rows.length > query.limit };
  }
  publicView(invoice: Invoice) {
    return { id: invoice.id, status: invoice.status, amountUnits: invoice.amountUnits, recipient: invoice.recipient,
      createdAt: invoice.createdAt.toISOString(), expiresAt: invoice.expiresAt.toISOString(), route: this.config.route,
      paymentUri: `ethereum:${this.config.route.token}@${this.config.route.chainId}/transfer?address=${invoice.recipient}&uint256=${invoice.amountUnits}`,
      voucherEnabled: invoice.voucher !== null };
  }
  merchantView(invoice: Invoice) {
    const checkoutToken = credential(this.config.tokenSecret, 'checkout', invoice.id);
    return { ...this.publicView(invoice), externalOrderId: invoice.externalOrderId,
      checkoutToken, checkoutUrl: this.config.checkoutUrl ? `${this.config.checkoutUrl}#id=${invoice.id}&token=${checkoutToken}` : null };
  }
  async receipt(id: string) {
    const invoice = await this.get(id);
    if (invoice.status !== 'paid') throw new PaymentError('not_paid', 'No successful payment receipt is available', 409);
    const transfers = await this.pool.query("SELECT transaction_hash,log_index,block_number,block_hash,block_time,amount_units,sender FROM transfers WHERE invoice_id=$1 AND disposition='accepted' LIMIT 1", [id]);
    const vouchers = await this.pool.query('SELECT id,entitlement,expires_at,redeemed_at,redeemed_by,key_fingerprint,generation,frozen_at,revoked_at FROM vouchers WHERE invoice_id=$1 LIMIT 1', [id]);
    const voucher = vouchers.rows[0];
    return { ...this.merchantView(invoice), payment: transfers.rows[0], voucher: voucher ? {
      id: voucher.id, code: await new CredentialService(this.pool, this.config).voucherCode(voucher), entitlement: voucher.entitlement,
      expiresAt: voucher.expires_at, redeemedAt: voucher.redeemed_at, redeemedBy: voucher.redeemed_by,
      frozenAt: voucher.frozen_at, revokedAt: voucher.revoked_at
    } : null };
  }
  async pending(): Promise<Invoice[]> {
    const r = await this.pool.query<InvoiceRow>('SELECT * FROM invoices WHERE NOT monitoring_complete ORDER BY last_checked_at,id LIMIT $1', [this.config.invoiceBatchSize]);
    const ids = r.rows.map(row => row.id);
    await this.pool.query("UPDATE invoices SET status='expired' WHERE id=ANY($1::uuid[]) AND status='pending' AND expires_at<=now()", [ids]);
    return r.rows.map(toInvoice);
  }
  async checked(id: string): Promise<void> {
    await this.pool.query('UPDATE invoices SET last_checked_at=now() WHERE id=$1', [id]);
  }
}
