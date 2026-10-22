import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import solc from 'solc';
import { createPublicClient, createTestClient, createWalletClient, http, type Abi, type Address, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { EvmUsdcChain } from '../src/chain.js';
import { freePort, testConfig } from './helpers.js';

let processHandle: ChildProcess; let rpcUrl: string; let token: Address; let otherToken: Address; let adapter: EvmUsdcChain;
let publicClient: ReturnType<typeof createPublicClient>; let wallet: ReturnType<typeof createWalletClient>; let miner: ReturnType<typeof createTestClient>;
let abi: Abi;
const account = mnemonicToAccount('test test test test test test test test test test test junk');
const receiver = '0x0000000000000000000000000000000000000100' as Address;
beforeAll(async () => {
  const platform = { win32: 'win32', linux: 'linux', darwin: 'darwin' }[process.platform];
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (!platform || !arch) throw new Error('Anvil fixture supports Windows x64, Linux/macOS x64 or arm64');
  const packageName = `@foundry-rs/anvil-${platform}-${arch}`;
  const require = createRequire(import.meta.url);
  const directory = path.dirname(require.resolve(`${packageName}/package.json`));
  const binary = path.join(directory, 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil');
  const port = await freePort(); rpcUrl = `http://127.0.0.1:${port}`;
  processHandle = spawn(binary, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '84532', '--silent'], { windowsHide: true, stdio: 'ignore' });
  publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl, { retryCount: 0, timeout: 1000 }) });
  let ready = false;
  for (let n = 0; n < 100; n++) {
    try { await publicClient.getChainId(); ready = true; break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  if (!ready) throw new Error('Local Anvil did not start');
  wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
  miner = createTestClient({ mode: 'anvil', chain: baseSepolia, transport: http(rpcUrl) });
  const source = `pragma solidity ^0.8.20;
    contract TestToken {
      uint8 public constant decimals = 6;
      mapping(address => uint256) public balanceOf;
      event Transfer(address indexed from, address indexed to, uint256 value);
      constructor() { balanceOf[msg.sender] = 1000000000000; }
      function transfer(address to, uint256 value) external returns(bool) {
        require(balanceOf[msg.sender] >= value, 'insufficient');
        balanceOf[msg.sender] -= value; balanceOf[to] += value;
        emit Transfer(msg.sender,to,value); return true;
      }
      function split(address to, uint256 a, uint256 b) external {
        require(balanceOf[msg.sender] >= a+b, 'insufficient');
        balanceOf[msg.sender] -= a+b; balanceOf[to] += a+b;
        emit Transfer(msg.sender,to,a); emit Transfer(msg.sender,to,b);
      }
    }`;
  const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'Test.sol': { content: source } },
    settings: { evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  const contract = compiled.contracts['Test.sol'].TestToken; abi = contract.abi;
  const deploy = async () => {
    const hash = await wallet.deployContract({ account, chain: baseSepolia, abi, bytecode: `0x${contract.evm.bytecode.object}` as Hex });
    const receipt = await publicClient.waitForTransactionReceipt({ hash }); return receipt.contractAddress!;
  };
  token = await deploy(); otherToken = await deploy();
  adapter = new EvmUsdcChain({ ...testConfig('postgresql://unused').route, token }, rpcUrl);
});
afterAll(async () => {
  if (processHandle && processHandle.exitCode === null) {
    const stopped = new Promise<void>(resolve => processHandle.once('exit', () => resolve()));
    processHandle.kill(); await stopped;
  }
});
describe('viem adapter on an actual local EVM', () => {
  it('validates network/decimals, and only returns successful allowlisted recipient transfers', async () => {
    await adapter.validate();
    await expect(new EvmUsdcChain({ ...testConfig('postgresql://unused').route, chainId: 1, token }, rpcUrl).validate()).rejects.toThrow('network');
    const from = (await publicClient.getBlockNumber({ cacheTime: 0 })) + 1n;
    const send = async (contract: Address, recipient: Address, amount: bigint) => {
      const hash = await wallet.writeContract({ account, chain: baseSepolia, address: contract, abi, functionName: 'transfer', args: [recipient, amount], gas: 100000n });
      return publicClient.waitForTransactionReceipt({ hash });
    };
    const correct = await send(token, receiver, 2500000n);
    await send(otherToken, receiver, 2500000n);
    await send(token, '0x0000000000000000000000000000000000000101', 2500000n);
    expect((await send(token, receiver, 10000000000000000n)).status).toBe('reverted');
    await miner.mine({ blocks: 100 });
    const finalized = await adapter.finalizedHead();
    expect(finalized.number).toBeGreaterThanOrEqual(correct.blockNumber);
    const evidence = await adapter.transfers(receiver, from, finalized.number);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ transactionHash: correct.transactionHash, amountUnits: '2500000', recipient: receiver, token: token.toLowerCase() });
  });
  it('preserves log-level identity when one transaction contains multiple transfers', async () => {
    const from = (await publicClient.getBlockNumber({ cacheTime: 0 })) + 1n;
    const hash = await wallet.writeContract({ account, chain: baseSepolia, address: token, abi, functionName: 'split', args: [receiver, 10n, 20n] });
    await publicClient.waitForTransactionReceipt({ hash }); await miner.mine({ blocks: 100 });
    const evidence = await adapter.transfers(receiver, from, (await adapter.finalizedHead()).number);
    expect(evidence).toHaveLength(2); expect(evidence[0]!.transactionHash).toBe(evidence[1]!.transactionHash);
    expect(evidence[0]!.logIndex).not.toBe(evidence[1]!.logIndex);
    expect(evidence.map(t => t.amountUnits)).toEqual(['10', '20']);
  });
  it('verifies refund logs independently and never unlocks retry for a merely unfinalized transaction', async () => {
    const hash = await wallet.writeContract({ account, chain: baseSepolia, address: token, abi, functionName: 'transfer', args: [receiver, 42n] });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const before = await adapter.block(receipt.blockNumber - 1n);
    const head = vi.spyOn(adapter, 'finalizedHead').mockResolvedValue(before);
    try {
      await expect(adapter.finalizedTransfer(hash, receipt.logs[0]!.logIndex)).rejects.toMatchObject({ code: 'refund_unconfirmed' });
    } finally { head.mockRestore(); }
    await miner.mine({ blocks: 100 });
    expect(await adapter.finalizedTransfer(hash, receipt.logs[0]!.logIndex)).toMatchObject({ transactionHash: hash, amountUnits: '42', sender: account.address.toLowerCase(), recipient: receiver });
    await expect(adapter.finalizedTransfer(hash, 999)).rejects.toMatchObject({ code: 'refund_proof_invalid' });
    const badHash = await wallet.writeContract({ account, chain: baseSepolia, address: token, abi, functionName: 'transfer', args: [receiver, 10000000000000000n], gas: 100000n });
    const reverted = await publicClient.waitForTransactionReceipt({ hash: badHash });
    const invoice = { recipient: receiver, amountUnits: '42' } as Parameters<EvmUsdcChain['transactionStatus']>[0];
    const oldHead = vi.spyOn(adapter, 'finalizedHead').mockResolvedValue(await adapter.block(reverted.blockNumber - 1n));
    try { expect((await adapter.transactionStatus(invoice, badHash)).state).toBe('pending'); } finally { oldHead.mockRestore(); }
    await miner.mine({ blocks: 100 }); expect((await adapter.transactionStatus(invoice, badHash)).state).toBe('failed');
    expect((await adapter.transactionStatus(invoice, '0x' + '00'.repeat(32))).state).toBe('unknown');
  });
});
