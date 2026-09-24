import { createPublicClient, http, defineChain, parseAbi, encodeAbiParameters } from "viem";
import { loadWallet } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/genesis/src/keyfile.js";
import { ed25519KeyFromSeed } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/runtime/src/tls/keys.js";
import { createHash } from "node:crypto";
const op = defineChain({ id: 10, name: "op", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://mainnet.optimism.io"] } } });
const { account } = loadWallet("/sessions/magical-zealous-davinci/mnt/agent-launchpad/.secrets/m0-drill-wallet.json");
const pub = createPublicClient({ chain: op, transport: http() });
const seed = createHash("sha256").update("drill-fc-probe:" + account.address.toLowerCase()).digest();
const priv = ed25519KeyFromSeed(("0x" + seed.toString("hex")) as `0x${string}`);
const { createPublicKey } = await import("node:crypto");
const spki = createPublicKey(priv).export({ format: "der", type: "spki" }) as Buffer;
const pubkey = ("0x" + spki.subarray(spki.length - 32).toString("hex")) as `0x${string}`;
const fid = 3352486n;
const deadline = BigInt(Math.floor(Date.now()/1000) + 3600);
const sig = await account.signTypedData({
  domain: { name: "Farcaster SignedKeyRequestValidator", version: "1", chainId: 10, verifyingContract: "0x00000000FC700472606ED4fA22623Acf62c60553" },
  types: { SignedKeyRequest: [ { name: "requestFid", type: "uint256" }, { name: "key", type: "bytes" }, { name: "deadline", type: "uint256" } ] },
  primaryType: "SignedKeyRequest",
  message: { requestFid: fid, key: pubkey, deadline },
});
const metadata = encodeAbiParameters(
  [{ type: "tuple", components: [ { name: "requestFid", type: "uint256" }, { name: "requestSigner", type: "address" }, { name: "signature", type: "bytes" }, { name: "deadline", type: "uint256" } ] }],
  [{ requestFid: fid, requestSigner: account.address, signature: sig, deadline }],
);
const abi = parseAbi(["function validate(uint256 userFid, bytes key, bytes metadata) view returns (bool)"]);
console.log("validator says:", await pub.readContract({ address: "0x00000000FC700472606ED4fA22623Acf62c60553", abi, functionName: "validate", args: [fid, pubkey, metadata] }));
// also simulate the KeyGateway.add to get a revert reason
const kg = parseAbi(["function add(uint32 keyType, bytes key, uint8 metadataType, bytes metadata)"]);
try { await pub.simulateContract({ address: "0x00000000fC56947c7E7183f8Ca4B62398CaAdf0B", abi: kg, functionName: "add", args: [1, pubkey, 1, metadata], account: account.address }); console.log("simulate add: OK"); }
catch (e: any) { console.log("simulate add revert:", (e.shortMessage || String(e)).slice(0,200), "| data:", e.cause?.data ?? e.cause?.cause?.data ?? "n/a"); }
