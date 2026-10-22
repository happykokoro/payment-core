// Development example only. Production consumers must persist event-ID deduplication.
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
const secret = process.env.WEBHOOK_SECRET;
if (!secret || secret.length < 32) throw new Error('Set WEBHOOK_SECRET');
createServer(async (request, response) => {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 65536) { response.writeHead(413).end(); return; } chunks.push(chunk); }
  const body = Buffer.concat(chunks);
  const timestamp = String(request.headers['x-payment-timestamp'] ?? '');
  const signature = String(request.headers['x-payment-signature'] ?? '');
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now()/1000-Number(timestamp))>300 || !/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature),Buffer.from(expected))) { response.writeHead(401).end(); return; }
  const event = JSON.parse(body.toString('utf8'));
  console.log(`Received ${event.type}; event ID ${event.id}`);
  response.writeHead(204).end();
}).listen(4005,'127.0.0.1',()=>console.log('Development webhook receiver on http://127.0.0.1:4005/events'));
