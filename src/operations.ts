/** Idempotent merchant commands and audit entries share the business transaction. */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { canonicalJson, hash } from './crypto.js';
import { transaction } from './database.js';
import { PaymentError } from './domain.js';
export interface OperatorNote { actor: string; reason: string }
export async function command<T>(pool: Pool, kind: string, key: string, request: unknown, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const fingerprint = hash(canonicalJson(request));
  return transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`command:${key}`]);
    const old = (await client.query('SELECT * FROM operations WHERE idempotency_key=$1', [key])).rows[0];
    if (old) {
      if (old.kind !== kind || old.request_hash !== fingerprint) throw new PaymentError('idempotency_conflict', 'Command key was used for a different request', 409);
      return old.result as T;
    }
    const result = await work(client);
    await client.query('INSERT INTO operations(idempotency_key,kind,request_hash,result) VALUES($1,$2,$3,$4)', [key, kind, fingerprint, JSON.stringify(result)]);
    return result;
  });
}
/** Fetch external evidence before taking business locks, then recheck idempotency/state in the transaction. */
export async function verifiedCommand<T, E>(pool: Pool, kind: string, key: string, request: unknown, verify: () => Promise<E>, work: (client: PoolClient, evidence: E) => Promise<T>): Promise<T> {
  const old = (await pool.query('SELECT kind,request_hash,result FROM operations WHERE idempotency_key=$1', [key])).rows[0];
  if (old) {
    if (old.kind !== kind || old.request_hash !== hash(canonicalJson(request))) throw new PaymentError('idempotency_conflict', 'Command key was used for a different request', 409);
    return old.result as T;
  }
  const evidence = await verify();
  return command(pool, kind, key, request, client => work(client, evidence));
}
export async function audit(client: PoolClient, invoiceId: string | null, action: string, note: OperatorNote, details: unknown = {}) {
  await client.query('INSERT INTO audit_log(id,invoice_id,action,actor,reason,details) VALUES($1,$2,$3,$4,$5,$6)',
    [randomUUID(), invoiceId, action, note.actor, note.reason, JSON.stringify(details)]);
}
