import { z } from 'zod';
import { isAddress, zeroAddress } from 'viem';
export const id = z.uuid();
export const key = z.string().min(8).max(128).regex(/^[a-zA-Z0-9._:-]+$/);
export const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v.toLowerCase());
export const logIndex = z.number().int().min(0).max(1000000);
export const amount = z.string().regex(/^[1-9]\d{0,77}$/).refine(v => /^[1-9]\d{0,77}$/.test(v) && BigInt(v) < 2n ** 256n);
export const address = z.string().refine(v => isAddress(v, { strict: false }) && v.toLowerCase() !== zeroAddress).transform(v => v.toLowerCase());
export const note = z.object({ actor: z.string().trim().min(1).max(128), reason: z.string().trim().min(1).max(2000) });
export const pagination = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).max(100000).default(0) });
export const paymentSchema = z.object({
  externalOrderId: z.string().trim().min(1).max(128), amountUnits: amount,
  expiresInSeconds: z.number().int().min(60).max(86400).default(3600),
  voucher: z.object({ entitlement: z.record(z.string(), z.unknown()), validForSeconds: z.number().int().min(60).max(31536000).default(2592000) }).strict().optional()
}).strict();
