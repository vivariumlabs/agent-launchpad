// SPEC-M3 §2 test helper: a stand-in for the in-enclave Oyster services on an ephemeral
// 127.0.0.1 port — GET /derive/secp256k1?path=<p> (Nautilus KMS) and GET /attestation/raw.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { keccak256, stringToBytes } from "viem";

export interface MockNautilusOptions {
  /** Binding seed (stands in for Oyster's image-id + agent-id user-data binding). */
  seed?: string;
  /** Body for a derive request (DEFAULT: keccak256(seed|path) hex without 0x, plus "\n"). */
  deriveBody?: (path: string) => string | Uint8Array;
  /** Raw quote bytes served at /attestation/raw. */
  quote?: Uint8Array;
  /** The first N requests (any route) answer `failStatus` — exercises boot withRetry. */
  failFirstN?: number;
  failStatus?: number;
}

export const DEFAULT_QUOTE = new Uint8Array([0xd2, 0x84, 0x44, 0xa1, 0x01, 0x38, 0x22, 0xa0, 0x59, 0x00, 0x04, 0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);

export function mockDerivedKey(seed: string, path: string): string {
  return keccak256(stringToBytes(`mock-nautilus|${seed}|${path}`)).slice(2);
}

export class MockNautilusServer {
  private readonly server: Server;
  private readonly opts: MockNautilusOptions;
  private port = 0;
  /** Every request, in order: `${pathname}${search}`. */
  readonly requests: string[] = [];
  /** Paths requested on /derive/secp256k1 (successful + failed). */
  readonly derivePaths: string[] = [];

  constructor(opts: MockNautilusOptions = {}) {
    this.opts = opts;
    this.server = createServer((req, res) => this.handle(req, res));
  }

  get quote(): Uint8Array {
    return this.opts.quote ?? DEFAULT_QUOTE;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get attestationUrl(): string {
    return `${this.baseUrl}/attestation/raw`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((e) => (e ? reject(e) : resolve())));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    this.requests.push(`${u.pathname}${u.search}`);
    if (u.pathname === "/derive/secp256k1") this.derivePaths.push(u.searchParams.get("path") ?? "");
    if (this.requests.length <= (this.opts.failFirstN ?? 0)) {
      res.writeHead(this.opts.failStatus ?? 404).end("not ready");
      return;
    }
    if (req.method === "GET" && u.pathname === "/derive/secp256k1") {
      const path = u.searchParams.get("path");
      if (path === null) {
        res.writeHead(400).end("missing path");
        return;
      }
      const body = this.opts.deriveBody?.(path) ?? `${mockDerivedKey(this.opts.seed ?? "seed", path)}\n`;
      res.writeHead(200, { "content-type": typeof body === "string" ? "text/plain" : "application/octet-stream" }).end(body);
      return;
    }
    if (req.method === "GET" && u.pathname === "/attestation/raw") {
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.from(this.quote));
      return;
    }
    res.writeHead(404).end("no route");
  }
}
