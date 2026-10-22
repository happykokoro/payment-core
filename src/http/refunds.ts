import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ledger } from '../ledger.js';
import { id, key, note, txHash, logIndex, address, amount, pagination } from './schemas.js';
export function refundRoutes(app: FastifyInstance, ledger: Ledger) {
  app.post<{ Params: { id: string } }>('/v1/invoices/:id/refunds', async (r, reply) => {
    const request = note.extend({ sourceTransactionHash: txHash, sourceLogIndex: logIndex, recipient: address, amountUnits: amount,
      redeemedVoucherResolution: z.string().trim().min(10).max(2000).optional() }).strict().parse(r.body);
    return reply.code(201).send(await ledger.refunds.prepare(id.parse(r.params.id), request, key.parse(r.headers['idempotency-key'])));
  });
  app.get<{ Params: { id: string } }>('/v1/invoices/:id/refunds', async r => {
    const invoiceId = id.parse(r.params.id); await ledger.get(invoiceId); const q = pagination.parse(r.query);
    return { refunds: (await ledger.pool.query('SELECT * FROM refunds WHERE invoice_id=$1 ORDER BY prepared_at,id LIMIT $2 OFFSET $3', [invoiceId, q.limit, q.offset])).rows, ...q };
  });
  app.post<{ Params: { id: string } }>('/v1/refunds/:id/record', async r => {
    const data = note.extend({ transactionHash: txHash, logIndex }).strict().parse(r.body);
    return ledger.refunds.record(id.parse(r.params.id), data.transactionHash, data.logIndex, data, key.parse(r.headers['idempotency-key']));
  });
  app.post<{ Params: { id: string } }>('/v1/refunds/:id/cancel', async r => ledger.refunds.cancel(id.parse(r.params.id), note.extend({ fundsNotSent: z.literal(true) }).strict().parse(r.body), key.parse(r.headers['idempotency-key'])));
}
