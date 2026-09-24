import { randomBytes } from "node:crypto";
import { toHex } from "viem";
import { loadWallet } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/genesis/src/keyfile.js";
import { transferWithAuthorizationTypes } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/runtime/src/exec/abi.js";
const { account } = loadWallet("/sessions/magical-zealous-davinci/mnt/agent-launchpad/.secrets/m0-drill-wallet.json");
const USDC_DOMAIN = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const };
const targets = [
  { name: "claw402 GLM-5", url: "https://claw402.ai/api/v1/ai/zhipu/chat", body: { messages: [{ role: "user", content: "Reply with exactly: VIVARIUM-DRILL-OK" }] } },
  { name: "twin.unykorn LLM", url: "https://twin.unykorn.org/llm", body: { prompt: "Reply with exactly: VIVARIUM-DRILL-OK" } },
];
for (const t of targets) {
  console.log(`\n=== ${t.name}`);
  const r1 = await fetch(t.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(t.body) }).catch(e => null);
  if (!r1) { console.log("  unreachable"); continue; }
  if (r1.status !== 402) { console.log(`  HTTP ${r1.status}:`, (await r1.text()).slice(0, 120)); continue; }
  const j: any = await r1.json().catch(() => null);
  const acc = j?.accepts?.find((a: any) => a.scheme === "exact" && ["base","eip155:8453"].includes(a.network));
  if (!acc) { console.log("  no base exact accepts:", JSON.stringify(j).slice(0, 200)); continue; }
  const amt = BigInt(acc.maxAmountRequired ?? acc.amount);
  if (amt > 20000n) { console.log(`  price ${amt} > 0.02 cap — skip`); continue; }
  console.log(`  quote ${amt}µ payTo ${acc.payTo}`);
  const now = Math.floor(Date.now() / 1000);
  const auth = { from: account.address, to: acc.payTo, value: amt, validAfter: BigInt(now - 600), validBefore: BigInt(now + (acc.maxTimeoutSeconds ?? 300)) };
  const nonce = toHex(randomBytes(32));
  const sig = await account.signTypedData({ domain: USDC_DOMAIN, types: transferWithAuthorizationTypes, primaryType: "TransferWithAuthorization", message: { ...auth, nonce } });
  const env = { x402Version: j.x402Version ?? 1, scheme: "exact", network: acc.network, payload: { signature: sig, authorization: { from: auth.from, to: auth.to, value: amt.toString(10), validAfter: auth.validAfter.toString(10), validBefore: auth.validBefore.toString(10), nonce } } };
  const r2 = await fetch(t.url, { method: "POST", headers: { "content-type": "application/json", "X-PAYMENT": Buffer.from(JSON.stringify(env)).toString("base64") }, body: JSON.stringify(t.body) });
  console.log(`  paid: HTTP ${r2.status}`);
  const pr = r2.headers.get("x-payment-response") ?? r2.headers.get("payment-response");
  if (pr) console.log("  settle:", Buffer.from(pr, "base64").toString("utf8").slice(0, 200));
  console.log("  reply:", (await r2.text()).slice(0, 200));
}
