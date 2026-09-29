// SPEC-M4B §2 launch-helper entry — the node:http listener ONLY (argv only, no environment variables,
// no secrets). All logic is src/launchHelper.ts; this file lives outside src/ because genesis/src is
// network-module-free by its hygiene test (outbound network goes through src/http.ts, and this is the
// package's first INBOUND listener — see the M4B report).
//
//   npm run launch-helper -- --config <genesis.json>     (the config must have a launchHelper section)

import { createServer, type IncomingMessage, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { createPublicClient, http as viemHttp, TransactionReceiptNotFoundError, type Address, type Hex } from "viem";
import { agentFactoryAbi } from "../src/abi.js";
import { systemClock } from "../src/clock.js";
import { loadConfig } from "../src/config.js";
import { errMsg } from "../src/errors.js";
import { createLaunchHelper, MAX_BODY_BYTES, MAX_PUBLISH_BODY_BYTES, PUBLISH_PATH, reviveConfigured, type FactoryReader, type LaunchHelper } from "../src/launchHelper.js";
import { ViemLaunchpad } from "../src/launchpadReader.js";
import type { Logger } from "../src/log.js";
import type { ReceiptReader, TxReceipt } from "../src/reviveApi.js";

const stamp = (): string => new Date(Number(systemClock.now()) * 1000).toISOString();
const consoleLogger: Logger = {
  info: (m) => console.log(`${stamp()} INFO  ${m}`),
  warn: (m) => console.warn(`${stamp()} WARN  ${m}`),
  error: (m) => console.error(`${stamp()} ERROR ${m}`),
};

/** factory.agentCount() over RH RPC (a view; the helper holds no key and sends nothing). */
export class ViemFactoryReader implements FactoryReader {
  private readonly pub: ReturnType<typeof createPublicClient>;

  constructor(
    rpc: string,
    private readonly factory: Address,
    timeoutMs: number,
  ) {
    this.pub = createPublicClient({ transport: viemHttp(rpc, { timeout: timeoutMs, retryCount: 1 }) });
  }

  async agentCount(): Promise<bigint> {
    return this.pub.readContract({ address: this.factory, abi: agentFactoryAbi, functionName: "agentCount" });
  }
}

/**
 * SPEC-M4F R1: Arbitrum One receipts over a key-less PublicClient (the helper verifies revival
 * payments; it never signs). Refuses an RPC that serves a different chainId.
 */
export class ViemReceiptReader implements ReceiptReader {
  private readonly pub: ReturnType<typeof createPublicClient>;
  private chainChecked = false;

  constructor(
    rpc: string,
    private readonly chainId: number,
    timeoutMs: number,
  ) {
    this.pub = createPublicClient({ transport: viemHttp(rpc, { timeout: timeoutMs, retryCount: 1 }) });
  }

  async receipt(hash: Hex): Promise<TxReceipt | null> {
    if (!this.chainChecked) {
      const id = await this.pub.getChainId();
      if (id !== this.chainId) throw new Error(`payment RPC serves chainId ${id}, expected ${this.chainId} — refusing`);
      this.chainChecked = true;
    }
    try {
      const rc = await this.pub.getTransactionReceipt({ hash });
      return { status: rc.status, blockNumber: rc.blockNumber, logs: rc.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })) };
    } catch (e) {
      if (e instanceof TransactionReceiptNotFoundError) return null;
      throw e;
    }
  }

  async blockTimestamp(blockNumber: bigint): Promise<bigint> {
    const b = await this.pub.getBlock({ blockNumber });
    return b.timestamp;
  }
}

class TooLarge extends Error {}

function readBody(req: IncomingMessage, cap: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      if (size > cap) return; // already rejected: discard the rest (the reply closes the connection)
      size += c.length;
      if (size > cap) {
        chunks = [];
        reject(new TooLarge());
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(size === 0 ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Listens and resolves once bound (port 0 ⇒ ephemeral; tests read server.address()). */
export async function startLaunchHelperServer(helper: LaunchHelper, port: number, host: string, log: Logger): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      let body: string | null = null;
      // SPEC-M4E §1b: /publish carries a JSON-escaped agent.json text (larger cap; the handler 413s the text itself).
      const cap = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") === PUBLISH_PATH ? MAX_PUBLISH_BODY_BYTES : MAX_BODY_BYTES;
      try {
        body = req.method === "POST" ? await readBody(req, cap) : null;
      } catch (e) {
        res.writeHead(e instanceof TooLarge ? 413 : 400, { "content-type": "application/json; charset=utf-8", connection: "close" });
        res.end(JSON.stringify({ error: e instanceof TooLarge ? `body exceeds ${cap} bytes` : "bad request body" }));
        return;
      }
      const r = await helper.handle({ method: req.method ?? "GET", url: req.url ?? "/", body });
      res.writeHead(r.status, r.headers);
      res.end(r.body);
    })().catch((e: unknown) => {
      log.error(`launch-helper: ${errMsg(e)}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "internal error" }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  return server;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--config");
  const path = i >= 0 ? argv[i + 1] : undefined;
  if (path === undefined || path.startsWith("--")) throw new Error("usage: npm run launch-helper -- --config <genesis.json>");
  const cfg = loadConfig(path);
  const lhCfg = cfg.launchHelper;
  if (lhCfg === undefined) throw new Error(`${path}: no launchHelper section`);
  const timeoutMs = lhCfg.httpTimeoutSec * 1000;
  const factory = new ViemFactoryReader(cfg.chains.rh.rpc, cfg.contracts.factory, timeoutMs);
  // SPEC-M4F §1: revive endpoints — key-less RH launchpad reads + Arbitrum One receipts.
  const arb = cfg.chains.arbitrum;
  const revive =
    reviveConfigured(cfg) && arb !== undefined
      ? {
          launchpad: new ViemLaunchpad(createPublicClient({ transport: viemHttp(cfg.chains.rh.rpc, { timeout: timeoutMs, retryCount: 1 }) }), cfg.contracts.factory, cfg.contracts.registry, cfg.contracts.usdg),
          receipts: new ViemReceiptReader(arb.rpc, arb.chainId, timeoutMs),
        }
      : undefined;
  const { helper, lh } = createLaunchHelper(cfg, consoleLogger, { factory, ...(revive === undefined ? {} : { revive }) });
  const server = await startLaunchHelperServer(helper, lh.port, lh.host, consoleLogger);
  consoleLogger.info(`launch-helper up: http://${lh.host}:${lh.port} (compose ${lh.composePath}, kms ${lh.kmsEndpoint}, factory ${cfg.contracts.factory}) — secret-free, no wallet (Arweave publish signs with a per-process ephemeral key)`);
  consoleLogger.info(revive === undefined ? "launch-helper: revive endpoints in MANUAL MODE (503)" : `launch-helper: revive endpoints ON — genesis db ${lh.genesisDb}, fees (USDC, Arbitrum One) to ${lh.revivalPayTo}`);
  const stop = (sig: string): void => {
    consoleLogger.info(`${sig}: closing`);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((e: unknown) => {
    console.error(`launch-helper: ${errMsg(e)}`);
    process.exitCode = 1;
  });
}
