// Agent-8 arweave drill — manual pre-seed (deterministic EOAs; sent before deploy to save rental time).
import { createPublicClient, createWalletClient, http, defineChain, parseAbi, parseEther, formatUnits } from "viem";
import { loadWallet } from "/sessions/kind-sharp-maxwell/mnt/agent-launchpad/genesis/src/keyfile.js";
const { account } = loadWallet("/sessions/kind-sharp-maxwell/mnt/agent-launchpad/.secrets/m0-drill-wallet.json");
const TREASURY = "0xd7ef592e26936627c2dad31c08eed561db5eecb8";
const erc = parseAbi(["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const rh = defineChain({ id: 46630, name: "rh", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } } });
const base = defineChain({ id: 8453, name: "base", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://mainnet.base.org"] } } });
const rhPub = createPublicClient({ chain: rh, transport: http() });
const rhWal = createWalletClient({ chain: rh, transport: http(), account });
const basePub = createPublicClient({ chain: base, transport: http() });
const baseWal = createWalletClient({ chain: base, transport: http(), account });
const fees = { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 10_000_000n };

// 1) 85 MockUSDG -> treasury (runway ~50d >= minRunwayDays 45 => I1 floor applies)
let h = await rhWal.writeContract({ address: "0xe6f7E5832991f5af335C2A21d4F35cea3d47ccAb", abi: erc, functionName: "transfer", args: [TREASURY, 85_000_000n], ...fees });
console.log("rh USDG 85:", h, (await rhPub.waitForTransactionReceipt({ hash: h })).status);
// 2) preGas 0.0002 rh ETH (registerInstance gas)
h = await rhWal.sendTransaction({ to: TREASURY, value: parseEther("0.0002"), ...fees });
console.log("rh preGas 0.0002:", h, (await rhPub.waitForTransactionReceipt({ hash: h })).status);
// 3) 0.1 base USDC (inference metering — an agent without base USDC cannot think)
h = await baseWal.writeContract({ address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", abi: erc, functionName: "transfer", args: [TREASURY, 100_000n] });
console.log("base USDC 0.1:", h, (await basePub.waitForTransactionReceipt({ hash: h })).status);

console.log("treasury rh ETH:", formatUnits(await rhPub.getBalance({ address: TREASURY }), 18));
console.log("treasury USDG:", formatUnits(await rhPub.readContract({ address: "0xe6f7E5832991f5af335C2A21d4F35cea3d47ccAb", abi: erc, functionName: "balanceOf", args: [TREASURY] }), 6));
console.log("treasury base USDC:", formatUnits(await basePub.readContract({ address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", abi: erc, functionName: "balanceOf", args: [TREASURY] }), 6));
