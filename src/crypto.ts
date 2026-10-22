/** Opaque checkout/voucher credentials and stable webhook signatures. Secrets stay outside SQL. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
export function credential(secret: string, purpose: 'checkout' | 'voucher', id: string, generation = 0): string {
  return createHmac('sha256', secret).update(`${purpose}:${id}${generation ? `:${generation}` : ''}`).digest('base64url');
}
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}
export function verifyWebhook(secret: string, timestamp: string, rawBody: string, signature: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!/^\d+$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false;
  return constantTimeEqual(signWebhook(secret, timestamp, rawBody), signature);
}
