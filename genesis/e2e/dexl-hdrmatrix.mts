import { randomBytes } from "node:crypto";
import { toHex } from "viem";
import { loadWallet } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/genesis/src/keyfile.js";
import { transferWithAuthorizationTypes } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/runtime/src/exec/abi.js";
const { account } = loadWallet("/sessions/magical-zealous-davinci/mnt/agent-launchpad/.secrets/m0-drill-wallet.json");
const body = JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "Reply with exactly: VIVARIUM-DRILL-OK" }], max_tokens: 16 });
const r0 = await fetch("https://agents.dexl.io/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body });
const v2 = JSON.parse(Buffer.from(r0.headers.get("payment-required")!, "base64").toString("utf8"));
const acc = (v2.accepts as any[]).find(a => a.scheme === "exact" && a.network === "eip155:8453");
const now = Math.floor(Date.now() / 1000);
const mk = async () => {
  const nonce = toHex(randomBytes(32));
  const auth = { from: account.address, to: acc.payTo, value: BigInt(acc.amount), validAfter: BigInt(now - 600), validBefore: BigInt(now + acc.maxTimeoutSeconds) };
  const sig = await account.signTypedData({ domain: { name: acc.extra.name, version: acc.extra.version, chainId: 8453, verifyingContract: acc.asset },
    types: transferWithAuthorizationTypes, primaryType: "TransferWithAuthorization", message: { ...auth, nonce } });
  return { auth, nonce, sig };
};
const variants: Array<[string, string, any]> = [];
{ const { auth, nonce, sig } = await mk();
  variants.push(["PAYMENT + v2 envelope", "PAYMENT", { x402Version: 2, resource: v2.resource, accepted: acc, payload: { signature: sig, authorization: { from: auth.from, to: auth.to, value: auth.value.toString(10), validAfter: auth.validAfter.toString(10), validBefore: auth.validBefore.toString(10), nonce } } }]); }
{ const { auth, nonce, sig } = await mk();
  variants.push(["X-PAYMENT + v2 envelope", "X-PAYMENT", { x402Version: 2, accepted: acc, payload: { signature: sig, authorization: { from: auth.from, to: auth.to, value: auth.value.toString(10), validAfter: auth.validAfter.toString(10), validBefore: auth.validBefore.toString(10), nonce } } }]); }
for (const [name, hdr, env] of variants) {
  const r = await fetch("https://agents.dexl.io/v1/chat/completions", { method: "POST",
    headers: { "content-type": "application/json", [hdr]: Buffer.from(JSON.stringify(env)).toString("base64") }, body });
  const t = await r.text();
  console.log(`\n${name}: HTTP ${r.status}`);
  const pr = r.headers.get("payment-response"); if (pr) console.log("  payment-response:", Buffer.from(pr, "base64").toString("utf8").slice(0, 220));
  try { const c = JSON.parse(t); console.log("  reply:", JSON.stringify(c.choices?.[0]?.message ?? c.error ?? c).slice(0, 160)); } catch { console.log("  body:", t.slice(0, 160)); }
  if (r.status === 200) break;
}
