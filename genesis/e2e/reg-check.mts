import { createPublicClient, http, parseAbi } from "viem";
const pub = createPublicClient({ transport: http("https://rpc.testnet.chain.robinhood.com") });
const abi = parseAbi(["function instanceOf(uint256) view returns (address treasuryEOA, address actionEOA, bytes32 codeHash, uint64 lastHeartbeat, uint32 generation)"]);
console.log(await pub.readContract({ address: "0xDBA9680C0F1958Af7Bc34a225863D93df2B92f59", abi, functionName: "instanceOf", args: [2n] }));
