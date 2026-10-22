/** Readiness is derived from worker freshness and persisted work, not database reachability alone. */
import type { Pool } from 'pg';
import type { Config } from './config.js';
import type { Monitor } from './monitor.js';
type Worker = { lastSuccess: Date | null; lastError: string | null };
export class HealthService {
  constructor(private pool: Pool, private config: Config, private monitor: Monitor, private workers: Record<string, Worker> = {}) {}
  async inspect() {
    const alerts: string[] = [];
    for (const [name, worker] of Object.entries({ monitor: this.monitor, ...this.workers })) {
      if (worker.lastError || !worker.lastSuccess || Date.now() - worker.lastSuccess.getTime() > this.config.healthStaleSeconds * 1000) alerts.push(`${name}_unavailable`);
    }
    const { rows } = await this.pool.query(`SELECT
      (SELECT count(*)::int FROM receiving_addresses WHERE reserved_invoice_id IS NULL) AS addresses,
      (SELECT count(*)::int FROM outbox WHERE delivered_at IS NULL AND dead_at IS NOT NULL) AS dead_events,
      (SELECT count(*)::int FROM outbox WHERE delivered_at IS NULL AND created_at<now()-$1*interval '1 second') AS old_events,
      (SELECT min(last_scanned_block)::text FROM invoices WHERE NOT monitoring_complete) AS oldest_checkpoint`, [this.config.healthWebhookAgeSeconds]);
    const metrics = rows[0];
    const lag = this.monitor.lastHead && metrics.oldest_checkpoint ? this.monitor.lastHead.number - BigInt(metrics.oldest_checkpoint) : 0n;
    if (lag > BigInt(this.config.healthScanLagBlocks)) alerts.push('scan_behind');
    if (metrics.dead_events) alerts.push('webhook_dead_letters');
    if (metrics.old_events) alerts.push('webhook_delivery_delayed');
    if (metrics.addresses <= this.config.addressPoolLow) alerts.push('receiving_addresses_low');
    return { status: alerts.length ? 'degraded' : 'ok', alerts, metrics: { availableAddresses: metrics.addresses,
      deadEvents: metrics.dead_events, oldEvents: metrics.old_events, scanLagBlocks: lag.toString() },
      verification: { lastSuccess: this.monitor.lastSuccess, error: this.monitor.lastError } };
  }
}
