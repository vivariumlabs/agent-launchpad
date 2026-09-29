/**
 * GET /api/revive/quote/:id — server-side proxy to the launch-helper's revive
 * quote (SPEC-M4F §1/§2; M4B R4: the browser never calls the helper). The
 * pay flow re-reads this RIGHT BEFORE paying so a stale page can never charge
 * for an impossible revival (R2) or a changed price.
 *
 * Returns the web-normalized ReviveQuoteResult (lib/types.ts):
 *   200 {kind:"ok", quote} | 503 {kind:"manual", message} | 502 {kind:"unavailable", message}
 */
import { getReviveQuote } from "@/lib/reviveServer";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!/^\d{1,9}$/.test(id)) return Response.json({ kind: "unavailable", message: "bad agent id" }, { status: 400 });
  const result = await getReviveQuote(Number(id));
  const status = result.kind === "ok" ? 200 : result.kind === "manual" ? 503 : 502;
  return Response.json(result, { status });
}
