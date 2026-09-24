import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import { loadWallet } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/genesis/src/keyfile.js";
const base = defineChain({ id: 8453, name: "base", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://mainnet.base.org"] } } });
const { account } = loadWallet("/sessions/magical-zealous-davinci/mnt/agent-launchpad/.secrets/m0-drill-wallet.json");
const pub = createPublicClient({ chain: base, transport: http() });
const wal = createWalletClient({ chain: base, transport: http(), account });
const h = await wal.sendTransaction({ to: "0x6A0A10FFD285c971B841bee8892878c0d583Bf67", value: 1_000_000_000_000_000n });
const r = await pub.waitForTransactionReceipt({ hash: h });
console.log("topup tx:", h, r.status);
// notify the payment service (retry while it waits for confirmations)
for (let i = 0; i < 10; i++) {
  const res = await fetch("https://payment.ardrive.io/v1/account/balance/base-eth", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx_id: h }) });
  const t = await res.text();
  console.log(`notify try ${i+1}: HTTP ${res.status} ${t.slice(0,140)}`);
  if (res.ok) break;
  await new Promise(r => setTimeout(r, 12000));
}
