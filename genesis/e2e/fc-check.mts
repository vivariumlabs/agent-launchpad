import { createPublicClient, http, defineChain, parseAbi } from "viem";
const op = defineChain({ id: 10, name: "op", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://mainnet.optimism.io"] } } });
const pub = createPublicClient({ chain: op, transport: http() });
const abi = parseAbi(["function keyDataOf(uint256 fid, bytes key) view returns (uint8 state, uint32 keyType)", "function totalKeys(uint256 fid, uint8 state) view returns (uint256)"]);
const key = "0x8ded7506453a4d5def71caf33968f16446f6c7709cb67a2a2fa25c453fd6f867";
const r = await pub.readContract({ address: "0x00000000Fc1237824fb747aBDE0FF18990E59b7e", abi, functionName: "keyDataOf", args: [3352486n, key] });
console.log("keyData state/type:", r);
console.log("totalKeys ADDED:", await pub.readContract({ address: "0x00000000Fc1237824fb747aBDE0FF18990E59b7e", abi, functionName: "totalKeys", args: [3352486n, 1] }));
