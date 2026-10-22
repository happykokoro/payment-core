/** At-least-once webhook delivery with leases, bounded retry and stable event IDs. */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Config } from './config.js';
import { signWebhook } from './crypto.js';
import { transaction } from './database.js';

export class WebhookWorker {
  lastSuccess: Date | null = null;
  lastError: string | null = null;
  constructor(private pool: Pool, private config: Config, private send: typeof fetch = fetch) {}
  async tick(): Promise<void> {
    try { await this.deliver(); this.lastSuccess = new Date(); this.lastError = null; }
    catch (error) { this.lastError = 'delivery_worker_unavailable'; throw error; }
  }
  private async deliver(): Promise<void> {
    const owner = randomUUID();
    const events = await transaction(this.pool, async client => {
      await client.query(`UPDATE outbox SET dead_at=now(),last_error='attempt_limit' WHERE delivered_at IS NULL AND dead_at IS NULL
        AND attempts >= $1 AND (lease_until IS NULL OR lease_until<now())`, [this.config.webhookMaxAttempts]);
      const result = await client.query(`WITH due AS (
        SELECT id FROM outbox WHERE delivered_at IS NULL AND dead_at IS NULL AND next_attempt_at<=now()
          AND (lease_until IS NULL OR lease_until<now()) AND attempts<$1 ORDER BY next_attempt_at LIMIT 5 FOR UPDATE SKIP LOCKED
        ) UPDATE outbox SET lease_until=now()+interval '2 minutes',lease_owner=$2,attempts=attempts+1
          FROM due WHERE outbox.id=due.id RETURNING outbox.id,outbox.body,outbox.attempts`, [this.config.webhookMaxAttempts, owner]);
      return result.rows as Array<{ id: string; body: string; attempts: number }>;
    });
    for (const event of events) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      let failure: string | null = null;
      try {
        const response = await this.send(this.config.webhookUrl, { method: 'POST', redirect: 'error',
          signal: AbortSignal.timeout(10000), body: event.body, headers: {
            'Content-Type': 'application/json', 'X-Payment-Event-Id': event.id, 'X-Payment-Timestamp': timestamp,
            'X-Payment-Signature': signWebhook(this.config.webhookSecret, timestamp, event.body)
          } });
        if (!response.ok) failure = `http_${response.status}`;
        await response.body?.cancel();
      } catch { failure = 'delivery_unavailable'; }
      if (failure === null) {
        await this.pool.query('UPDATE outbox SET delivered_at=now(),lease_until=NULL,lease_owner=NULL,last_error=NULL WHERE id=$1 AND lease_owner=$2', [event.id, owner]);
      } else {
        const delaySeconds = Math.min(3600, 5 * 2 ** (event.attempts - 1));
        await this.pool.query(`UPDATE outbox SET last_error=$3,lease_until=NULL,lease_owner=NULL,
          next_attempt_at=now()+$4*interval '1 second',dead_at=CASE WHEN attempts >= $5 THEN now() ELSE NULL END
          WHERE id=$1 AND lease_owner=$2`, [event.id, owner, failure, delaySeconds, this.config.webhookMaxAttempts]);
      }
    }
  }
}
