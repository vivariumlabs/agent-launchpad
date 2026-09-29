// SPEC-M4B §2 launch-helper entry — the node:http listener ONLY (argv only, no environment variables,
// no secrets). All logic is src/launchHelper.ts; this file lives outside src/ because genesis/src is
// network-module-free by its hygiene test (outbound network goes through src/http.ts, and this is the
// package's first INBOUND listener — see the M4B report).
//
//   npm run launch-helper -- --config <genesis.json>     (the config must have a launchHelper section)

import { createServer, type IncomingMessage, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { createPublicClient, http as viemHttp, type Address } from "viem";
import { agentFactoryAbi } from "../src/abi.js";
import { systemClock } from "../src/clock.js";
import { loadConfig } from "../src/config.js";
import { errMsg } from "../src/errors.js";
import { createLaunchHelper, MAX_BODY_BYTES, MAX_PUBLISH_BODY_BYTES, PUBLISH_PATH, type FactoryReader, type LaunchHelper } from "../src/launchHelper.js";
import type { Logger } from "../src/log.js";

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
  const factory = new ViemFactoryReader(cfg.chains.rh.rpc, cfg.contracts.factory, lhCfg.httpTimeoutSec * 1000);
  const { helper, lh } = createLaunchHelper(cfg, consoleLogger, { factory });
  const server = await startLaunchHelperServer(helper, lh.port, lh.host, consoleLogger);
  consoleLogger.info(`launch-helper up: http://${lh.host}:${lh.port} (compose ${lh.composePath}, kms ${lh.kmsEndpoint}, factory ${cfg.contracts.factory}) — secret-free, no wallet (Arweave publish signs with a per-process ephemeral key)`);
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
