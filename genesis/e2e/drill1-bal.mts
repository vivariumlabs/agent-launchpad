import { createPublicClient, http, defineChain, parseAbi, formatUnits } from "viem";
const rh = defineChain({ id: 46630, name: "rh", nativeCurrency: {name:"ETH",symbol:"ETH",decimals:18}, rpcUrls: {default:{http:["https://rpc.testnet.chain.robinhood.com"]}} });
const pub = createPublicClient({ chain: rh, transport: http() });
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)"]);
const T = "0x308ceBcf8258a91DE06ddF1194dE82b04B72a1b4";
const bal = await pub.readContract({ address: T, abi: erc, functionName: "balanceOf", args: ["0x6930FD5C95a2D9d80F3d165597d55843e8A00154"] });
const sup = await pub.readContract({ address: T, abi: erc, functionName: "totalSupply", args: [] });
console.log("drill wallet DRILL1:", formatUnits(bal, 18), "supply:", formatUnits(sup, 18), "bps:", (bal * 10000n / sup).toString());
