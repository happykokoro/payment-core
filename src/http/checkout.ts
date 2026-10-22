import type { FastifyInstance } from 'fastify';
import type { Ledger } from '../ledger.js';
import { PaymentError } from '../domain.js';
import { paymentProgress } from '../observations.js';
import { id, txHash } from './schemas.js';
export function checkoutRoutes(app: FastifyInstance, ledger: Ledger) {
  const authorized = async (invoiceId: string, authorization = '') => {
    if (!await ledger.credentials.verifyCheckout(invoiceId, authorization)) throw new PaymentError('unauthorized', 'Checkout credential required', 401);
    return ledger.get(invoiceId);
  };
  app.get<{ Params: { id: string } }>('/v1/checkout/:id', async r => {
    const invoice = await authorized(id.parse(r.params.id), r.headers.authorization);
    return { ...ledger.publicView(invoice), progress: await paymentProgress(ledger.pool, invoice.id, ledger.config.healthStaleSeconds) };
  });
  app.get<{ Params: { id: string; hash: string } }>('/v1/checkout/:id/transactions/:hash', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async r => {
    const invoice = await authorized(id.parse(r.params.id), r.headers.authorization);
    return ledger.paymentChain.transactionStatus(invoice, txHash.parse(r.params.hash));
  });
}
