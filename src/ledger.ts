/** Compatibility facade: composition only; each workflow lives in a focused service. */
import type { Pool } from 'pg';
import type { Config } from './config.js';
import type { PaymentChain } from './chain.js';
import { InvoiceService } from './services/invoices.js';
import { SettlementService } from './services/settlement.js';
import { VoucherService } from './services/vouchers.js';
import { CredentialService } from './services/credentials.js';
import { ExceptionService } from './services/exceptions.js';
import { RefundService } from './services/refunds.js';
export class Ledger extends InvoiceService {
  readonly settlement: SettlementService;
  readonly vouchers: VoucherService;
  readonly credentials: CredentialService;
  readonly exceptions: ExceptionService;
  readonly refunds: RefundService;
  readonly paymentChain: PaymentChain;
  constructor(pool: Pool, config: Config, chain: PaymentChain) {
    super(pool, config, chain);
    this.settlement = new SettlementService(pool, config);
    this.vouchers = new VoucherService(pool, config);
    this.credentials = new CredentialService(pool, config);
    this.exceptions = new ExceptionService(pool);
    this.refunds = new RefundService(pool, config, chain);
    this.paymentChain = chain;
  }
  applyBatch(...args: Parameters<SettlementService['applyBatch']>) { return this.settlement.applyBatch(...args); }
  redeem(...args: Parameters<VoucherService['redeem']>) { return this.vouchers.redeem(...args); }
}
