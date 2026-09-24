// M3 s3 item 5 — Turbo live probe with the drill wallet as ANS-104 Ethereum signer.
import { hexToBytes } from "viem";
import { loadWallet } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/genesis/src/keyfile.js";
import { createHttpTurboUploader } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/runtime/src/attestation/turboHttp.js";

const { account } = loadWallet("/sessions/magical-zealous-davinci/mnt/agent-launchpad/.secrets/m0-drill-wallet.json");
const signer = {
  signatureType: 3 as const, ownerLength: 65 as const, signatureLength: 65 as const,
  publicKey: hexToBytes(account.publicKey),
  address: account.address,
  async sign(message: Uint8Array): Promise<Uint8Array> {
    return hexToBytes(await account.signMessage({ message: { raw: message } }));
  },
};
const up = createHttpTurboUploader(signer as any);
console.log("wallet:", account.address);
try { console.log("balance winc:", await up.balanceWinc()); } catch (e) { console.log("balance err:", String(e).slice(0,120)); }
try { console.log("cost 1KiB winc:", await up.costWinc(1024)); console.log("cost 90KiB winc:", await up.costWinc(92160)); } catch (e) { console.log("cost err:", String(e).slice(0,120)); }
const payload = new TextEncoder().encode(JSON.stringify({ probe: "m3-s3-item5", at: Date.now(), note: "free-tier check, sub-100KiB" }));
console.log("payload bytes:", payload.length);
const tags = [ { name: "App", value: "agent-launchpad" }, { name: "Kind", value: "probe" }, { name: "AgentId", value: "9002" } ];
try {
  const r = await up.upload(payload, tags);
  console.log("UPLOAD OK id:", r.id);
} catch (e) { console.log("UPLOAD FAILED:", String(e).slice(0, 300)); }
