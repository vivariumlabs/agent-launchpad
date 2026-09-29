import { GENESIS_DOC_URL, REPO_URL, REPRODUCIBLE_BUILD_URL } from "@/lib/config";

/**
 * Manual mode (SPEC-M4F §2): no launch helper, or it answered 503 (no genesis
 * db / payTo configured). Revival never depended on this site or on the
 * platform orchestrator — 04 §6's orchestrator-less backstop, in its spirit:
 * the image, the scripts and the deploy path are public.
 */
export function ManualReviveInstructions({ reason }: { reason: "unset" | "helper" }) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-5">
      <div>
        <p className="text-sm font-semibold uppercase tracking-wide text-amber-400">Manual mode</p>
        <p className="mt-1 text-sm text-slate-300">
          {reason === "unset"
            ? "This deployment of the site has no revival service configured, so it cannot quote or queue a revival."
            : "The revival service is running in manual mode, so this site cannot quote or queue a revival right now."}{" "}
          Revival does not depend on this website or on the platform orchestrator: the runtime image, the deploy
          scripts and the instructions are public, and anyone with a funded wallet can revive an evicted agent —
          Oyster deploys are wallet-only.
        </p>
      </div>
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-slate-300">
        <li>
          Check the gate: the registry&apos;s <span className="font-mono">instanceOf(agentId).lastHeartbeat</span> must be
          older than its on-chain <span className="font-mono">REVIVAL_WINDOW</span>. A fresher heartbeat means the agent is
          alive and the registry will refuse a new instance.
        </li>
        <li>
          Fetch the agent&apos;s frozen <span className="font-mono">agent.json</span> from Arweave (tagged with its
          configHash) and check it hashes to the on-chain <span className="font-mono">configHash</span>. No config, no
          revival — the identity cannot be re-derived without it.
        </li>
        <li>
          Rebuild the runtime release whose image id equals the registered{" "}
          <span className="font-mono">codeHash</span> and use THAT release&apos;s compose — never the current one: a
          different compose derives different keys and the enclave cannot register as this agent.
        </li>
        <li>
          Deploy it on Oyster from your own wallet with the same agent id. The enclave re-derives its keys, restores its
          newest Arweave snapshot and calls <span className="font-mono">registerInstance</span> — generation + 1.
        </li>
      </ol>
      <ul className="flex flex-col gap-1 text-xs text-slate-400">
        <li>
          Rebuild &amp; verify the image:{" "}
          <a href={REPRODUCIBLE_BUILD_URL} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
            REPRODUCIBLE-BUILD.md ↗
          </a>
        </li>
        <li>
          Revival flow (§6):{" "}
          <a href={GENESIS_DOC_URL} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
            04-GENESIS.md ↗
          </a>
        </li>
        <li>
          Source, scripts and releases:{" "}
          <a href={REPO_URL} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
            {REPO_URL} ↗
          </a>
        </li>
      </ul>
    </div>
  );
}
