import { createPublicClient, http } from "viem";
const pub = createPublicClient({ transport: http("https://rpc.testnet.chain.robinhood.com") });
const T = "0x4C0B9E1b0Dc190a67Ee547b4B0EdEdBd21AFd746";
console.log("balance:", Number(await pub.getBalance({ address: T }))/1e18, "nonce:", await pub.getTransactionCount({ address: T }));
