import { createPublicClient, http, defineChain, keccak256, encodeAbiParameters, toBytes } from "viem";
const base = defineChain({ id: 8453, name: "base", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://mainnet.base.org"] } } });
const pub = createPublicClient({ chain: base, transport: http() });
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const onchain = await pub.readContract({ address: USDC, abi: [{ type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] }], functionName: "DOMAIN_SEPARATOR" });
console.log("on-chain DOMAIN_SEPARATOR:", onchain);
const TYPEHASH = keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
for (const [name, ver] of [["USD Coin","2"],["USDC","2"],["USD Coin","1"]] as const) {
  const sep = keccak256(encodeAbiParameters(
    [{type:"bytes32"},{type:"bytes32"},{type:"bytes32"},{type:"uint256"},{type:"address"}],
    [TYPEHASH, keccak256(toBytes(name)), keccak256(toBytes(ver)), 8453n, USDC]));
  console.log(`computed name="${name}" version="${ver}":`, sep, sep === onchain ? "<== MATCH" : "");
}
