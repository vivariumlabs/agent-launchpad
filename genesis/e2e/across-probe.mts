// M3 s3 item 6 — live depositV3 probes with the RUNTIME's exact call shape (build.ts buildAcrossDeposit).
import { createPublicClient, createWalletClient, http, defineChain, parseAbi } from "viem";
import { loadWallet } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/genesis/src/keyfile.js";
const { account } = loadWallet("/sessions/magical-zealous-davinci/mnt/agent-launchpad/.secrets/m0-drill-wallet.json");
const spokeAbi = parseAbi([
  "function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message) payable",
]);
const erc = parseAbi(["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"]);

const chains = {
  base: defineChain({ id: 8453, name: "base", nativeCurrency: { name:"ETH",symbol:"ETH",decimals:18 }, rpcUrls: { default: { http: ["https://mainnet.base.org"] } } }),
  rh: defineChain({ id: 4663, name: "rh", nativeCurrency: { name:"ETH",symbol:"ETH",decimals:18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } }),
};
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDG_RH = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const SPOKE = { base: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64", rh: "0xD29C85F15DF544bA632C9E25829fd29d767d7978" } as const;

const dir = process.argv[2]; // "in" = base->rh, "out" = rh->base
const [cname, inTok, outTok, destId, spoke] = dir === "in"
  ? ["base", USDC_BASE, USDG_RH, 4663n, SPOKE.base] as const
  : ["rh", USDG_RH, USDC_BASE, 8453n, SPOKE.rh] as const;
const chain = chains[cname as "base"|"rh"];
const pub = createPublicClient({ chain, transport: http() });
const wal = createWalletClient({ chain, transport: http(), account });
const amount = BigInt(process.argv[3] ?? "1500000");
const output = amount * 9900n / 10000n; // bridgeMaxFeeBps 100 — the runtime's exact haircut
const bal0 = await (dir==="in"
  ? createPublicClient({ chain: chains.rh, transport: http() }).readContract({ address: USDG_RH, abi: erc, functionName: "balanceOf", args: [account.address] })
  : createPublicClient({ chain: chains.base, transport: http() }).readContract({ address: USDC_BASE, abi: erc, functionName: "balanceOf", args: [account.address] }));
console.log(`[${dir}] dest balance before:`, bal0);
const allowance = await pub.readContract({ address: inTok, abi: erc, functionName: "allowance", args: [account.address, spoke] });
if (allowance < amount) {
  const ha = await wal.writeContract({ address: inTok, abi: erc, functionName: "approve", args: [spoke, amount] });
  console.log("approve:", (await pub.waitForTransactionReceipt({ hash: ha })).status);
}
const nowBlk = Number((await pub.getBlock()).timestamp); const now = nowBlk - 60; // chain time minus safety — local clock can be AHEAD of chain time (probe finding)
const t0 = Date.now();
const h = await wal.writeContract({ address: spoke, abi: spokeAbi, functionName: "depositV3",
  args: [account.address, account.address, inTok, outTok, amount, output, destId, "0x0000000000000000000000000000000000000000", now, now + 4*3600, 0, "0x"] });
const r = await pub.waitForTransactionReceipt({ hash: h });
console.log("depositV3 tx:", h, r.status, "gasUsed", r.gasUsed);
// poll destination for the fill
const destPub = dir==="in" ? createPublicClient({ chain: chains.rh, transport: http() }) : createPublicClient({ chain: chains.base, transport: http() });
const destTok = dir==="in" ? USDG_RH : USDC_BASE;
for (let i = 0; i < 30; i++) {
  const b = await destPub.readContract({ address: destTok, abi: erc, functionName: "balanceOf", args: [account.address] });
  if (b > bal0) { console.log(`FILLED in ~${((Date.now()-t0)/1000).toFixed(1)}s; received:`, b - bal0, `(sent ${amount}, min out ${output})`); process.exit(0); }
  await new Promise(res => setTimeout(res, 4000));
}
console.log("no fill observed in 120s (deadline is 4h; check later)");
