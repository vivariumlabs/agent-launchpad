// SPEC-M2B §5. LLM client types. No network code here (SPEC-M3 §3: the real x402 HTTP
// transport is src/llm/x402Http.ts over the injected HttpClient below; the ONLY file that
// touches the network is src/llm/httpFetch.ts).

import type { Address } from "viem";
import type { SignedX402Auth } from "../keyring/keyring.js";

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

/** One tool offered to the LLM (JSON-serializable description; arg validation is runtime-side zod). */
export interface ToolSpec {
  name: string;
  description: string;
  /** arg name → human-readable type/constraint description. */
  args: Record<string, string>;
}

export interface LlmRequest {
  endpointId: string;
  model: string;
  system: string;
  messages: LlmMessage[];
  toolSchema: ToolSpec[];
  maxTokens: number;
  /** USD(6) bound this call was paid/authorized for (K3 auth.value ≤ this). */
  maxCostUsd: bigint;
}

export interface LlmResponse {
  text: string;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** x402 402-quote for an endpoint (price per million tokens in USD(6)). */
export interface X402Quote {
  endpointId: string;
  pricePerMTokUsd: bigint;
  payTo: Address;
}

/** x402 payment transport. The signed EIP-3009 auth always comes from keyring K3 via execute(). */
export interface X402Transport {
  quote(endpointId: string): Promise<X402Quote>;
  pay(endpointId: string, auth: SignedX402Auth): Promise<void>;
}

// ---------------------------------------------------------------------------
// SPEC-M3 §3 — injected HTTP client (node fetch impl in httpFetch.ts; MockHttp in mock.ts)
// ---------------------------------------------------------------------------

export interface HttpRequest {
  method: "POST";
  url: string;
  /** Header names lowercase. */
  headers: Record<string, string>;
  body: string;
  /** Hard per-request timeout (ms). */
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  /** Header names lowercase. */
  headers: Record<string, string>;
  body: string;
}

/** Never follows redirects; rejects on network error / timeout. */
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}
