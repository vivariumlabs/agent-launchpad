import { createPublicClient, createWalletClient, http, parseAbi, defineChain } from "viem";
import { loadWallet } from "/sessions/magical-zealous-davinci/mnt/agent-launchpad/genesis/src/keyfile.js";

const rh = defineChain({ id: 46630, name: "rh-testnet", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } } });
const { account } = loadWallet("/sessions/magical-zealous-davinci/mnt/agent-launchpad/.secrets/m0-drill-wallet.json");
const pub = createPublicClient({ chain: rh, transport: http() });
const wal = createWalletClient({ chain: rh, transport: http(), account });

const FACTORY = "0x7b257abd9BDf3377Af03DD67e2D67a8D5717b118";
const USDG = "0xe6f7E5832991f5af335C2A21d4F35cea3d47ccAb";
const HASH = "0xa09ccda57986f29aac8cce3ef6ea072927920f19c74377b514ce69e347421063";
const EXPECTED_TREASURY = "0x9f1a19e0ba24e22a916edca8e64236b7e1fb15a8";

const erc = parseAbi(["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"]);
const fac = parseAbi(["function createAgent(string name, string symbol, string imageURI, bytes32 configHash, address creator, address expectedTreasuryEOA) payable returns (uint256)", "function agentCount() view returns (uint256)"]);

const fees = { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 10_000_000n };
const allowance = await pub.readContract({ address: USDG, abi: erc, functionName: "allowance", args: [account.address, FACTORY] });
if (allowance < 75_000_000n) {
  const h = await wal.writeContract({ address: USDG, abi: erc, functionName: "approve", args: [FACTORY, 75_000_000n], ...fees });
  console.log("approve tx:", h, (await pub.waitForTransactionReceipt({ hash: h })).status);
} else console.log("allowance sufficient:", allowance);

const h2 = await wal.writeContract({ address: FACTORY, abi: fac, functionName: "createAgent", args: ["Vivarium E2E 4", "VIVE2E4", "", HASH, account.address, EXPECTED_TREASURY], ...fees });
const r = await pub.waitForTransactionReceipt({ hash: h2 });
console.log("createAgent tx:", h2, r.status, "block", r.blockNumber, "gasUsed", r.gasUsed);
console.log("agentCount now:", await pub.readContract({ address: FACTORY, abi: fac, functionName: "agentCount" }));
