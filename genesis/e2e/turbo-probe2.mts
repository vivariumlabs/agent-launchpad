import { hexToBytes } from "viem";
import { loadWallet } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/genesis/src/keyfile.js";
import { createHttpTurboUploader } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/runtime/src/attestation/turboHttp.js";
const { account } = loadWallet("/sessions/magical-zealous-davinci/mnt/agent-launchpad/.secrets/m0-drill-wallet.json");
const signer = { signatureType: 3 as const, ownerLength: 65 as const, signatureLength: 65 as const,
  publicKey: hexToBytes(account.publicKey), address: account.address,
  async sign(m: Uint8Array) { return hexToBytes(await account.signMessage({ message: { raw: m } })); } };
const up = createHttpTurboUploader(signer as any);
// 1. GraphQL owner indexing of the earlier item
const tags = [ { name: "App", value: "agent-launchpad" }, { name: "Kind", value: "probe" } ];
for (let i = 0; i < 5; i++) {
  const ids = await up.query(account.address, tags).catch(e => { console.log("query err:", String(e).slice(0,120)); return []; });
  console.log(`query try ${i+1}:`, ids);
  if (ids.includes("EXjnCFBTAg4ISHdbGycIv9jd2LeT9FYb2BGapxx2DIw")) { console.log("INDEXED ✓"); break; }
  await new Promise(r => setTimeout(r, 12000));
}
// 2. download it back
try { const d = await up.download("EXjnCFBTAg4ISHdbGycIv9jd2LeT9FYb2BGapxx2DIw"); console.log("download bytes:", d.length, "content:", new TextDecoder().decode(d).slice(0,80)); } catch (e) { console.log("download err:", String(e).slice(0,150)); }
// 3. free-tier BOUNDARY: 110 KiB with zero credits — expect refusal
const big = new Uint8Array(112640).fill(65);
try { const r = await up.upload(big, [{ name: "App", value: "agent-launchpad" }, { name: "Kind", value: "probe-big" }]); console.log("BIG UPLOAD unexpectedly OK:", r.id); }
catch (e) { console.log("big upload refused (expected):", String(e).slice(0, 200)); }
