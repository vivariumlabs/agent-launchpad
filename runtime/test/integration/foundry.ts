// SPEC-M2C §4 integration harness (not a test file). Locates forge/anvil/cast,
// builds the contracts, spawns anvil, etches the v4 PoolManager at the pinned
// testnet address, and runs contracts/script/{Deploy,Lifecycle}.s.sol against it.
//
// Isolation: the scripts write `deployments/testnet-46630.json` and
// `broadcast/**/46630/*` relative to the foundry root, and both paths hold the
// COMMITTED real-testnet records in contracts/. So every run uses a throwaway
// foundry root (os.tmpdir()) whose src/lib/script/test/foundry.toml/remappings.txt
// are symlinks into contracts/ and whose out/cache/deployments/broadcast are local.
// Nothing under contracts/ is written.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, pad, type Abi, type Address, type Hex } from "viem";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const CONTRACTS = join(REPO, "contracts");

/** Anvil account #0 — the public, well-known dev key (NOT a secret). */
export const ANVIL_PK0: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const TESTNET_CHAIN_ID = 46630;
/** contracts/script/support/LaunchpadScript.sol:18 POOL_MANAGER */
export const POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";

export interface FoundryBins {
  forge: string;
  anvil: string;
  cast: string;
}

function works(bin: string): boolean {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

/** forge/anvil/cast from $FOUNDRY_BIN, PATH, or ~/.foundry/bin; undefined if any is missing. */
export function findFoundry(): FoundryBins | undefined {
  const dirs: Array<string | undefined> = [process.env.FOUNDRY_BIN, undefined, join(homedir(), ".foundry", "bin")];
  for (const d of dirs) {
    const b = (n: string): string => (d === undefined ? n : join(d, n));
    const bins = { forge: b("forge"), anvil: b("anvil"), cast: b("cast") };
    if (works(bins.forge) && works(bins.anvil) && works(bins.cast)) return bins;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Throwaway foundry root
// ---------------------------------------------------------------------------

export function makeFoundryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lp-int-"));
  for (const f of ["src", "lib", "script", "test", "foundry.toml", "remappings.txt"]) {
    symlinkSync(join(CONTRACTS, f), join(root, f));
  }
  mkdirSync(join(root, "deployments"));
  return root;
}

export function removeFoundryRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function run(bin: string, args: string[], cwd: string, env: Record<string, string>, timeoutMs: number): string {
  const r = spawnSync(bin, args, {
    cwd,
    env: { ...process.env, FOUNDRY_OUT: join(cwd, "out"), FOUNDRY_CACHE_PATH: join(cwd, "cache"), ...env },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0) {
    throw new Error(`${bin} ${args.join(" ")} failed (status ${r.status}, signal ${r.signal}):\n${out.slice(-6000)}`);
  }
  return out;
}

export function forgeBuild(bins: FoundryBins, root: string): string {
  return run(bins.forge, ["build"], root, {}, 600_000);
}

/** `forge script <target> --rpc-url <rpc> --broadcast --slow` exactly as the Deploy/Lifecycle headers prescribe. */
export function forgeScript(bins: FoundryBins, root: string, target: string, rpcUrl: string, extra: string[] = []): string {
  return run(
    bins.forge,
    ["script", target, ...extra, "--rpc-url", rpcUrl, "--broadcast", "--slow"],
    root,
    { DEPLOYER_PK: ANVIL_PK0 },
    600_000,
  );
}

export function castCalldata(bins: FoundryBins, sig: string, args: string[]): Hex {
  const r = spawnSync(bins.cast, ["calldata", sig, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cast calldata failed: ${r.stderr}`);
  return r.stdout.trim().toLowerCase() as Hex;
}

// ---------------------------------------------------------------------------
// Artifacts + manifest
// ---------------------------------------------------------------------------

interface Artifact {
  abi: Abi;
  deployedBytecode: { object: Hex; immutableReferences?: Record<string, Array<{ start: number; length: number }>> };
}

export function artifact(root: string, file: string, name: string): Artifact {
  return JSON.parse(readFileSync(join(root, "out", file, `${name}.json`), "utf8")) as Artifact;
}

export interface Manifest {
  chainId: number;
  poolManager: Address;
  deployer: Address;
  usdg: Address;
  registry: Address;
  nft: Address;
  distributor: Address;
  locker: Address;
  treasuryBuyback: Address;
  hookDeployer: Address;
  hook: Address;
  factory: Address;
  swapRouter: Address;
  treasuryEOA: Address;
  secondOwnerEOA: Address;
  genesisGasRecipient: Address;
}

export function readManifest(root: string): Manifest {
  const p = join(root, "deployments", "testnet-46630.json");
  if (!existsSync(p)) throw new Error(`Deploy.s.sol wrote no manifest at ${p}`);
  return JSON.parse(readFileSync(p, "utf8")) as Manifest;
}

// ---------------------------------------------------------------------------
// anvil
// ---------------------------------------------------------------------------

export async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await res.json()) as { result?: T; error?: { message: string } };
  if (j.error !== undefined) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}

async function alive(url: string): Promise<boolean> {
  try {
    await rpc<string>(url, "eth_chainId");
    return true;
  } catch {
    return false;
  }
}

export interface Anvil {
  url: string;
  proc: ChildProcess;
  stop(): Promise<void>;
}

export async function startAnvil(bins: FoundryBins, port: number): Promise<Anvil> {
  const url = `http://127.0.0.1:${port}`;
  if (await alive(url)) {
    throw new Error(`port ${port} already serves JSON-RPC — refusing to run the integration suite against an unknown node (set ANVIL_PORT)`);
  }
  const proc = spawn(bins.anvil, ["--port", String(port), "--chain-id", String(TESTNET_CHAIN_ID), "--silent"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`anvil exited early (${proc.exitCode}): ${stderr}`);
    if (await alive(url)) break;
    await new Promise((r) => setTimeout(r, 100));
    if (i === 99) throw new Error(`anvil did not come up on ${url}: ${stderr}`);
  }
  const stop = async (): Promise<void> => {
    if (proc.exitCode !== null) return;
    await new Promise<void>((r) => {
      proc.once("exit", () => r());
      proc.kill("SIGTERM");
    });
  };
  return { url, proc, stop };
}

/**
 * Put the v4 PoolManager runtime code at the pinned testnet address. Plain anvil
 * has no PoolManager, and Deploy.s.sol's requireTestnet() checks for code there.
 * The only immutable (NoDelegateCall.original = address(this)) is patched to the
 * target address, so noDelegateCall-guarded entrypoints behave as if deployed
 * there. Constructor storage (Owned.owner) is left zero: only the protocol-fee
 * admin paths read it, and nothing here exercises them.
 */
export async function etchPoolManager(root: string, url: string): Promise<void> {
  const a = artifact(root, "PoolManager.sol", "PoolManager");
  let code = a.deployedBytecode.object.slice(2);
  const word = pad(POOL_MANAGER.toLowerCase() as Hex, { size: 32 }).slice(2);
  for (const refs of Object.values(a.deployedBytecode.immutableReferences ?? {})) {
    for (const r of refs) {
      if (r.length !== 32) throw new Error("unexpected immutable length");
      code = code.slice(0, r.start * 2) + word + code.slice((r.start + r.length) * 2);
    }
  }
  await rpc(url, "anvil_setCode", [getAddress(POOL_MANAGER), `0x${code}`]);
}

export async function increaseTime(url: string, seconds: number): Promise<void> {
  await rpc(url, "evm_increaseTime", [seconds]);
  await rpc(url, "evm_mine", []);
}

export async function setBalance(url: string, who: Address, wei: bigint): Promise<void> {
  await rpc(url, "anvil_setBalance", [who, `0x${wei.toString(16)}`]);
}
