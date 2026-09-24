import { randomBytes } from "node:crypto";
import { createPublicClient, http, defineChain, toHex, parseAbi } from "viem";
import { loadWallet } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/genesis/src/keyfile.js";
import { transferWithAuthorizationTypes } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/runtime/src/exec/abi.js";
const { account } = loadWallet("/sessions/magical-zealous-davinci/mnt/agent-launchpad/.secrets/m0-drill-wallet.json");
const base = defineChain({ id: 8453, name: "base", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://mainnet.base.org"] } } });
const pub = createPublicClient({ chain: base, transport: http() });
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const now = Math.floor(Date.now() / 1000);
const auth = { from: account.address, to: "0x820D61a720963fab63aB6e0aeF4D1779Eb42F6BB" as const, value: 1000n, validAfter: BigInt(now - 600), validBefore: BigInt(now + 300) };
const nonce = toHex(randomBytes(32));
const sig = await account.signTypedData({ domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
  types: transferWithAuthorizationTypes, primaryType: "TransferWithAuthorization", message: { ...auth, nonce } });
const abi = parseAbi(["function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)"]);
try {
  await pub.simulateContract({ address: USDC, abi, functionName: "transferWithAuthorization",
    args: [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, nonce, sig], account: "0x0000000000000000000000000000000000000001" });
  console.log("SIMULATION OK — our signed EIP-3009 payload is executable on-chain");
} catch (e: any) { console.log("simulation FAILED:", (e.shortMessage || String(e)).slice(0, 300)); }
console.log("balance:", await pub.readContract({ address: USDC, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [account.address] }));
