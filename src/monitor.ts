/** Bounded polling with durable cursors. RPC errors never advance an invoice checkpoint. */
import type { Pool } from 'pg';
import type { ChainHead, PaymentChain } from './chain.js';
import type { Config } from './config.js';
import { Ledger } from './ledger.js';

export class Monitor {
  lastSuccess: Date | null = null;
  lastError: string | null = null;
  lastHead: ChainHead | null = null;
  private halted = false;
  constructor(private pool: Pool, private config: Config, private chain: PaymentChain, private ledger: Ledger) {}
  async tick(): Promise<void> {
    if (this.halted) throw new Error('Finalized checkpoint changed; operator reconciliation required');
    const lock = await this.pool.connect();
    let acquired = false;
    try {
      acquired = (await lock.query('SELECT pg_try_advisory_lock(87462002) AS acquired')).rows[0].acquired;
      if (!acquired) return;
      const head = await this.chain.finalizedHead();
      this.lastHead = head;
      const invoices = await this.ledger.pending();
      for (const invoice of invoices) {
        // Update scheduling separately: one unavailable invoice must not monopolize every batch.
        await this.ledger.checked(invoice.id);
        if (invoice.lastScannedBlock > head.number) throw new Error('RPC finalized head is behind the saved checkpoint');
        if (invoice.lastScannedHash) {
          const savedBlock = await this.chain.block(invoice.lastScannedBlock);
          if (savedBlock.hash !== invoice.lastScannedHash) {
            this.halted = true;
            throw new Error('Finalized checkpoint changed; operator reconciliation required');
          }
        }
        if (invoice.lastScannedBlock === head.number) continue;
        const limit = invoice.lastScannedBlock + BigInt(this.config.scanBlockRange);
        const end = limit < head.number ? limit : head.number;
        const checkpoint = await this.chain.block(end);
        const transfers = await this.chain.transfers(invoice.recipient, invoice.lastScannedBlock + 1n, end);
        if ((await this.chain.block(end)).hash !== checkpoint.hash || (await this.chain.block(head.number)).hash !== head.hash) {
          throw new Error('Finalized chain changed during scan');
        }
        await this.ledger.applyBatch(invoice.id, invoice.lastScannedBlock, transfers, checkpoint);
      }
      this.lastSuccess = new Date(); this.lastError = null;
    } catch (error) {
      this.lastError = this.halted ? 'finalized_checkpoint_changed' : 'verification_unavailable';
      throw error;
    } finally {
      let discard = false;
      try { if (acquired) await lock.query('SELECT pg_advisory_unlock(87462002)'); }
      catch (error) { discard = true; throw error; }
      finally { lock.release(discard); }
    }
  }
}
