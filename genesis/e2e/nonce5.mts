import { createPublicClient, http } from "viem";
const pub = createPublicClient({ transport: http("https://rpc.testnet.chain.robinhood.com") });
const T = "0x03effa6299824ae0b81a73df71cb20e71135c23c";
console.log("treasury balance:", Number(await pub.getBalance({ address: T }))/1e18, "nonce:", await pub.getTransactionCount({ address: T }));
