// free-tier sanity + paid attempt with FULL header dump
import { randomBytes } from "node:crypto";
import { toHex } from "viem";
import { loadWallet } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/genesis/src/keyfile.js";
import { transferWithAuthorizationTypes } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/runtime/src/exec/abi.js";
const { account } = loadWallet("/sessions/magical-zealous-davinci/mnt/agent-launchpad/.secrets/m0-drill-wallet.json");
// 1. free tier
const rf = await fetch("https://agents.dexl.io/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "dexl-free", messages: [{ role: "user", content: "Reply with exactly: VIVARIUM-FREE-OK" }], max_tokens: 20 }) });
console.log("free tier:", rf.status, JSON.stringify((await rf.json()).choices?.[0]?.message).slice(0, 120));
// 2. paid, full header dump on failure
const body = JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "Reply with exactly: VIVARIUM-DRILL-OK" }], max_tokens: 16 });
const r1 = await fetch("https://agents.dexl.io/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body });
const j: any = await r1.json();
const acc = (j.accepts as any[]).find(a => a.scheme === "exact" && a.network === "base");
console.log("quote:", JSON.stringify(acc).slice(0, 260));
const now = Math.floor(Date.now() / 1000);
const auth = { from: account.address, to: acc.payTo, value: BigInt(acc.maxAmountRequired), validAfter: BigInt(now - 600), validBefore: BigInt(now + acc.maxTimeoutSeconds) };
const nonce = toHex(randomBytes(32));
const sig = await account.signTypedData({ domain: { name: acc.extra.name, version: acc.extra.version, chainId: 8453, verifyingContract: acc.asset },
  types: transferWithAuthorizationTypes, primaryType: "TransferWithAuthorization", message: { ...auth, nonce } });
const env = { x402Version: 1, scheme: "exact", network: acc.network, payload: { signature: sig, authorization: { from: auth.from, to: auth.to, value: auth.value.toString(10), validAfter: auth.validAfter.toString(10), validBefore: auth.validBefore.toString(10), nonce } } };
const r2 = await fetch("https://agents.dexl.io/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "X-PAYMENT": Buffer.from(JSON.stringify(env)).toString("base64") }, body });
console.log("paid:", r2.status);
for (const [k, v] of r2.headers.entries()) if (/payment|x402|error|request/i.test(k)) console.log("  hdr", k, ":", String(v).slice(0, 160));
console.log("body:", (await r2.text()).slice(0, 400));
