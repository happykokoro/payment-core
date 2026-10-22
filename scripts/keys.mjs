import { randomBytes } from 'node:crypto';
for (const name of ['API_KEY', 'TOKEN_SECRET', 'WEBHOOK_SECRET']) console.log(`${name}=${randomBytes(32).toString('hex')}`);
