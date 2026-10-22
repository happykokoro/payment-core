/** Refund preparation reserves an amount. Recording requires independently verified chain evidence. */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { PaymentChain } from '../chain.js';
import type { Config } from '../config.js';
import { PaymentError } from '../domain.js';
import { command, verifiedCommand, audit, type OperatorNote } from '../operations.js';
import { enqueue, paymentProof } from '../events.js';
export interface RefundRequest extends OperatorNote {
  sourceTransactionHash: string; sourceLogIndex: number; amountUnits: string; recipient: string;
  redeemedVoucherResolution?: string;
}
export class RefundService {
  constructor(private pool: Pool, private config: Config, private chain: PaymentChain) {}
  prepare(invoiceId: string, request: RefundRequest, key: string) {
    return command(this.pool, 'refund.prepare', key, { invoiceId, ...request }, async client => {
      const invoice = (await client.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [invoiceId])).rows[0];
      if (!invoice) throw new PaymentError('not_found', 'Invoice not found', 404);
      const source = (await client.query('SELECT * FROM transfers WHERE invoice_id=$1 AND transaction_hash=$2 AND log_index=$3', [invoiceId, request.sourceTransactionHash, request.sourceLogIndex])).rows[0];
      if (!source || BigInt(source.amount_units) <= 0n) throw new PaymentError('source_not_found', 'A positive recorded incoming transfer is required', 409);
      if ((await client.query('SELECT 1 FROM receiving_addresses WHERE address=$1', [request.recipient])).rowCount) throw new PaymentError('refund_destination', 'Refund destination must be a customer-controlled address outside the receiving pool', 409);
      const reserved = (await client.query("SELECT coalesce(sum(amount_units),0)::text AS amount FROM refunds WHERE invoice_id=$1 AND source_transaction_hash=$2 AND source_log_index=$3 AND status<>'cancelled'", [invoiceId, request.sourceTransactionHash, request.sourceLogIndex])).rows[0].amount;
      if (BigInt(request.amountUnits) <= 0n || BigInt(reserved) + BigInt(request.amountUnits) > BigInt(source.amount_units)) throw new PaymentError('refund_exceeds_payment', 'Prepared and recorded refunds cannot exceed the incoming transfer', 409);
      if (source.disposition === 'accepted') {
        const voucher = (await client.query('SELECT * FROM vouchers WHERE invoice_id=$1 FOR UPDATE', [invoiceId])).rows[0];
        if (voucher?.redeemed_at && !request.redeemedVoucherResolution) throw new PaymentError('redeemed_voucher', 'Record how the already-delivered entitlement was handled before approving a refund', 409);
        if (voucher) await client.query('UPDATE vouchers SET frozen_at=coalesce(frozen_at,now()) WHERE id=$1', [voucher.id]);
      }
      const id = randomUUID();
      await client.query("INSERT INTO refunds(id,invoice_id,route_id,source_transaction_hash,source_log_index,amount_units,recipient,status) VALUES($1,$2,$3,$4,$5,$6,$7,'prepared')",
        [id, invoiceId, this.config.route.id, request.sourceTransactionHash, request.sourceLogIndex, request.amountUnits, request.recipient]);
      await audit(client, invoiceId, 'refund.prepared', request, { refundId: id, ...request });
      await enqueue(client, invoiceId, 'refund.prepared', { invoiceId, refundId: id, amountUnits: request.amountUnits, affectsEntitlement: source.disposition === 'accepted' });
      return { id, invoiceId, status: 'prepared', amountUnits: request.amountUnits, recipient: request.recipient, sender: invoice.recipient };
    });
  }
  async record(refundId: string, transactionHash: string, logIndex: number, note: OperatorNote, key: string) {
    // Retry a committed command without requiring RPC availability again.
    return verifiedCommand(this.pool, 'refund.record', key, { refundId, transactionHash, logIndex, ...note },
      () => this.chain.finalizedTransfer(transactionHash, logIndex), async (client, proof) => {
      const refund = await this.lock(client, refundId);
      if (refund.status !== 'prepared') throw new PaymentError('refund_state', 'Only a prepared refund can be recorded', 409);
      if (proof.routeId !== refund.route_id || proof.token.toLowerCase() !== this.config.route.token.toLowerCase()
        || proof.recipient !== refund.recipient || proof.sender !== refund.sender || proof.amountUnits !== refund.amount_units
        || proof.blockTime < refund.prepared_at) throw new PaymentError('refund_proof_mismatch', 'Transfer must match the approved route, token, sender, destination, amount and preparation time', 409);
      await client.query("UPDATE refunds SET status='recorded',recorded_at=now(),transaction_hash=$2,log_index=$3,proof=$4 WHERE id=$1", [refundId, transactionHash, logIndex, JSON.stringify(paymentProof(proof))]);
      if (refund.disposition === 'accepted') await client.query('UPDATE vouchers SET revoked_at=coalesce(revoked_at,now()) WHERE invoice_id=$1', [refund.invoice_id]);
      await audit(client, refund.invoice_id, 'refund.recorded', note, { refundId, payment: paymentProof(proof) });
      await enqueue(client, refund.invoice_id, 'refund.recorded', { invoiceId: refund.invoice_id, refundId, affectsEntitlement: refund.disposition === 'accepted', payment: paymentProof(proof) });
      return { id: refundId, status: 'recorded', transactionHash, logIndex };
    });
  }
  cancel(refundId: string, note: OperatorNote, key: string) {
    return command(this.pool, 'refund.cancel', key, { refundId, ...note }, async client => {
      const refund = await this.lock(client, refundId);
      if (refund.status !== 'prepared') throw new PaymentError('refund_state', 'Only an unsent prepared refund can be cancelled', 409);
      await client.query("UPDATE refunds SET status='cancelled',cancelled_at=now() WHERE id=$1", [refundId]);
      const outstanding = await client.query("SELECT 1 FROM refunds r JOIN transfers t ON t.route_id=r.route_id AND t.transaction_hash=r.source_transaction_hash AND t.log_index=r.source_log_index WHERE r.invoice_id=$1 AND r.status<>'cancelled' AND t.disposition='accepted'", [refund.invoice_id]);
      if (!outstanding.rowCount) await client.query('UPDATE vouchers SET frozen_at=NULL WHERE invoice_id=$1 AND revoked_at IS NULL', [refund.invoice_id]);
      await audit(client, refund.invoice_id, 'refund.cancelled', note, { refundId });
      await enqueue(client, refund.invoice_id, 'refund.cancelled', { invoiceId: refund.invoice_id, refundId, affectsEntitlement: refund.disposition === 'accepted' });
      return { id: refundId, status: 'cancelled' };
    });
  }
  private async lock(client: PoolClient, refundId: string) {
    const found = (await client.query('SELECT invoice_id FROM refunds WHERE id=$1', [refundId])).rows[0];
    if (!found) throw new PaymentError('refund_not_found', 'Refund not found', 404);
    await client.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE', [found.invoice_id]);
    return (await client.query(`SELECT r.*,i.recipient AS sender,t.disposition FROM refunds r JOIN invoices i ON i.id=r.invoice_id
      JOIN transfers t ON t.route_id=r.route_id AND t.transaction_hash=r.source_transaction_hash AND t.log_index=r.source_log_index WHERE r.id=$1 FOR UPDATE OF r`, [refundId])).rows[0];
  }
}
