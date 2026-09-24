// M3 s3 — LIVE PAID x402 inference drill, using the RUNTIME's own quote parser + payment header
// (checkQuote / encodePaymentHeader / decodeSettlement) with the drill wallet as payer.
import { randomBytes } from "node:crypto";
import { toHex } from "viem";
import { loadWallet } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/genesis/src/keyfile.js";
import { checkQuote, encodePaymentHeader, decodeSettlement } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/runtime/src/llm/x402Http.js";
import { transferWithAuthorizationTypes } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/runtime/src/exec/abi.js";

const { account } = loadWallet("/sessions/magical-zealous-davinci/mnt/agent-launchpad/.secrets/m0-drill-wallet.json");
const USDC = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const };
const targets: Array<{ name: string; url: string; body: unknown; payTo?: string }> = [
  { name: "DexL deepseek-v4-flash", url: "https://agents.dexl.io/v1/chat/completions",
    body: { model: "deepseek-v4-flash", messages: [{ role: "user", content: "Reply with exactly: VIVARIUM-DRILL-OK" }], max_tokens: 16 } },
  { name: "SYNTHORA fast", url: "https://llm-fast.hergertsynthora.com/v1/chat/completions",
    body: { model: "fast", messages: [{ role: "user", content: "Reply with exactly: VIVARIUM-DRILL-OK" }], max_tokens: 16 } },
  { name: "x402-farm v2", url: "https://api.x-402.online/v1/llm",
    body: { prompt: "Reply with exactly: VIVARIUM-DRILL-OK" } },
];
for (const t of targets) {
  console.log(`\n=== ${t.name}`);
  const r1 = await fetch(t.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(t.body) });
  const b1 = await r1.text();
  if (r1.status !== 402) { console.log(`  expected 402, got ${r1.status}: ${b1.slice(0, 120)}`); continue; }
  // capture payTo from the quote itself (first drill: trust-on-first-use, recorded for the allowlist)
  const j = JSON.parse(b1); const acc = (j.accepts as any[]).find(a => a.scheme === "exact" && ["base","eip155:8453"].includes(a.network));
  const q = checkQuote(b1, acc.payTo, USDC, 100_000n, 100_000n);
  if (!q.ok) { console.log("  checkQuote REJECTED:", q.detail); continue; }
  console.log(`  quote OK: ${q.req.maxAmountRequired} µUSDC → payTo ${q.req.payTo}`);
  const now = Math.floor(Date.now() / 1000);
  const authorization = { from: account.address, to: q.req.payTo, value: q.req.maxAmountRequired,
    validAfter: BigInt(now - 30), validBefore: BigInt(now + Math.min(q.req.maxTimeoutSeconds ?? 600, 600)), nonce: toHex(randomBytes(32)) };
  const signature = await account.signTypedData({ domain: USDC, types: transferWithAuthorizationTypes, primaryType: "TransferWithAuthorization",
    message: authorization });
  const header = encodePaymentHeader(q.req.network, { authorization, signature });
  const r2 = await fetch(t.url, { method: "POST", headers: { "content-type": "application/json", "X-PAYMENT": header }, body: JSON.stringify(t.body) });
  const b2 = await r2.text();
  console.log(`  paid retry: HTTP ${r2.status}`);
  const settle = r2.headers.get("x-payment-response");
  if (settle) console.log("  settlement:", JSON.stringify(decodeSettlement(settle)).slice(0, 200));
  try { const c = JSON.parse(b2); console.log("  completion:", JSON.stringify(c.choices?.[0]?.message ?? c).slice(0, 160)); }
  catch { console.log("  body:", b2.slice(0, 160)); }
}
