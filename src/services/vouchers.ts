/** Voucher redemption has its own transaction and concurrency boundary. */
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import { hash } from '../crypto.js';
import { PaymentError } from '../domain.js';
import { transaction } from '../database.js';
import { enqueue } from '../events.js';

export class VoucherService {
  constructor(readonly pool: Pool, readonly config: Config) {}
  async redeem(code: string, redeemedBy: string, redemptionKey: string) {
    return transaction(this.pool, async client => {
      const result = await client.query('SELECT * FROM vouchers WHERE code_hash=$1 FOR UPDATE', [hash(code)]);
      const voucher = result.rows[0];
      if (!voucher) throw new PaymentError('voucher_not_found', 'Voucher not found', 404);
      const key = (await client.query('SELECT revoked_at FROM credential_keys WHERE fingerprint=$1 FOR SHARE', [voucher.key_fingerprint])).rows[0];
      if (!key || key.revoked_at) throw new PaymentError('credential_revoked', 'Voucher credential must be reissued by the merchant', 410);
      if (voucher.frozen_at || voucher.revoked_at) throw new PaymentError('voucher_unavailable', 'Voucher is frozen or revoked because of a refund', 409);
      if (voucher.redeemed_at) {
        if (voucher.redemption_key !== redemptionKey || voucher.redeemed_by !== redeemedBy) throw new PaymentError('voucher_redeemed', 'Voucher has already been redeemed', 409);
        return { id: voucher.id, entitlement: voucher.entitlement, redeemedBy: voucher.redeemed_by, redeemedAt: voucher.redeemed_at };
      }
      const updated = await client.query(`UPDATE vouchers SET redeemed_at=clock_timestamp(),redeemed_by=$2,redemption_key=$3
        WHERE id=$1 AND redeemed_at IS NULL AND expires_at>clock_timestamp() RETURNING *`, [voucher.id, redeemedBy, redemptionKey]);
      if (!updated.rows[0]) throw new PaymentError('voucher_expired', 'Voucher has expired', 410);
      const redeemed = updated.rows[0];
      await enqueue(client, voucher.invoice_id, 'voucher.redeemed', { invoiceId: voucher.invoice_id, voucherId: voucher.id, redeemedBy });
      return { id: voucher.id, entitlement: voucher.entitlement, redeemedBy, redeemedAt: redeemed.redeemed_at };
    });
  }
}
