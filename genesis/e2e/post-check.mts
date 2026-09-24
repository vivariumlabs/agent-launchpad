import { createPublicClient, http, parseAbi } from "viem";
const pub = createPublicClient({ transport: http("https://rpc.testnet.chain.robinhood.com") });
const T = "0xEfcfeF4D9B4869637c904d2b1Eb06Cd0c1E276ce";
const erc = parseAbi(["function balanceOf(address) view returns (uint256)"]);
console.log("treasury RH ETH:", Number(await pub.getBalance({ address: T }))/1e18);
console.log("treasury USDG:", Number(await pub.readContract({ address: "0xe6f7E5832991f5af335C2A21d4F35cea3d47ccAb", abi: erc, functionName: "balanceOf", args: [T] }))/1e6);
const cnt = await pub.getTransactionCount({ address: T });
console.log("treasury nonce (txs sent):", cnt);
