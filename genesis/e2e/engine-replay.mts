// Replay agent-6's daemon decisions offline: real frozen config + live chain state + pure engine.
import { readFileSync } from "node:fs";
import { evaluate } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/runtime/src/policy/engine.js";
import { resolveConfig } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/runtime/src/config/schema.js";
import { emptyLedger } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/runtime/src/ledger/ledger.js";
import { allowanceMax } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/runtime/src/policy/rules/treasury.js";
import { chainStateReader } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/runtime/src/boot.js";
import { RealChainClient } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/runtime/src/exec/chainViem.js";

const frozen = JSON.parse(readFileSync("/sessions/magical-zealous-davinci/mnt/agent-launchpad/genesis/e2e/agent-6.json", "utf8"));
const cfg = resolveConfig({ platform: frozen.platform, agent: frozen.agent, ownAddresses: {
  treasury: "0xe5d2190897dffa7dd5675fcaf5790cae47aceb97", action: "0x445ed86e8efe7c36985cf35d217e9e55c4a4c1fc",
  fc: "0x0000000000000000000000000000000000000001", fcPublicKey: ("0x" + "11".repeat(32)) as any } as any });
const chain = new RealChainClient({ rpcUrls: { rh: "https://rpc.testnet.chain.robinhood.com", base: "https://mainnet.base.org", arbitrum: "https://arb1.arbitrum.io/rpc", optimism: "https://mainnet.optimism.io" }, chainIds: cfg.chainIds });
const getState = chainStateReader(chain, cfg, { paidUntil: 1791028800n, ratePerDay: 1700000n });
const state = await getState();
console.log("staleChains:", (state as any).staleChains ?? "none");
const now = BigInt(Math.floor(Date.now()/1000));
const L = emptyLedger(now);
const amax = allowanceMax(state, cfg);
console.log("allowanceMax:", amax);
for (const a of [
  { kind: "allowance", amount: amax } as any,
  { kind: "treasuryTransfer", purpose: "gasTopUp", chain: "rh", asset: "ETH", to: "0x445ed86e8efe7c36985cf35d217e9e55c4a4c1fc", amount: 300000000000000n } as any,
]) {
  const v = evaluate(a, state, L, cfg, now);
  console.log(a.kind, a.purpose ?? "", "→", v.allow ? "ALLOW" : `DENY ${ (v as any).code }: ${ (v as any).detail?.slice(0,140) }`);
}
