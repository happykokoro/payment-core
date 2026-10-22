/** Framework-free payment rules. All amounts are integer base-unit strings. */
export type PaymentStatus = 'pending' | 'expired' | 'paid' | 'needs_review' | 'cancelled';
export interface Route { id: string; chainId: number; name: string; symbol: string; decimals: number; token: string; testnet: boolean }
export interface PaymentRequest {
  externalOrderId: string;
  amountUnits: string;
  expiresInSeconds: number;
  voucher?: { entitlement: Record<string, unknown>; validForSeconds: number };
}
/** Finalized, successful transfer evidence supplied only by the server-side adapter. */
export interface Transfer {
  routeId: string; transactionHash: string; logIndex: number; token: string;
  recipient: string; sender: string; amountUnits: string;
  blockNumber: bigint; blockHash: string; blockTime: Date;
}
export interface Invoice {
  id: string; externalOrderId: string; routeId: string; amountUnits: string;
  recipient: string; status: PaymentStatus; createdAt: Date; expiresAt: Date;
  monitorUntil: Date; lastScannedBlock: bigint; lastScannedHash: string | null;
  voucher: PaymentRequest['voucher'] | null;
}
export class PaymentError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) { super(message); }
}
export type Disposition = 'accepted' | 'wrong_asset' | 'wrong_recipient' | 'before_invoice' | 'wrong_amount' | 'late' | 'extra_payment' | 'cancelled';
export function classifyTransfer(invoice: Invoice, transfer: Transfer, route: Route): Disposition {
  if (transfer.routeId !== invoice.routeId || transfer.token.toLowerCase() !== route.token.toLowerCase()) return 'wrong_asset';
  if (transfer.recipient.toLowerCase() !== invoice.recipient.toLowerCase()) return 'wrong_recipient';
  if (transfer.blockTime < invoice.createdAt) return 'before_invoice';
  if (invoice.status === 'paid') return 'extra_payment';
  if (invoice.status === 'cancelled') return 'cancelled';
  if (transfer.blockTime >= invoice.expiresAt) return 'late';
  if (BigInt(transfer.amountUnits) !== BigInt(invoice.amountUnits)) return 'wrong_amount';
  return 'accepted';
}
