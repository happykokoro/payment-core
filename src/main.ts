/** One HTTP service with independent bounded verification and outbox workers. */
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { createPool, initializeDatabase } from './database.js';
import { EvmUsdcChain } from './chain.js';
import { Ledger } from './ledger.js';
import { Monitor } from './monitor.js';
import { WebhookWorker } from './webhooks.js';
import { buildApp } from './api.js';
import { ObservationWorker } from './observations.js';

async function start() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  pool.on('error', () => console.error('Idle database connection failed; the next operation will reconnect.'));
  const chain = new EvmUsdcChain(config.route, config.rpcUrl);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await chain.validate();
    await initializeDatabase(pool, config);
    const ledger = new Ledger(pool, config, chain);
    const monitor = new Monitor(pool, config, chain, ledger);
    const webhooks = new WebhookWorker(pool, config);
    const observations = new ObservationWorker(pool, config, chain);
    app = await buildApp(ledger, monitor, true, { webhooks, observations });
    const abort = new AbortController();
    const run = async (name: string, job: () => Promise<void>) => {
      while (!abort.signal.aborted) {
        try { await job(); } catch { app!.log.error({ worker: name, code: name === 'monitor' ? monitor.lastError : name === 'observations' ? observations.lastError : webhooks.lastError }, 'Background work failed; state retained for retry'); }
        try { await delay(config.pollIntervalMs, undefined, { signal: abort.signal }); } catch { break; }
      }
    };
    const workers = [run('monitor', () => monitor.tick()), run('webhooks', () => webhooks.tick()), run('observations', () => observations.tick())];
    app.addHook('onClose', async () => { abort.abort(); await Promise.all(workers); await pool.end(); });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app!.close(); });
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    if (app) await app.close(); else await pool.end();
    throw error;
  }
}
start().catch(error => { console.error(error instanceof Error && /configuration|Mainnet|Database belongs|receiving|URLs/.test(error.message) ? error.message : 'Startup failed. Check database, route configuration and RPC availability.'); process.exitCode = 1; });
