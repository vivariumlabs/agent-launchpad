/**
 * POST /api/launch/prepare — server-side proxy to the launch-helper
 * (SPEC-M4B R4: the browser never calls the helper directly).
 *
 *   fixtures mode (INDEXER_URL unset) -> mock helper: web-side moderation +
 *                                        fixtures/launch-prepare.json
 *   live mode (LAUNCH_HELPER_URL set) -> forward {agent} verbatim, pass the
 *                                        helper's status + JSON through
 *   manual mode                        -> 503 (the form is not rendered)
 */
import { LAUNCH_HELPER_URL, LAUNCH_MODE } from "@/lib/config";
import { fixtureLaunchPrepare, fixtureLaunchTemplate } from "@/lib/fixtures";
import { isLaunchValid, parseLaunchBody, validateLaunchInput } from "@/lib/launch";
import { MODERATION_RUBRIC_VERSION } from "@/lib/moderation";
import type { LaunchPrepared, LaunchViolations } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Prepare runs compute-image-id + a KMS derive on the helper — allow time. */
const HELPER_TIMEOUT_MS = 60_000;

export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const input = parseLaunchBody(raw);
  if (!input) return Response.json({ error: "body must be {agent: {name, symbol, archetype, persona, models}}" }, { status: 400 });

  if (LAUNCH_MODE === "manual") {
    return Response.json({ error: "launch helper not configured (manual mode)" }, { status: 503 });
  }

  if (LAUNCH_MODE === "fixtures") {
    const v = validateLaunchInput(input, fixtureLaunchTemplate);
    // Mirror the helper's status split: moderation => 422, malformed/unknown model => 400.
    if (v.moderation.length > 0) {
      const body: LaunchViolations = {
        error: "moderation",
        rubricVersion: MODERATION_RUBRIC_VERSION,
        violations: v.moderation,
      };
      return Response.json(body, { status: 422 });
    }
    if (!isLaunchValid(v)) {
      const issues = Object.entries(v.errors).map(([path, message]) => ({ path: `agent.${path}`, message }));
      return Response.json({ error: "invalid request", issues }, { status: 400 });
    }
    const prepared: LaunchPrepared = {
      ...fixtureLaunchPrepare,
      agentJson: {
        platform: fixtureLaunchTemplate.platform,
        agent: { ...input, name: input.name.trim(), agentId: fixtureLaunchPrepare.agentId },
      },
    };
    // Simulate helper latency so the "preparing" state is visible.
    await new Promise((r) => setTimeout(r, 600));
    return Response.json(prepared);
  }

  try {
    const res = await fetch(`${LAUNCH_HELPER_URL}/api/launch/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: input }),
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
