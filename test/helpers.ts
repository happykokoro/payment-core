import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import type { Config } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import type { ChainHead, PaymentChain } from '../src/chain.js';
import type { Invoice, Transfer } from '../src/domain.js';

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
export function testConfig(databaseUrl: string): Config {
  return loadConfig({ DATABASE_URL: databaseUrl, API_KEY: 'test-api-key-'.repeat(4), TOKEN_SECRET: 'test-token-key-'.repeat(4),
    WEBHOOK_SECRET: 'test-webhook-key-'.repeat(4), WEBHOOK_URL: 'http://127.0.0.1:4005/events', CHECKOUT_URL: 'http://127.0.0.1:4006/checkout/',
    RPC_URL: 'http://127.0.0.1:8545', RECEIVE_ADDRESSES: Array.from({ length: 20 }, (_, n) => `0x${(n + 1000).toString(16).padStart(40, '0')}`).join(',') });
}
/** Real PostgreSQL. An external test server may be used; only a fresh test schema is changed. */
export async function databaseFixture() {
  let embedded: EmbeddedPostgres | undefined;
  let directory: string | undefined;
  let connectionString = process.env.TEST_DATABASE_URL;
  const root = path.resolve('.local');
  if (!connectionString) {
    await mkdir(root, { recursive: true });
    directory = path.join(root, `test-postgres-${randomUUID()}`);
    const port = await freePort();
    embedded = new EmbeddedPostgres({ databaseDir: directory, port, user: 'postgres', password: 'local-test-password',
      persistent: true, authMethod: 'scram-sha-256', initdbFlags: ['--encoding=UTF8', '--locale=C'],
      postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: () => {} });
    await embedded.initialise(); await embedded.start();
    connectionString = `postgresql://postgres:local-test-password@127.0.0.1:${port}/postgres`;
  }
  let admin = new Pool({ connectionString });
  const schema = `payments_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(connectionString);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return { url: url.toString(), async coldRestore() {
    if (!embedded || !directory) throw new Error('Cold restore drill requires the isolated embedded cluster');
    const restoredDirectory = path.join(root, `test-postgres-restore-${randomUUID()}`);
    // Only copy a cleanly stopped cluster. Never back up live PostgreSQL by copying files.
    await admin.end();
    await embedded.stop();
    try { await cp(directory, restoredDirectory, { recursive: true, force: false, errorOnExist: true }); }
    finally { await embedded.start(); admin = new Pool({ connectionString }); }
    const port = await freePort();
    const restored = new EmbeddedPostgres({ databaseDir: restoredDirectory, port, user: 'postgres', password: 'local-test-password',
      persistent: true, postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: () => {} });
    await restored.start();
    const restoredUrl = new URL(url); restoredUrl.port = String(port);
    return { url: restoredUrl.toString(), async close() {
      await restored.stop();
      const target = path.resolve(restoredDirectory);
      if (!target.startsWith(root + path.sep) || !path.basename(target).startsWith('test-postgres-restore-')) throw new Error('Unsafe restore directory cleanup');
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } };
  }, async close() {
    if (!/^payments_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test schema cleanup');
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    if (embedded) await embedded.stop();
    if (directory) {
      const target = path.resolve(directory);
      if (!target.startsWith(root + path.sep) || !path.basename(target).startsWith('test-postgres-')) throw new Error('Unsafe test directory cleanup');
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  } };
}
/** Deterministic chain evidence for application failure tests; adapter tests use actual EVM RPC. */
export class FixtureChain implements PaymentChain {
  head = 100n;
  blocks = new Map<bigint, ChainHead>([[100n, { number: 100n, hash: '0x' + '01'.repeat(32), timestamp: new Date(Date.now() - 60000) }]]);
  evidence: Transfer[] = [];
  fail = false;
  async validate() {}
  async finalizedHead() { if (this.fail) throw new Error('RPC unavailable'); return this.blocks.get(this.head)!; }
  async latestHead() { return this.finalizedHead(); }
  transactionState: 'unknown' | 'pending' | 'confirming' | 'review' | 'failed' | 'not_payment' = 'unknown';
  async transactionStatus(_invoice: Invoice, _hash: string) { if (this.fail) throw new Error('RPC unavailable'); return { state: this.transactionState }; }
  async finalizedTransfer(hash: string, logIndex: number) {
    if (this.fail) throw new Error('RPC unavailable');
    const transfer = this.evidence.find(t => t.transactionHash === hash && t.logIndex === logIndex && t.blockNumber <= this.head);
    if (!transfer) throw new Error('No finalized transfer');
    return transfer;
  }
  async block(number: bigint) { if (this.fail) throw new Error('RPC unavailable'); const block = this.blocks.get(number); if (!block) throw new Error('Missing fixture block'); return block; }
  async transfers(recipient: string, from: bigint, to: bigint) {
    if (this.fail) throw new Error('RPC unavailable');
    return this.evidence.filter(t => t.recipient === recipient && t.blockNumber >= from && t.blockNumber <= to);
  }
  emit(invoice: Invoice, config: Config, overrides: Partial<Transfer> = {}): Transfer {
    this.head++;
    const block = { number: this.head, hash: `0x${this.head.toString(16).padStart(64, '0')}`, timestamp: new Date(Date.now() + 1000) };
    const transfer: Transfer = { routeId: config.route.id, token: config.route.token.toLowerCase(), recipient: invoice.recipient,
      sender: '0x' + 'ab'.repeat(20), amountUnits: invoice.amountUnits, transactionHash: `0x${randomUUID().replaceAll('-', '').padEnd(64, '0')}`,
      logIndex: 0, blockNumber: this.head, blockHash: block.hash, blockTime: block.timestamp, ...overrides };
    block.timestamp = transfer.blockTime;
    this.blocks.set(this.head, block); this.evidence.push(transfer); return transfer;
  }
}
