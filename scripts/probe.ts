// Read-only connectivity check. Does not create addresses, sign, or send funds.
import { loadConfig } from '../src/config.js';
import { EvmUsdcChain } from '../src/chain.js';
const config = loadConfig();
const chain = new EvmUsdcChain(config.route, config.rpcUrl);
await chain.validate();
const head = await chain.finalizedHead();
console.log(JSON.stringify({ routeId: config.route.id, finalizedBlock: head.number.toString(), finalizedAt: head.timestamp, tokenDecimalsVerified: true }, null, 2));
