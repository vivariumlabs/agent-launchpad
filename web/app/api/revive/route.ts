/**
 * POST /api/revive {agentId, payer, paymentTx, signature} — server-side proxy to the
 * launch-helper (SPEC-M4F §1; M4B R4). The helper verifies the payment
 * receipt on-chain (R1: USDC Transfer to payTo, amount ≥ quote, success,
 * unused hash) and queues the revival. Status + JSON pass through:
 *   200 {revivalId} | 402 {error} | 409 {error, reason} | 503 manual mode
 *
 * Fixtures mode: 200 {revivalId} for a fixture agent whose quote is
 * revivable, 409 otherwise; header `x-fixture-submit: conflict` answers 409
 * heartbeat_fresh (walks the "agent woke after payment" copy).
 */
import { isAddress } from "@/lib/factory";
import { LAUNCH_HELPER_URL, LAUNCH_MODE } from "@/lib/config";
import { fixtureRevive } from "@/lib/fixtures";

export const dynamic = "force-dynamic";

/** The helper reads the receipt from the payment chain's RPC. */
const HELPER_TIMEOUT_MS = 30_000;

export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const b = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const agentId = b.agentId;
  const payer = b.payer;
  const paymentTx = b.paymentTx;
  const signature = b.signature;
  if (typeof agentId !== "number" || !Number.isSafeInteger(agentId) || agentId <= 0) {
    return Response.json({ error: "agentId must be a positive integer" }, { status: 400 });
  }
  if (typeof payer !== "string" || !isAddress(payer)) {
    return Response.json({ error: "payer must be an address" }, { status: 400 });
  }
  if (typeof paymentTx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(paymentTx)) {
    return Response.json({ error: "paymentTx must be a transaction hash" }, { status: 400 });
  }
  // M4F rev 1: the payer-signed intent (see lib/revive.ts reviveIntentMessage).
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return Response.json({ error: "signature must be a 65-byte hex signature" }, { status: 400 });
  }

  if (LAUNCH_MODE === "manual") {
    return Response.json({ error: "launch helper not configured (manual mode)" }, { status: 503 });
  }

  if (LAUNCH_MODE === "fixtures") {
    await new Promise((r) => setTimeout(r, 900)); // make the "verifying payment" state visible
    if (req.headers.get("x-fixture-submit") === "conflict") {
      return Response.json(
        { error: "revival refused after payment (fixtures)", reason: "heartbeat_fresh" },
        { status: 409 },
      );
    }
    const q = fixtureRevive.quotes[String(agentId)];
    if (!q || q.revivable !== true) {
      const reason = typeof q?.reason === "string" ? q.reason : "unknown_agent";
      return Response.json({ error: "revival refused (fixtures)", reason }, { status: 409 });
    }
    return Response.json({ revivalId: fixtureRevive.simulatedRevivalId });
  }

  try {
    const res = await fetch(`${LAUNCH_HELPER_URL}/api/revive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId, payer, paymentTx, signature }),
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
