import { hexToBytes } from "viem";
import { loadWallet } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/genesis/src/keyfile.js";
import { createHttpTurboUploader } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/runtime/src/attestation/turboHttp.js";
const { account } = loadWallet("/sessions/magical-zealous-davinci/mnt/agent-launchpad/.secrets/m0-drill-wallet.json");
const signer = { signatureType: 3 as const, ownerLength: 65 as const, signatureLength: 65 as const,
  publicKey: hexToBytes(account.publicKey), address: account.address,
  async sign(m: Uint8Array) { return hexToBytes(await account.signMessage({ message: { raw: m } })); } };
const up = createHttpTurboUploader(signer as any);
console.log("balance before:", await up.balanceWinc());
const big = new Uint8Array(112640); for (let i=0;i<big.length;i++) big[i] = i % 251; // non-trivial content
const r = await up.upload(big, [{ name: "App", value: "agent-launchpad" }, { name: "Kind", value: "probe-paid" }, { name: "AgentId", value: "9002" }]);
console.log("PAID UPLOAD OK id:", r.id);
console.log("balance after:", await up.balanceWinc());
// indexing recheck for the morning item + this one
const ids = await up.query(account.address, [{ name: "App", value: "agent-launchpad" }]);
console.log("indexed ids:", ids);
