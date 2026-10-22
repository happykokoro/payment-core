/** Small server-side merchant client. Never bundle a merchant API key into a browser. */
import { verifyWebhook } from './crypto.js';
import type { PaymentRequest } from './domain.js';
import type { OperatorNote } from './operations.js';
import type { RefundRequest } from './services/refunds.js';
export { verifyWebhook };
export class PaymentClient {
  constructor(private baseUrl: string, private apiKey: string) {}
  async request(path: string, method = 'GET', body?: unknown, idempotencyKey?: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, { method,
      signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error('Payment API request failed'), { status: response.status, result });
    return result;
  }
  createPayment(payment: PaymentRequest, idempotencyKey: string) { return this.request('/v1/invoices', 'POST', payment, idempotencyKey); }
  getPayment(id: string) { return this.request(`/v1/invoices/${encodeURIComponent(id)}`); }
  listPayments(query: { limit?: number; offset?: number; status?: import('./domain.js').PaymentStatus; externalOrderId?: string } = {}) {
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    return this.request(`/v1/invoices?${params}`);
  }
  getReceipt(id: string) { return this.request(`/v1/invoices/${encodeURIComponent(id)}/receipt`); }
  redeemVoucher(code: string, redeemedBy: string, idempotencyKey: string) { return this.request('/v1/vouchers/redeem', 'POST', { code, redeemedBy }, idempotencyKey); }
  cancelPayment(id: string, note: OperatorNote, idempotencyKey: string) { return this.request(`/v1/invoices/${encodeURIComponent(id)}/cancel`, 'POST', note, idempotencyKey); }
  prepareRefund(id: string, refund: RefundRequest, idempotencyKey: string) { return this.request(`/v1/invoices/${encodeURIComponent(id)}/refunds`, 'POST', refund, idempotencyKey); }
  recordRefund(id: string, transactionHash: string, logIndex: number, note: OperatorNote, idempotencyKey: string) { return this.request(`/v1/refunds/${encodeURIComponent(id)}/record`, 'POST', { transactionHash, logIndex, ...note }, idempotencyKey); }
  cancelRefund(id: string, note: OperatorNote & { fundsNotSent: true }, idempotencyKey: string) { return this.request(`/v1/refunds/${encodeURIComponent(id)}/cancel`, 'POST', note, idempotencyKey); }
}
