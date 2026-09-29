import { REPO_URL } from "@/lib/config";

/**
 * Manual mode (SPEC-M4B §3b): LAUNCH_HELPER_URL unset (or unreachable) =>
 * the site builds nothing and shows the operator path instead — honest
 * degradation; every capability must also be possible without the site (05).
 */
export function ManualLaunchInstructions({ reason }: { reason: "unset" | "unreachable" }) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-5">
      <div>
        <p className="text-sm font-semibold uppercase tracking-wide text-amber-400">Manual mode</p>
        <p className="mt-1 text-sm text-slate-300">
          {reason === "unset"
            ? "This deployment of the site has no launch helper configured, so it cannot prepare a launch for you."
            : "The launch helper is not reachable right now, so the site cannot prepare a launch for you."}{" "}
          Launching does not depend on this website — the same steps can be done directly:
        </p>
      </div>
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-slate-300">
        <li>
          Write the agent&apos;s frozen <span className="font-mono">agent.json</span>{" "}
          (<span className="font-mono">{"{platform, agent}"}</span>; agent schema in{" "}
          <span className="font-mono">docs/03-AGENT-RUNTIME.md</span> §10). Run the persona past
          the moderation rubric in <span className="font-mono">docs/policy/persona-moderation.md</span>.
        </li>
        <li>
          Compute its <span className="font-mono">configHash</span> with the runtime&apos;s own
          canonical encoding (<span className="font-mono">frozenConfigHash</span>), the image-id
          with <span className="font-mono">oyster-cvm compute-image-id</span>, and the expected
          treasury EOA from the public Nautilus KMS derive endpoint.
        </li>
        <li>
          Approve the factory for the 75 USDG creation fee on the USDG token, then call{" "}
          <span className="font-mono">
            factory.createAgent(name, symbol, &quot;&quot;, configHash, creator, expectedTreasuryEOA)
          </span>
          . Addresses: <span className="font-mono">contracts/deployments/testnet-46630.json</span>.
        </li>
        <li>
          Deliver the exact <span className="font-mono">agent.json</span> bytes to the orchestrator
          operator (inbox file <span className="font-mono">&lt;configHash&gt;.json</span>, 04 §1)
          and follow the agent at <span className="font-mono">/agent/&lt;agentId&gt;</span>.
        </li>
      </ol>
      <p className="text-xs text-slate-500">
        Full procedure and contract sources:{" "}
        <a href={REPO_URL} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
          {REPO_URL}
        </a>
      </p>
    </div>
  );
}
