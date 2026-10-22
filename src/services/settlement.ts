/** Atomic finalized payment admission, voucher issuance and outbox writes. */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import type { ChainHead } from '../chain.js';
import { credential, hash } from '../crypto.js';
import { classifyTransfer, PaymentError, type Transfer } from '../domain.js';
import { transaction, toInvoice, type InvoiceRow } from '../database.js';
import { enqueue, paymentProof } from '../events.js';
import { CredentialService } from './credentials.js';

export class SettlementService {
  constructor(readonly pool: Pool, readonly config: Config) {}
  async applyBatch(id: string, previousBlock: bigint, transfers: Transfer[], checkpoint: ChainHead): Promise<void> {
    await transaction(this.pool, async client => {
      const result = await client.query<InvoiceRow>('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [id]);
      if (!result.rows[0]) throw new PaymentError('not_found', 'Payment request not found', 404);
      const invoice = toInvoice(result.rows[0]);
      if (invoice.lastScannedBlock !== previousBlock) return; // Another committed scan won; its cursor is authoritative.
      if (checkpoint.number <= previousBlock) throw new Error('Scan checkpoint must advance');
      for (const transfer of transfers) {
        if (transfer.blockNumber <= previousBlock || transfer.blockNumber > checkpoint.number) throw new Error('Transfer outside scan range');
        const disposition = classifyTransfer(invoice, transfer, this.config.route);
        if (disposition === 'wrong_asset' || disposition === 'wrong_recipient') throw new Error('Adapter supplied transfer outside invoice scope');
        const inserted = await client.query(`INSERT INTO transfers
          (route_id,transaction_hash,log_index,invoice_id,token,recipient,sender,amount_units,block_number,block_hash,block_time,disposition)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING transaction_hash`,
        [transfer.routeId, transfer.transactionHash, transfer.logIndex, id, transfer.token, transfer.recipient, transfer.sender,
          transfer.amountUnits, transfer.blockNumber.toString(), transfer.blockHash, transfer.blockTime, disposition]);
        if (!inserted.rowCount || disposition === 'before_invoice') continue;
        if (disposition === 'accepted') {
          invoice.status = 'paid';
          await client.query("UPDATE invoices SET status='paid',paid_at=now() WHERE id=$1", [id]);
          let voucherId: string | null = null;
          if (invoice.voucher) {
            await new CredentialService(this.pool, this.config).assertActive(client);
            voucherId = randomUUID();
            await client.query(`INSERT INTO vouchers(id,invoice_id,code_hash,entitlement,expires_at,key_fingerprint) VALUES($1,$2,$3,$4,clock_timestamp()+$5*interval '1 second',$6)`,
            [voucherId, id, hash(credential(this.config.tokenSecret, 'voucher', voucherId)), JSON.stringify(invoice.voucher.entitlement), invoice.voucher.validForSeconds, hash(this.config.tokenSecret)]);
          }
          await enqueue(client, id, 'payment.paid', { invoiceId: id, externalOrderId: invoice.externalOrderId,
            status: 'paid', payment: paymentProof(transfer), voucherId });
        } else {
          await enqueue(client, id, 'payment.review_required', { invoiceId: id, externalOrderId: invoice.externalOrderId,
            reason: disposition, payment: paymentProof(transfer) });
        }
      }
      await client.query(`UPDATE invoices SET last_scanned_block=$2,last_scanned_hash=$3,last_checked_at=now(),monitoring_complete=$4 WHERE id=$1`,
        [id, checkpoint.number.toString(), checkpoint.hash, checkpoint.timestamp >= invoice.monitorUntil]);
    });
  }
}
