/** Cancellation and transfer review never rewrite chain evidence or manufacture a receipt. */
import type { Pool } from 'pg';
import { command, audit, type OperatorNote } from '../operations.js';
import { enqueue } from '../events.js';
import { PaymentError } from '../domain.js';
export class ExceptionService {
  constructor(private pool: Pool) {}
  cancel(invoiceId: string, note: OperatorNote, key: string) {
    return command(this.pool, 'invoice.cancel', key, { invoiceId, ...note }, async client => {
      const invoice = (await client.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [invoiceId])).rows[0];
      if (!invoice) throw new PaymentError('not_found', 'Invoice not found', 404);
      if (invoice.status === 'paid') throw new PaymentError('already_paid', 'A settled payment requires a refund workflow', 409);
      if (invoice.status !== 'cancelled') {
        await client.query("UPDATE invoices SET status='cancelled',cancelled_at=now() WHERE id=$1", [invoiceId]);
        await audit(client, invoiceId, 'invoice.cancelled', note);
        await enqueue(client, invoiceId, 'invoice.cancelled', { invoiceId });
      }
      return { invoiceId, status: 'cancelled' };
    });
  }
  review(invoiceId: string, transactionHash: string, logIndex: number, resolution: 'acknowledged' | 'refund_required', note: OperatorNote, key: string) {
    return command(this.pool, 'transfer.review', key, { invoiceId, transactionHash, logIndex, resolution, ...note }, async client => {
      const transfer = (await client.query('SELECT * FROM transfers WHERE invoice_id=$1 AND transaction_hash=$2 AND log_index=$3 FOR UPDATE', [invoiceId, transactionHash, logIndex])).rows[0];
      if (!transfer) throw new PaymentError('transfer_not_found', 'Recorded transfer not found', 404);
      if (transfer.disposition === 'accepted') throw new PaymentError('accepted_payment', 'Use the refund workflow for an accepted payment', 409);
      const old = await client.query('SELECT 1 FROM transfer_reviews WHERE route_id=$1 AND transaction_hash=$2 AND log_index=$3', [transfer.route_id, transactionHash, logIndex]);
      if (old.rowCount) throw new PaymentError('already_reviewed', 'This transfer already has a recorded resolution', 409);
      await client.query('INSERT INTO transfer_reviews(route_id,transaction_hash,log_index,resolution,actor,reason) VALUES($1,$2,$3,$4,$5,$6)',
        [transfer.route_id, transactionHash, logIndex, resolution, note.actor, note.reason]);
      await audit(client, invoiceId, 'transfer.reviewed', note, { transactionHash, logIndex, resolution });
      await enqueue(client, invoiceId, 'payment.reviewed', { invoiceId, transactionHash, logIndex, resolution });
      return { invoiceId, transactionHash, logIndex, resolution };
    });
  }
}
