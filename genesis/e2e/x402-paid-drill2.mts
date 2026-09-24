// Variant drill: v2 envelope with `accepted` echo (current spec shape).
import { randomBytes } from "node:crypto";
import { toHex } from "viem";
import { loadWallet } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/genesis/src/keyfile.js";
import { transferWithAuthorizationTypes } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/runtime/src/exec/abi.js";
const { account } = loadWallet("/sessions/magical-zealous-davinci/mnt/agent-launchpad/.secrets/m0-drill-wallet.json");
const USDC_DOMAIN = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const };
const targets = [
  { name: "DexL deepseek-v4-flash", url: "https://agents.dexl.io/v1/chat/completions",
    body: { model: "deepseek-v4-flash", messages: [{ role: "user", content: "Reply with exactly: VIVARIUM-DRILL-OK" }], max_tokens: 16 } },
  { name: "x402-farm v2", url: "https://api.x-402.online/v1/llm", body: { prompt: "Reply with exactly: VIVARIUM-DRILL-OK" } },
  { name: "SYNTHORA fast", url: "https://llm-fast.hergertsynthora.com/v1/chat/completions",
    body: { model: "fast", messages: [{ role: "user", content: "Reply with exactly: VIVARIUM-DRILL-OK" }], max_tokens: 16 } },
];
for (const t of targets) {
  console.log(`\n=== ${t.name}`);
  const r1 = await fetch(t.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(t.body) });
  if (r1.status !== 402) { console.log(`  got ${r1.status}`); continue; }
  const j: any = await r1.json();
  const acc = (j.accepts as any[]).find(a => a.scheme === "exact" && ["base", "eip155:8453"].includes(a.network));
  if (!acc) { console.log("  no base accepts"); continue; }
  const amt = BigInt(acc.maxAmountRequired ?? acc.amount);
  const now = Math.floor(Date.now() / 1000);
  const authorization = { from: account.address, to: acc.payTo, value: amt,
    validAfter: BigInt(now - 30), validBefore: BigInt(now + Math.min(acc.maxTimeoutSeconds ?? 600, 600)) };
  const nonce = toHex(randomBytes(32));
  const sig = await account.signTypedData({ domain: USDC_DOMAIN, types: transferWithAuthorizationTypes, primaryType: "TransferWithAuthorization",
    message: { ...authorization, nonce } });
  const envelope: any = {
    x402Version: j.x402Version ?? 2,
    ...(j.resource !== undefined ? { resource: j.resource } : {}),
    accepted: acc,
    payload: { signature: sig, authorization: { from: authorization.from, to: authorization.to, value: amt.toString(10),
      validAfter: authorization.validAfter.toString(10), validBefore: authorization.validBefore.toString(10), nonce } },
  };
  // v1 servers: also keep scheme/network at top level for compatibility
  if ((j.x402Version ?? 1) === 1) { envelope.scheme = "exact"; envelope.network = acc.network; }
  const header = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
  const r2 = await fetch(t.url, { method: "POST", headers: { "content-type": "application/json", "X-PAYMENT": header }, body: JSON.stringify(t.body) });
  const b2 = await r2.text();
  console.log(`  paid retry: HTTP ${r2.status}`);
  const settle = r2.headers.get("x-payment-response");
  if (settle) console.log("  X-PAYMENT-RESPONSE:", Buffer.from(settle, "base64").toString("utf8").slice(0, 220));
  try { const c = JSON.parse(b2); console.log("  reply:", JSON.stringify(c.choices?.[0]?.message ?? c).slice(0, 180)); }
  catch { console.log("  body:", b2.slice(0, 180)); }
}
