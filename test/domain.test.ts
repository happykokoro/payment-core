import { describe, it, expect } from 'vitest';
import { classifyTransfer, type Invoice, type Transfer } from '../src/domain.js';
import { constantTimeEqual, credential, signWebhook, verifyWebhook, canonicalJson } from '../src/crypto.js';
const route = { id: 'base:usdc', chainId: 8453, token: '0xtoken', symbol: 'USDC', name: 'Base', decimals: 6, testnet: false };
const invoice: Invoice = { id: 'a', externalOrderId: 'order', routeId: route.id, recipient: '0xreceiver', amountUnits: '1000000', status: 'pending',
  createdAt: new Date('2026-01-01T00:00:00Z'), expiresAt: new Date('2026-01-01T01:00:00Z'), monitorUntil: new Date('2026-01-02T00:00:00Z'), lastScannedBlock: 0n, lastScannedHash: null, voucher: null };
const transfer: Transfer = { routeId: route.id, token: route.token, recipient: invoice.recipient, amountUnits: '1000000', sender: 'sender',
  transactionHash: 'tx', logIndex: 0, blockNumber: 1n, blockHash: 'block', blockTime: new Date('2026-01-01T00:10:00Z') };
describe('payment admission', () => {
  it('accepts exact on-time evidence even when finality arrives after expiry', () => {
    expect(classifyTransfer({ ...invoice, status: 'expired' }, transfer, route)).toBe('accepted');
  });
  it.each([
    [{ routeId: 'another-network:usdc' }, 'wrong_asset'], [{ token: 'counterfeit' }, 'wrong_asset'],
    [{ recipient: 'someone-else' }, 'wrong_recipient'], [{ amountUnits: '999999' }, 'wrong_amount'],
    [{ amountUnits: '1000001' }, 'wrong_amount'], [{ blockTime: invoice.expiresAt }, 'late'],
    [{ blockTime: new Date('2025-12-31') }, 'before_invoice']
  ])('rejects mismatched evidence %j', (change, reason) => expect(classifyTransfer(invoice, { ...transfer, ...change }, route)).toBe(reason));
  it('allows correct payment after an unrelated exception but never after cancellation or settlement', () => {
    expect(classifyTransfer({ ...invoice, status: 'needs_review' }, transfer, route)).toBe('accepted');
    expect(classifyTransfer({ ...invoice, status: 'cancelled' }, transfer, route)).toBe('cancelled');
    expect(classifyTransfer({ ...invoice, status: 'paid' }, transfer, route)).toBe('extra_payment');
  });
});
describe('credential and webhook boundaries', () => {
  it('separates credential purposes and stable request fingerprints', () => {
    expect(credential('secret', 'checkout', 'id')).not.toBe(credential('secret', 'voucher', 'id'));
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(constantTimeEqual('secret', 'secret-longer')).toBe(false);
  });
  it('checks exact bytes, timestamp and signature', () => {
    const body = '{"id":"event-1"}'; const timestamp = '10000'; const signature = signWebhook('secret', timestamp, body);
    expect(verifyWebhook('secret', timestamp, body, signature, 10001)).toBe(true);
    expect(verifyWebhook('secret', timestamp, body + ' ', signature, 10001)).toBe(false);
    expect(verifyWebhook('secret', timestamp, body, signature, 10301)).toBe(false);
    expect(verifyWebhook('secret', 'garbage', body, signature, 10001)).toBe(false);
  });
});
