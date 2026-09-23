// SPEC-M2B §5 test doubles: MockLlm (scripted) and MockX402Transport (captures K3 auths
// instead of paying). No network.

import type { Address } from "viem";
import type { SignedX402Auth } from "../keyring/keyring.js";
import type { LlmClient, LlmRequest, LlmResponse, X402Quote, X402Transport } from "./types.js";

/** A scripted response: text, a full response, an Error to throw, or a function of the request. */
export type MockLlmItem = string | LlmResponse | Error | ((req: LlmRequest) => string | LlmResponse | Error);

export type MockLlmResponder = (req: LlmRequest) => string | LlmResponse | Error;

function toResponse(v: string | LlmResponse | Error): LlmResponse {
  if (v instanceof Error) throw v;
  return typeof v === "string" ? { text: v } : v;
}

export class MockLlm implements LlmClient {
  /** Every request received, in order. */
  readonly calls: LlmRequest[] = [];
  private readonly script: MockLlmItem[];
  private readonly responder: MockLlmResponder | undefined;

  /** `script`: consumed one item per call; or a responder function answering every call. */
  constructor(script: MockLlmItem[] | MockLlmResponder) {
    if (typeof script === "function") {
      this.script = [];
      this.responder = script;
    } else {
      this.script = [...script];
      this.responder = undefined;
    }
  }

  push(...items: MockLlmItem[]): void {
    this.script.push(...items);
  }

  remaining(): number {
    return this.script.length;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    if (this.responder !== undefined) return toResponse(this.responder(req));
    const next = this.script.shift();
    if (next === undefined) throw new Error("MockLlm: script exhausted");
    if (typeof next === "function") return toResponse(next(req));
    return toResponse(next);
  }
}

export interface CapturedX402 {
  endpointId: string;
  auth: SignedX402Auth;
}

export class MockX402Transport implements X402Transport {
  /** Every K3-signed authorization handed to pay(), in order (nothing is actually paid). */
  readonly paid: CapturedX402[] = [];
  readonly quotes: string[] = [];
  private readonly prices = new Map<string, bigint>();
  private readonly payTo = new Map<string, Address>();

  constructor(entries: ReadonlyArray<{ id: string; payTo: Address; price: bigint }>) {
    for (const e of entries) {
      this.prices.set(e.id, e.price);
      this.payTo.set(e.id, e.payTo);
    }
  }

  setPrice(endpointId: string, price: bigint): void {
    this.prices.set(endpointId, price);
  }

  async quote(endpointId: string): Promise<X402Quote> {
    this.quotes.push(endpointId);
    const price = this.prices.get(endpointId);
    const payTo = this.payTo.get(endpointId);
    if (price === undefined || payTo === undefined) throw new Error(`MockX402Transport: no quote for "${endpointId}"`);
    return { endpointId, pricePerMTokUsd: price, payTo };
  }

  async pay(endpointId: string, auth: SignedX402Auth): Promise<void> {
    this.paid.push({ endpointId, auth });
  }
}
