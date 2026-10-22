/** Advisory progress only. This worker cannot issue a receipt, change payment status or enqueue fulfillment. */
import type { Pool } from 'pg';
import type { Config } from './config.js';
import type { PaymentChain } from './chain.js';
import { transaction, toInvoice, type InvoiceRow } from './database.js';
export class ObservationWorker {
  lastSuccess: Date | null = null;
  lastError: string | null = null;
  constructor(private pool: Pool, private config: Config, private chain: PaymentChain) {}
  async tick() {
    try {
      const head = await this.chain.latestHead();
      const rows = await this.pool.query<InvoiceRow & { observed_block: string | null; observed_hash: string | null }>(`SELECT i.*,c.block_number AS observed_block,c.block_hash AS observed_hash
        FROM invoices i LEFT JOIN observation_cursors c ON c.invoice_id=i.id WHERE NOT i.monitoring_complete
        AND i.status IN ('pending','expired') ORDER BY coalesce(c.checked_at,'epoch'),i.id LIMIT $1`, [this.config.invoiceBatchSize]);
      for (const row of rows.rows) {
        const invoice = toInvoice(row);
        let previous = row.observed_block ? BigInt(row.observed_block) : invoice.lastScannedBlock;
        let reset = previous > head.number || previous < invoice.lastScannedBlock;
        if (!reset && row.observed_hash) reset = (await this.chain.block(previous)).hash !== row.observed_hash;
        if (reset) previous = invoice.lastScannedBlock;
        const saved = await this.pool.query('SELECT block_number,block_hash FROM payment_observations WHERE invoice_id=$1', [invoice.id]);
        for (const candidate of saved.rows) {
          const number = BigInt(candidate.block_number);
          if (number <= invoice.lastScannedBlock || number > head.number || (await this.chain.block(number)).hash !== candidate.block_hash) {
            await this.pool.query('DELETE FROM payment_observations WHERE invoice_id=$1 AND block_number=$2', [invoice.id, candidate.block_number]);
          } else await this.pool.query('UPDATE payment_observations SET checked_at=now() WHERE invoice_id=$1 AND block_number=$2', [invoice.id, candidate.block_number]);
        }
        const end = previous + BigInt(this.config.scanBlockRange) < head.number ? previous + BigInt(this.config.scanBlockRange) : head.number;
        if (end < previous) continue;
        const checkpoint = await this.chain.block(end);
        const transfers = end > previous ? await this.chain.transfers(invoice.recipient, previous + 1n, end) : [];
        if ((await this.chain.block(end)).hash !== checkpoint.hash) throw new Error('Observation chain changed');
        await transaction(this.pool, async client => {
          if (reset) await client.query('DELETE FROM payment_observations WHERE invoice_id=$1', [invoice.id]);
          for (const t of transfers) {
            if (t.amountUnits !== invoice.amountUnits || t.blockTime < invoice.createdAt || t.blockTime >= invoice.expiresAt) continue;
            await client.query(`INSERT INTO payment_observations(invoice_id,transaction_hash,log_index,block_number,block_hash) VALUES($1,$2,$3,$4,$5)
              ON CONFLICT(invoice_id,transaction_hash,log_index) DO UPDATE SET block_number=excluded.block_number,block_hash=excluded.block_hash,checked_at=now()`,
              [invoice.id, t.transactionHash, t.logIndex, t.blockNumber.toString(), t.blockHash]);
          }
          await client.query(`INSERT INTO observation_cursors(invoice_id,block_number,block_hash) VALUES($1,$2,$3)
            ON CONFLICT(invoice_id) DO UPDATE SET block_number=excluded.block_number,block_hash=excluded.block_hash,checked_at=now()`, [invoice.id, end.toString(), checkpoint.hash]);
        });
      }
      this.lastSuccess = new Date(); this.lastError = null;
    } catch (error) { this.lastError = 'observation_unavailable'; throw error; }
  }
}
export async function paymentProgress(pool: Pool, invoiceId: string, staleSeconds: number) {
  const rows = await pool.query('SELECT transaction_hash,checked_at FROM payment_observations WHERE invoice_id=$1 ORDER BY block_number,log_index LIMIT 5', [invoiceId]);
  const fresh = rows.rows.filter(r => Date.now() - r.checked_at.getTime() <= staleSeconds * 1000);
  return { state: fresh.length ? 'confirming' : rows.rowCount ? 'verification_delayed' : 'awaiting_payment', transactionHashes: fresh.map(r => r.transaction_hash) };
}
