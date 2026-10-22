import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Transfer } from './domain.js';
export function paymentProof(t: Transfer) {
  return { transactionHash: t.transactionHash, logIndex: t.logIndex, blockNumber: t.blockNumber.toString(),
    blockHash: t.blockHash, blockTime: t.blockTime.toISOString(), token: t.token, recipient: t.recipient,
    sender: t.sender, amountUnits: t.amountUnits, routeId: t.routeId };
}
export async function enqueue(client: PoolClient, invoiceId: string, type: string, data: unknown): Promise<void> {
  const id = randomUUID();
  const body = JSON.stringify({ id, type, createdAt: new Date().toISOString(), data });
  await client.query('INSERT INTO outbox(id,invoice_id,event_type,body) VALUES($1,$2,$3,$4)', [id, invoiceId, type, body]);
}
