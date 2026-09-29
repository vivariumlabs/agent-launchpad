import { LaunchFlow } from "@/components/launch/LaunchFlow";
import { ManualLaunchInstructions } from "@/components/launch/ManualLaunchInstructions";
import { getContracts, getLaunchTemplate } from "@/lib/api";
import { LAUNCH_MODE, ORCHESTRATOR_TRUST_BOUNDARY } from "@/lib/config";
import { contractAddress } from "@/lib/nfts";

export const metadata = { title: "Launch an agent — agent-launchpad" };

/**
 * /launch (SPEC-M4B §3b). The template is read server-side (R4). Modes:
 *   fixtures — mock helper fixtures, full flow walkable, no chain;
 *              `?preview=manual` previews manual mode (fixtures only);
 *              `?publish=fail` makes the first Arweave publish attempt
 *              fail, to walk the retry UI (SPEC-M4E, fixtures only)
 *   live     — real helper + wallet
 *   manual   — LAUNCH_HELPER_URL unset: operator instructions only
 */
export default async function LaunchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const previewManual = LAUNCH_MODE === "fixtures" && sp.preview === "manual";
  const publishFail = LAUNCH_MODE === "fixtures" && sp.publish === "fail";

  const template = LAUNCH_MODE === "manual" || previewManual ? null : await getLaunchTemplate();
  // SPEC-M4G dual-stack: launches go to the PRIMARY (v2) factory from /api/contracts.
  const primaryFactory = template === null ? null : contractAddress(await getContracts(), "factory");

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-50">Launch an agent</h1>
        <p className="mt-1 text-sm text-slate-500">
          Your agent&apos;s persona and models are frozen at genesis — hash-anchored on-chain, not
          editable afterwards by anyone, including you.
        </p>
      </div>

      {LAUNCH_MODE === "fixtures" && !previewManual ? (
        <p className="rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-2 text-xs text-slate-400">
          Fixtures mode: the launch helper and chain are mocked — nothing is sent anywhere.
        </p>
      ) : null}

      {LAUNCH_MODE === "manual" || previewManual ? (
        <ManualLaunchInstructions reason="unset" />
      ) : template === null ? (
        <ManualLaunchInstructions reason="unreachable" />
      ) : (
        <LaunchFlow
          template={template}
          fixtures={LAUNCH_MODE === "fixtures"}
          fixtureFailFirstPublish={publishFail}
          primaryFactory={primaryFactory}
        />
      )}

      <p className="text-xs text-slate-500">{ORCHESTRATOR_TRUST_BOUNDARY}</p>
    </div>
  );
}
