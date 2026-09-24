// M3 s3 item 7 (on-chain half) — FID registration + ed25519 signer add, fully permissionless, OP mainnet.
import { createPublicClient, createWalletClient, http, defineChain, parseAbi, encodeAbiParameters, toHex } from "viem";
import { loadWallet } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/genesis/src/keyfile.js";
import { ed25519KeyFromSeed } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/runtime/src/tls/keys.js";
import { createHash } from "node:crypto";

const op = defineChain({ id: 10, name: "op", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://mainnet.optimism.io"] } } });
const { account } = loadWallet("/sessions/magical-zealous-davinci/mnt/agent-launchpad/.secrets/m0-drill-wallet.json");
const pub = createPublicClient({ chain: op, transport: http() });
const wal = createWalletClient({ chain: op, transport: http(), account });

const ID_GATEWAY = "0x00000000Fc25870C6eD6b6c7E41Fb078b7656f69";
const ID_REGISTRY = "0x00000000Fc6c5F01Fc30151999387Bb99A9f489b";
const KEY_GATEWAY = "0x00000000fC56947c7E7183f8Ca4B62398CaAdf0B";
const KEY_REGISTRY = "0x00000000Fc1237824fb747aBDE0FF18990E59b7e";
const VALIDATOR = "0x00000000FC700472606ED4fA22623Acf62c60553";

const idGw = parseAbi(["function register(address recovery) payable returns (uint256 fid, uint256 overpayment)", "function price() view returns (uint256)"]);
const idReg = parseAbi(["function idOf(address owner) view returns (uint256)"]);
const keyGw = parseAbi(["function add(uint32 keyType, bytes key, uint8 metadataType, bytes metadata)"]);
const keyReg = parseAbi(["function totalKeys(uint256 fid, uint8 state) view returns (uint256)"]);

let fid = await pub.readContract({ address: ID_REGISTRY, abi: idReg, functionName: "idOf", args: [account.address] });
if (fid === 0n) {
  const price = await pub.readContract({ address: ID_GATEWAY, abi: idGw, functionName: "price" });
  console.log("register price ETH:", Number(price)/1e18);
  const h = await wal.writeContract({ address: ID_GATEWAY, abi: idGw, functionName: "register", args: [account.address], value: price });
  console.log("register tx:", h, (await pub.waitForTransactionReceipt({ hash: h })).status);
  fid = await pub.readContract({ address: ID_REGISTRY, abi: idReg, functionName: "idOf", args: [account.address] });
}
console.log("FID:", fid);

// deterministic ed25519 "fc" key for the probe (seed from drill wallet address — NOT the runtime path)
const seed = createHash("sha256").update("drill-fc-probe:" + account.address.toLowerCase()).digest();
const priv = ed25519KeyFromSeed(("0x" + seed.toString("hex")) as `0x${string}`);
const { createPublicKey } = await import("node:crypto");
const spki = createPublicKey(priv).export({ format: "der", type: "spki" }) as Buffer;
const pubkey = ("0x" + spki.subarray(spki.length - 32).toString("hex")) as `0x${string}`;
console.log("ed25519 signer pubkey:", pubkey);

const deadline = BigInt(Math.floor(Date.now()/1000) + 3600);
const sig = await account.signTypedData({
  domain: { name: "Farcaster SignedKeyRequestValidator", version: "1", chainId: 10, verifyingContract: VALIDATOR },
  types: { SignedKeyRequest: [ { name: "requestFid", type: "uint256" }, { name: "key", type: "bytes" }, { name: "deadline", type: "uint256" } ] },
  primaryType: "SignedKeyRequest",
  message: { requestFid: fid, key: pubkey, deadline },
});
const metadata = encodeAbiParameters(
  [{ type: "tuple", components: [ { name: "requestFid", type: "uint256" }, { name: "requestSigner", type: "address" }, { name: "signature", type: "bytes" }, { name: "deadline", type: "uint256" } ] }],
  [{ requestFid: fid, requestSigner: account.address, signature: sig, deadline }],
);
const h2 = await wal.writeContract({ address: KEY_GATEWAY, abi: keyGw, functionName: "add", args: [1, pubkey, 1, metadata] });
console.log("addKey tx:", h2, (await pub.waitForTransactionReceipt({ hash: h2 })).status);
console.log("totalKeys(added):", await pub.readContract({ address: KEY_REGISTRY, abi: keyReg, functionName: "totalKeys", args: [fid, 1] }));
