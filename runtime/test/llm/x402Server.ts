// Test helper (not a test file): a scripted x402 inference server on top of MockHttp.
// Every request is answered by one responder: no X-PAYMENT ⇒ 402 quote (exact / Base USDC /
// payTo per endpoint URL) or a free 200; with X-PAYMENT ⇒ 200 chat-completions envelope + an
// X-PAYMENT-RESPONSE settlement header. Content comes from `answer(system, user)`.

import type { Address } from "viem";
import { MockHttp } from "../../src/llm/mock.js";
import type { HttpRequest, HttpResponse } from "../../src/llm/types.js";
import { X_PAYMENT, X_PAYMENT_RESPONSE } from "../../src/llm/x402Http.js";
import { USDC } from "../policy/helpers.js";

export interface X402ServerOpts {
  /** endpoint URL → payTo quoted in the 402 (missing URL ⇒ 404). */
  payTo: Record<string, Address>;
  /** Quoted maxAmountRequired (USDC 6dp). DEFAULT 1000 (0.001 USD). */
  amount?: bigint;
  /** Per-request quote (overrides `amount`), e.g. priced from the body's max_tokens like a real endpoint. */
  amountFor?: (req: HttpRequest) => bigint;
  /** URLs answered with a FREE 200 (no 402). */
  free?: ReadonlySet<string>;
  /** URLs whose FIRST (unpaid) POST fails with a transport error. */
  down?: ReadonlySet<string>;
  answer(system: string, user: string): string;
  /** Requests answered (DEFAULT 200). */
  capacity?: number;
}

export const SETTLE_TX = `0x${"5e".repeat(32)}`;

export function settlementHeader(): string {
  return Buffer.from(JSON.stringify({ success: true, transaction: SETTLE_TX, network: "base", payer: "0x0000000000000000000000000000000000000001" })).toString(
    "base64",
  );
}

export function x402Server(opts: X402ServerOpts): MockHttp {
  const http = new MockHttp();
  const respond = (req: HttpRequest): HttpResponse | Error => {
    const payTo = opts.payTo[req.url];
    if (payTo === undefined) return { status: 404, headers: {}, body: "no such endpoint" };
    const paid = req.headers[X_PAYMENT] !== undefined;
    if (!paid && opts.down?.has(req.url) === true) return new Error("ECONNREFUSED (mock)");
    const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: string }> };
    const system = body.messages.find((m) => m.role === "system")?.content ?? "";
    const user = body.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    const envelope = JSON.stringify({ id: "c", choices: [{ index: 0, message: { role: "assistant", content: opts.answer(system, user) } }] });
    if (opts.free?.has(req.url) === true) return { status: 200, headers: { "content-type": "application/json" }, body: envelope };
    if (!paid) {
      return {
        status: 402,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x402Version: 1,
          error: "X-PAYMENT header is required",
          accepts: [
            {
              scheme: "exact",
              network: "base",
              maxAmountRequired: (opts.amountFor?.(req) ?? opts.amount ?? 1000n).toString(),
              resource: req.url,
              payTo,
              maxTimeoutSeconds: 60,
              asset: USDC.base,
              extra: { name: "USD Coin", version: "2" },
            },
          ],
        }),
      };
    }
    return { status: 200, headers: { "content-type": "application/json", [X_PAYMENT_RESPONSE]: settlementHeader() }, body: envelope };
  };
  for (let i = 0; i < (opts.capacity ?? 200); i++) http.push((req) => respond(req));
  return http;
}
