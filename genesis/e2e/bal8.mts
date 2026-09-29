import { createPublicClient, http, defineChain, parseAbi, formatEther, formatUnits } from "viem";
const erc = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const mk = (id: number, url: string) => createPublicClient({ chain: defineChain({ id, name: String(id), nativeCurrency: {name:"ETH",symbol:"ETH",decimals:18}, rpcUrls: {default:{http:[url]}} }), transport: http(url) });
const rh = mk(46630, "https://rpc.testnet.chain.robinhood.com");
const base = mk(8453, "https://mainnet.base.org");
const T = "0xd7ef592e26936627c2dad31c08eed561db5eecb8", A = "0x3c169d57729bf24bdea3ef34f5089be6234bc9a1";
const USDG = "0xe6f7E5832991f5af335C2A21d4F35cea3d47ccAb", USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
console.log("agent8 treasury: rhETH", formatEther(await rh.getBalance({address:T})), "USDG", formatUnits(await rh.readContract({address:USDG,abi:erc,functionName:"balanceOf",args:[T]}),6), "baseUSDC", formatUnits(await base.readContract({address:USDC,abi:erc,functionName:"balanceOf",args:[T]}),6));
console.log("agent8 action: rhETH", formatEther(await rh.getBalance({address:A})), "USDG", formatUnits(await rh.readContract({address:USDG,abi:erc,functionName:"balanceOf",args:[A]}),6));
