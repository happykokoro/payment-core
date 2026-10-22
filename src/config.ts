/** Validated deployment configuration; exactly one allowlisted route per database. */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { getAddress, isAddress, zeroAddress } from 'viem';
import type { Route } from './domain.js';

const integer = (fallback: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(fallback);
const schema = z.object({
  HOST: z.string().default('127.0.0.1'), PORT: integer(4004, 1, 65535),
  CHECKOUT_URL: z.union([z.url(), z.literal('')]).optional(), DATABASE_URL: z.string().startsWith('postgres'),
  API_KEY: z.string().min(32), TOKEN_SECRET: z.string().min(32), WEBHOOK_SECRET: z.string().min(32),
  TOKEN_SECRET_PREVIOUS: z.string().default('[]'),
  WEBHOOK_URL: z.url(), PAYMENT_NETWORK: z.enum(['base-sepolia', 'base']).default('base-sepolia'),
  ALLOW_MAINNET: z.enum(['true', 'false']).default('false'), RPC_URL: z.url(),
  RECEIVE_ADDRESSES: z.string().min(1), POLL_INTERVAL_MS: integer(5000, 1000, 60000),
  SCAN_BLOCK_RANGE: integer(200, 1, 2000), INVOICE_BATCH_SIZE: integer(20, 1, 100),
  LATE_PAYMENT_WINDOW_SECONDS: integer(604800, 3600, 2592000), WEBHOOK_MAX_ATTEMPTS: integer(8, 1, 20),
  HEALTH_STALE_SECONDS: integer(120, 10, 3600), HEALTH_SCAN_LAG_BLOCKS: integer(2000, 1, 100000),
  HEALTH_WEBHOOK_AGE_SECONDS: integer(300, 10, 86400), ADDRESS_POOL_LOW: integer(5, 0, 10000)
});
export interface Config {
  host: string; port: number; checkoutUrl: string | null; databaseUrl: string; apiKey: string;
  tokenSecret: string; webhookSecret: string; webhookUrl: string; rpcUrl: string; route: Route;
  addresses: string[]; pollIntervalMs: number; scanBlockRange: number; invoiceBatchSize: number;
  latePaymentWindowSeconds: number; webhookMaxAttempts: number;
  previousTokenSecrets: string[]; healthStaleSeconds: number; healthScanLagBlocks: number;
  healthWebhookAgeSeconds: number; addressPoolLow: number;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration fields: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`);
  const e = parsed.data;
  let previousTokenSecrets: string[];
  try { previousTokenSecrets = z.array(z.string().min(32)).max(5).parse(JSON.parse(e.TOKEN_SECRET_PREVIOUS)); }
  catch { throw new Error('Invalid configuration field: TOKEN_SECRET_PREVIOUS (JSON array, at most five keys)'); }
  if (previousTokenSecrets.some(s => s === e.API_KEY || s === e.WEBHOOK_SECRET)) throw new Error('Credential keys must be separate from API and webhook keys');
  if (new Set([e.API_KEY, e.TOKEN_SECRET, e.WEBHOOK_SECRET]).size !== 3) throw new Error('Use different configuration secrets for API, credentials and webhooks');
  const routes = JSON.parse(readFileSync(new URL('../config/routes.json', import.meta.url), 'utf8')) as Record<string, Route>;
  const route = routes[e.PAYMENT_NETWORK]!;
  if (!route.testnet && e.ALLOW_MAINNET !== 'true') throw new Error('Mainnet requires ALLOW_MAINNET=true');
  for (const value of [e.CHECKOUT_URL, e.WEBHOOK_URL, e.RPC_URL].filter((v): v is string => Boolean(v))) {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('URLs must use HTTP(S) without embedded credentials');
    if (!route.testnet && u.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('Mainnet remote endpoints must use HTTPS');
  }
  if (e.CHECKOUT_URL && (new URL(e.CHECKOUT_URL).search || new URL(e.CHECKOUT_URL).hash)) throw new Error('CHECKOUT_URL must not include a query or fragment');
  const addresses = [...new Set(e.RECEIVE_ADDRESSES.split(',').map(a => a.trim()))];
  if (addresses.length > 10000 || addresses.some(a => !isAddress(a, { strict: false }) || a.toLowerCase() === zeroAddress)) throw new Error('Provide 1–10000 valid receiving addresses');
  return {
    host: e.HOST, port: e.PORT, checkoutUrl: e.CHECKOUT_URL || null, databaseUrl: e.DATABASE_URL,
    apiKey: e.API_KEY, tokenSecret: e.TOKEN_SECRET, webhookSecret: e.WEBHOOK_SECRET, webhookUrl: e.WEBHOOK_URL,
    rpcUrl: e.RPC_URL, route, addresses: addresses.map(a => getAddress(a).toLowerCase()),
    pollIntervalMs: e.POLL_INTERVAL_MS, scanBlockRange: e.SCAN_BLOCK_RANGE, invoiceBatchSize: e.INVOICE_BATCH_SIZE,
    latePaymentWindowSeconds: e.LATE_PAYMENT_WINDOW_SECONDS, webhookMaxAttempts: e.WEBHOOK_MAX_ATTEMPTS,
    previousTokenSecrets, healthStaleSeconds: e.HEALTH_STALE_SECONDS, healthScanLagBlocks: e.HEALTH_SCAN_LAG_BLOCKS,
    healthWebhookAgeSeconds: e.HEALTH_WEBHOOK_AGE_SECONDS, addressPoolLow: e.ADDRESS_POOL_LOW
  };
}
