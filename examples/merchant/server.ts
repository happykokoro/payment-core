/** Runnable example: configure a separate MERCHANT_DATABASE_URL and matching webhook secret(s). */
import { createServer } from 'node:http';
import { createPool } from '../../src/database.js';
import { consumeEvent, initializeMerchant } from './consumer.js';
const url = process.env.MERCHANT_DATABASE_URL;
const current = process.env.WEBHOOK_SECRET;
if (!url || !current || current.length < 32) throw new Error('Set MERCHANT_DATABASE_URL and WEBHOOK_SECRET');
const previous = process.env.WEBHOOK_SECRET_PREVIOUS;
const secrets = previous ? [current, previous] : [current];
const pool = createPool(url);
await initializeMerchant(pool);
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/events') { response.writeHead(404).end(); return; }
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 16384) { response.writeHead(413).end(); request.destroy(); return; }
      chunks.push(Buffer.from(chunk));
    }
    const header = (name: string) => typeof request.headers[name] === 'string' ? request.headers[name] as string : '';
    await consumeEvent(pool, secrets, Buffer.concat(chunks).toString('utf8'), header('x-payment-timestamp'), header('x-payment-signature'), header('x-payment-event-id'));
    response.writeHead(204).end();
  } catch { response.writeHead(400).end('Event not committed; retry with the same event ID'); }
});
server.requestTimeout = 15000;
server.listen(Number(process.env.MERCHANT_PORT ?? 4005), '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { void pool.end(); }));
