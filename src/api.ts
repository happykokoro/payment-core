/** HTTP composition, authentication and error handling. Business workflows live in services/. */
import Fastify, { type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { constantTimeEqual } from './crypto.js';
import { PaymentError } from './domain.js';
import type { Ledger } from './ledger.js';
import type { Monitor } from './monitor.js';
import { HealthService } from './health.js';
import { invoiceRoutes } from './http/invoices.js';
import { checkoutRoutes } from './http/checkout.js';
import { refundRoutes } from './http/refunds.js';
import { administrationRoutes } from './http/administration.js';
export async function buildApp(ledger: Ledger, monitor: Monitor, logger = false, workers: Record<string, { lastSuccess: Date | null; lastError: string | null }> = {}) {
  const app = Fastify({ logger: logger ? { redact: ['req.headers.authorization', 'req.headers.cookie'] } : false,
    bodyLimit: 16384, requestTimeout: 20000, connectionTimeout: 10000 });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute', cache: 10000 });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof PaymentError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'invalid_request', message: 'Request fields failed validation', fields: error.issues.map(i => i.path.join('.')) } });
    if (error instanceof Error && 'code' in error && error.code === '23505') return reply.code(409).send({ error: { code: 'conflict', message: 'A unique payment identifier already exists' } });
    const status = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 503;
    return reply.code(status).send({ error: { code: status < 500 ? 'invalid_request' : 'service_unavailable', message: status < 500 ? 'Request could not be accepted' : 'Service temporarily unavailable; retry with the same idempotency key' } });
  });
  const health = new HealthService(ledger.pool, ledger.config, monitor, workers);
  app.get('/health', async (_request, reply) => {
    const report = await health.inspect();
    return reply.code(report.status === 'ok' ? 200 : 503).send({ status: report.status });
  });
  checkoutRoutes(app, ledger);
  await app.register(async merchant => {
    merchant.addHook('preHandler', async (request: FastifyRequest) => {
      if (!constantTimeEqual(request.headers.authorization ?? '', `Bearer ${ledger.config.apiKey}`)) throw new PaymentError('unauthorized', 'Merchant API key required', 401);
    });
    invoiceRoutes(merchant, ledger);
    refundRoutes(merchant, ledger);
    administrationRoutes(merchant, ledger, health);
  });
  return app;
}
