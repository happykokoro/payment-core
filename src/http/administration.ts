import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ledger } from '../ledger.js';
import type { HealthService } from '../health.js';
import { PaymentError } from '../domain.js';
import { id, key, note, pagination } from './schemas.js';
export function administrationRoutes(app: FastifyInstance, ledger: Ledger, health: HealthService) {
  app.get('/v1/operations/health', () => health.inspect());
  app.get<{ Params: { id: string } }>('/v1/invoices/:id/audit', async r => {
    const invoiceId = id.parse(r.params.id); await ledger.get(invoiceId); const q = pagination.parse(r.query);
    return { entries: (await ledger.pool.query('SELECT * FROM audit_log WHERE invoice_id=$1 ORDER BY created_at,id LIMIT $2 OFFSET $3', [invoiceId, q.limit, q.offset])).rows, ...q };
  });
  app.get('/v1/credentials/keys', async () => ({ keys: (await ledger.pool.query('SELECT * FROM credential_keys ORDER BY created_at')).rows, active: ledger.credentials.fingerprint }));
  app.post<{ Params: { fingerprint: string } }>('/v1/credentials/keys/:fingerprint/revoke', async r => ledger.credentials.revoke(z.string().regex(/^[a-f0-9]{64}$/).parse(r.params.fingerprint), note.strict().parse(r.body), key.parse(r.headers['idempotency-key'])));
  app.post<{ Params: { id: string } }>('/v1/invoices/:id/credentials/reissue', async r => ledger.credentials.reissue(id.parse(r.params.id), note.strict().parse(r.body), key.parse(r.headers['idempotency-key'])));
  app.get('/v1/events', async r => {
    const q = pagination.parse(r.query);
    const result = await ledger.pool.query(`SELECT id,invoice_id,event_type,attempts,created_at,next_attempt_at,delivered_at,dead_at,last_error
      FROM outbox ORDER BY created_at,id LIMIT $1 OFFSET $2`, [q.limit, q.offset]);
    return { events: result.rows, ...q };
  });
  app.post<{ Params: { id: string } }>('/v1/events/:id/retry', async r => {
    const result = await ledger.pool.query(`UPDATE outbox SET attempts=0,dead_at=NULL,next_attempt_at=now(),last_error=NULL
      WHERE id=$1 AND dead_at IS NOT NULL AND delivered_at IS NULL AND (lease_until IS NULL OR lease_until<now()) RETURNING id`, [id.parse(r.params.id)]);
    if (!result.rows[0]) throw new PaymentError('event_not_retryable', 'Event is not in the failed-delivery queue', 409);
    return { id: result.rows[0].id, queued: true };
  });
}
