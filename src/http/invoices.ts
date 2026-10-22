import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ledger } from '../ledger.js';
import { id, key, note, txHash, logIndex, pagination, paymentSchema } from './schemas.js';
export function invoiceRoutes(app: FastifyInstance, ledger: Ledger) {
  app.get('/v1/invoices', async request => ledger.list(pagination.extend({
    status: z.enum(['pending', 'expired', 'paid', 'needs_review', 'cancelled']).optional(),
    externalOrderId: z.string().trim().min(1).max(128).optional()
  }).strict().parse(request.query)));
  app.post('/v1/invoices', async (request, reply) => {
    const invoice = await ledger.create(paymentSchema.parse(request.body), key.parse(request.headers['idempotency-key']));
    return reply.code(201).send(ledger.merchantView(invoice));
  });
  app.get<{ Params: { id: string } }>('/v1/invoices/:id', async r => ledger.merchantView(await ledger.get(id.parse(r.params.id))));
  app.get<{ Params: { id: string } }>('/v1/invoices/:id/receipt', async r => ledger.receipt(id.parse(r.params.id)));
  app.post<{ Params: { id: string } }>('/v1/invoices/:id/cancel', async r => ledger.exceptions.cancel(id.parse(r.params.id), note.strict().parse(r.body), key.parse(r.headers['idempotency-key'])));
  app.get<{ Params: { id: string } }>('/v1/invoices/:id/transfers', async r => {
    const invoiceId = id.parse(r.params.id); await ledger.get(invoiceId);
    const query = pagination.parse(r.query);
    const rows = await ledger.pool.query(`SELECT t.transaction_hash,t.log_index,t.amount_units,t.block_number,t.block_time,t.sender,t.disposition,r.resolution,r.resolved_at
      FROM transfers t LEFT JOIN transfer_reviews r USING(route_id,transaction_hash,log_index)
      WHERE invoice_id=$1 ORDER BY block_number,log_index LIMIT $2 OFFSET $3`, [invoiceId, query.limit, query.offset]);
    return { transfers: rows.rows, ...query };
  });
  app.post<{ Params: { id: string } }>('/v1/invoices/:id/reviews', async r => {
    const data = note.extend({ transactionHash: txHash, logIndex, resolution: z.enum(['acknowledged', 'refund_required']) }).strict().parse(r.body);
    return ledger.exceptions.review(id.parse(r.params.id), data.transactionHash, data.logIndex, data.resolution, data, key.parse(r.headers['idempotency-key']));
  });
  app.post('/v1/vouchers/redeem', async r => {
    const data = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/), redeemedBy: z.string().trim().min(1).max(128) }).strict().parse(r.body);
    return ledger.redeem(data.code, data.redeemedBy, key.parse(r.headers['idempotency-key']));
  });
}
