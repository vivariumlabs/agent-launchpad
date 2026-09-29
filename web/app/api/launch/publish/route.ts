/**
 * POST /api/launch/publish {agentJsonText, configHash?} — server-side proxy to the
 * launch-helper's publish endpoint (SPEC-M4E §1b/§3, R3; M4B R4: the browser
 * never calls the helper directly). The text must be the EXACT bytes prepare
 * returned — the helper re-hashes it and the orchestrator trusts only the
 * on-chain configHash (R1), so this route never touches the text.
 *
 *   fixtures mode -> mock: 200 {txId, ref, configHash}; the request header
 *                    `x-fixture-publish: fail` answers 502 (retry UI walk)
 *   live mode     -> forward verbatim, pass the helper's status + JSON through
 *                    (200 | 413 | 422 | 502 | 503). `configHash` (the
 *                    prepared one) is forwarded when well-formed so the
 *                    helper can 422 a mismatch before uploading.
 *   manual mode   -> 503
 *
 * Over-limit bodies are refused here (413) before forwarding.
 */
import { keccak256, stringToBytes } from "viem";

import { LAUNCH_HELPER_URL, LAUNCH_MODE } from "@/lib/config";
import { isBytes32 } from "@/lib/factory";
import { fixtureLaunchPrepare } from "@/lib/fixtures";
import type { LaunchPublished } from "@/lib/types";

export const dynamic = "force-dynamic";

/** SPEC-M4E §1a: free-upload bound (<100 KiB). The helper enforces the authoritative limit. */
const MAX_BYTES = 100 * 1024;
/** Signing + Turbo upload round trip. */
const HELPER_TIMEOUT_MS = 60_000;

export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const text = (raw as { agentJsonText?: unknown } | null)?.agentJsonText;
  if (typeof text !== "string" || text === "") {
    return Response.json({ error: "body must be {agentJsonText: string}" }, { status: 400 });
  }
  const expected = (raw as { configHash?: unknown }).configHash;
  const configHash = typeof expected === "string" && isBytes32(expected) ? expected : undefined;
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_BYTES) {
    return Response.json({ error: `agent.json is ${bytes} bytes (max ${MAX_BYTES})` }, { status: 413 });
  }

  if (LAUNCH_MODE === "manual") {
    return Response.json({ error: "launch helper not configured (manual mode)" }, { status: 503 });
  }

  if (LAUNCH_MODE === "fixtures") {
    await new Promise((r) => setTimeout(r, 900)); // make the "publishing" state visible
    if (req.headers.get("x-fixture-publish") === "fail") {
      return Response.json({ error: "upload failed", reason: "simulated Turbo 503 (fixtures)" }, { status: 502 });
    }
    // Deterministic fake item id: base64url of keccak(text) is 43 chars — the Arweave id shape.
    const txId = Buffer.from(keccak256(stringToBytes(text)).slice(2), "hex").toString("base64url");
    const body: LaunchPublished = { txId, ref: `ar://${txId}`, configHash: fixtureLaunchPrepare.configHash };
    return Response.json(body);
  }

  try {
    const res = await fetch(`${LAUNCH_HELPER_URL}/api/launch/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentJsonText: text, ...(configHash ? { configHash } : {}) }),
      cache: "no-store",
      signal: AbortSignal.timeout(HELPER_TIMEOUT_MS),
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return Response.json({ error: `launch helper answered ${res.status} with a non-JSON body` }, { status: 502 });
    }
    return Response.json(body, { status: res.status });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `launch helper unreachable: ${reason}` }, { status: 502 });
  }
}
