/** Versioned credential keys; secrets stay in configuration, revocations stay in PostgreSQL. */
import type { Pool, PoolClient } from 'pg';
import type { Config } from '../config.js';
import { constantTimeEqual, credential, hash } from '../crypto.js';
import { PaymentError } from '../domain.js';
import { command, audit, type OperatorNote } from '../operations.js';
export class CredentialService {
  readonly fingerprint: string;
  private keys: Map<string, string>;
  constructor(private pool: Pool, private config: Config) {
    this.fingerprint = hash(config.tokenSecret);
    this.keys = new Map([config.tokenSecret, ...config.previousTokenSecrets].map(s => [hash(s), s]));
  }
  async assertActive(client: PoolClient) {
    const row = (await client.query('SELECT revoked_at FROM credential_keys WHERE fingerprint=$1 FOR SHARE', [this.fingerprint])).rows[0];
    const active = (await client.query('SELECT credential_fingerprint FROM deployment_settings WHERE id=1')).rows[0];
    if (!row || row.revoked_at || active?.credential_fingerprint !== this.fingerprint) throw new PaymentError('credential_key_inactive', 'Restart with the active credential key', 503);
  }
  async verifyCheckout(invoiceId: string, authorization: string): Promise<boolean> {
    const { rows } = await this.pool.query('SELECT fingerprint FROM credential_keys WHERE revoked_at IS NULL');
    return rows.some(row => {
      const secret = this.keys.get(row.fingerprint);
      return secret !== undefined && constantTimeEqual(authorization, `Bearer ${credential(secret, 'checkout', invoiceId)}`);
    });
  }
  async voucherCode(row: { id: string; key_fingerprint: string; generation: number; revoked_at: Date | null }): Promise<string | null> {
    const secret = this.keys.get(row.key_fingerprint);
    if (!secret || row.revoked_at) return null;
    const key = (await this.pool.query('SELECT revoked_at FROM credential_keys WHERE fingerprint=$1', [row.key_fingerprint])).rows[0];
    return key && !key.revoked_at ? credential(secret, 'voucher', row.id, row.generation) : null;
  }
  revoke(fingerprint: string, note: OperatorNote, key: string) {
    return command(this.pool, 'credential.revoke', key, { fingerprint, ...note }, async client => {
      await client.query('SELECT pg_advisory_xact_lock(87462001)');
      await this.assertActive(client);
      if (fingerprint === this.fingerprint) throw new PaymentError('active_key', 'Rotate to a new key before revoking the old key', 409);
      const row = (await client.query('UPDATE credential_keys SET revoked_at=coalesce(revoked_at,now()) WHERE fingerprint=$1 RETURNING fingerprint', [fingerprint])).rows[0];
      if (!row) throw new PaymentError('key_not_found', 'Credential key not found', 404);
      await audit(client, null, 'credential.revoked', note, { fingerprint });
      return { fingerprint, revoked: true };
    });
  }
  reissue(invoiceId: string, note: OperatorNote, key: string) {
    return command(this.pool, 'credential.reissue', key, { invoiceId, ...note }, async client => {
      const invoice = (await client.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE', [invoiceId])).rows[0];
      if (!invoice) throw new PaymentError('not_found', 'Invoice not found', 404);
      const voucher = (await client.query('SELECT * FROM vouchers WHERE invoice_id=$1 FOR UPDATE', [invoiceId])).rows[0];
      await this.assertActive(client);
      if (voucher) {
        if (voucher.redeemed_at || voucher.frozen_at || voucher.revoked_at) throw new PaymentError('voucher_unavailable', 'Redeemed, refund-frozen or revoked vouchers cannot be reissued', 409);
        const generation = voucher.generation + 1;
        await client.query('UPDATE vouchers SET key_fingerprint=$2,generation=$3,code_hash=$4 WHERE id=$1',
          [voucher.id, this.fingerprint, generation, hash(credential(this.config.tokenSecret, 'voucher', voucher.id, generation))]);
      }
      await audit(client, invoiceId, 'credential.reissued', note, { fingerprint: this.fingerprint, voucherId: voucher?.id ?? null });
      return { invoiceId, reissued: true };
    });
  }
}
