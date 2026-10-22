/** Read-only ERC-20 verification through viem. Only finalized blocks can reach the ledger. */
import { createPublicClient, decodeEventLog, http, parseAbi, parseAbiItem, type Address, type Hash, type PublicClient } from 'viem';
import { PaymentError, type Invoice, type Route, type Transfer } from './domain.js';

export interface ChainHead { number: bigint; hash: string; timestamp: Date }
/** The application receives normalized evidence; it never accepts payment proof from a browser. */
export interface PaymentChain {
  validate(): Promise<void>;
  finalizedHead(): Promise<ChainHead>;
  latestHead(): Promise<ChainHead>;
  block(number: bigint): Promise<ChainHead>;
  transfers(recipient: string, fromBlock: bigint, toBlock: bigint): Promise<Transfer[]>;
  finalizedTransfer(hash: string, logIndex: number): Promise<Transfer>;
  transactionStatus(invoice: Invoice, hash: string): Promise<{ state: 'unknown' | 'pending' | 'confirming' | 'review' | 'failed' | 'not_payment' }>;
}
export const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const tokenAbi = parseAbi(['function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
export class EvmUsdcChain implements PaymentChain {
  readonly client: PublicClient;
  constructor(private route: Route, rpcUrl: string) {
    this.client = createPublicClient({ transport: http(rpcUrl, { timeout: 10000, retryCount: 1 }) });
  }
  async validate(): Promise<void> {
    if (await this.client.getChainId() !== this.route.chainId) throw new Error('RPC network does not match configured route');
    const decimals = await this.client.readContract({ address: this.route.token as Address, abi: tokenAbi, functionName: 'decimals' });
    if (decimals !== this.route.decimals) throw new Error('Token decimals do not match configured USDC');
    await this.finalizedHead();
  }
  async finalizedHead(): Promise<ChainHead> {
    if (await this.client.getChainId() !== this.route.chainId) throw new Error('RPC network does not match configured route');
    // Never fall back to latest/safe if finality is unsupported or the RPC fails.
    const b = await this.client.getBlock({ blockTag: 'finalized' });
    if (b.number === null || b.hash === null) throw new Error('RPC did not return a finalized block');
    return { number: b.number, hash: b.hash, timestamp: new Date(Number(b.timestamp) * 1000) };
  }
  async block(number: bigint): Promise<ChainHead> {
    const b = await this.client.getBlock({ blockNumber: number });
    if (b.number === null || b.hash === null) throw new Error('RPC block unavailable');
    return { number: b.number, hash: b.hash, timestamp: new Date(Number(b.timestamp) * 1000) };
  }
  async latestHead(): Promise<ChainHead> {
    if (await this.client.getChainId() !== this.route.chainId) throw new Error('RPC network changed');
    const b = await this.client.getBlock({ blockTag: 'latest' });
    if (b.number === null || b.hash === null) throw new Error('RPC latest block unavailable');
    return { number: b.number, hash: b.hash, timestamp: new Date(Number(b.timestamp) * 1000) };
  }
  async finalizedTransfer(hash: string, logIndex: number): Promise<Transfer> {
    const head = await this.finalizedHead();
    const receipt = await this.client.getTransactionReceipt({ hash: hash as Hash });
    if (receipt.status !== 'success' || receipt.blockNumber > head.number) throw new PaymentError('refund_unconfirmed', 'Refund requires a successful finalized transaction', 409);
    const log = receipt.logs.find(l => l.logIndex === logIndex && l.address.toLowerCase() === this.route.token.toLowerCase());
    if (!log) throw new PaymentError('refund_proof_invalid', 'USDC transfer log not found', 409);
    const decoded = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
    const transfer = (await this.transfers(decoded.args.to, receipt.blockNumber, receipt.blockNumber)).find(t => t.transactionHash === hash && t.logIndex === logIndex);
    if (!transfer || (await this.block(head.number)).hash !== head.hash) throw new PaymentError('refund_proof_invalid', 'Refund evidence is not canonical', 409);
    return transfer;
  }
  async transactionStatus(invoice: Invoice, hash: string): Promise<{ state: 'unknown' | 'pending' | 'confirming' | 'review' | 'failed' | 'not_payment' }> {
    const head = await this.finalizedHead();
    let receipt;
    try { receipt = await this.client.getTransactionReceipt({ hash: hash as Hash }); }
    catch (error) {
      if (error instanceof Error && error.name === 'TransactionReceiptNotFoundError') return { state: 'unknown' };
      throw error;
    }
    if ((await this.block(receipt.blockNumber)).hash !== receipt.blockHash) return { state: 'unknown' };
    if (receipt.blockNumber > head.number) return { state: 'pending' };
    if ((await this.block(head.number)).hash !== head.hash) return { state: 'unknown' };
    if (receipt.status === 'reverted') return { state: 'failed' };
    const transfers = (await this.transfers(invoice.recipient, receipt.blockNumber, receipt.blockNumber)).filter(t => t.transactionHash === hash);
    if (!transfers.length) return { state: 'not_payment' };
    return { state: transfers.some(t => t.amountUnits === invoice.amountUnits) ? 'confirming' : 'review' };
  }
  async transfers(recipient: string, fromBlock: bigint, toBlock: bigint): Promise<Transfer[]> {
    if (await this.client.getChainId() !== this.route.chainId) throw new Error('RPC network changed');
    const logs = await this.client.getLogs({ address: this.route.token as Address, event: transferEvent,
      args: { to: recipient as Address }, fromBlock, toBlock, strict: true });
    if (logs.length > 1000) throw new Error('Log batch too large; reduce SCAN_BLOCK_RANGE');
    const blocks = new Map<bigint, ChainHead>();
    const receipts = new Map<Hash, Awaited<ReturnType<PublicClient['getTransactionReceipt']>>>();
    const transfers: Transfer[] = [];
    for (const log of logs) {
      if (log.removed || log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.logIndex === null) throw new Error('Unstable transfer log');
      if (log.blockNumber < fromBlock || log.blockNumber > toBlock || log.address.toLowerCase() !== this.route.token.toLowerCase()
        || log.args.to.toLowerCase() !== recipient.toLowerCase()) throw new Error('RPC returned a transfer outside the requested scope');
      let block = blocks.get(log.blockNumber);
      if (!block) { block = await this.block(log.blockNumber); blocks.set(log.blockNumber, block); }
      let receipt = receipts.get(log.transactionHash);
      if (!receipt) { receipt = await this.client.getTransactionReceipt({ hash: log.transactionHash }); receipts.set(log.transactionHash, receipt); }
      if (block.hash !== log.blockHash || receipt.blockHash !== block.hash || receipt.status !== 'success') throw new Error('Transfer receipt is not successful and canonical');
      const recorded = receipt.logs.find(l => l.logIndex === log.logIndex);
      if (!recorded || recorded.address.toLowerCase() !== log.address.toLowerCase() || recorded.data !== log.data
        || recorded.topics.join(',') !== log.topics.join(',')) throw new Error('Transfer log does not match its receipt');
      transfers.push({ routeId: this.route.id, transactionHash: log.transactionHash, logIndex: log.logIndex,
        token: log.address.toLowerCase(), recipient: log.args.to.toLowerCase(), sender: log.args.from.toLowerCase(),
        amountUnits: log.args.value.toString(), blockNumber: log.blockNumber, blockHash: block.hash, blockTime: block.timestamp });
    }
    return transfers.sort((a, b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex);
  }
}
