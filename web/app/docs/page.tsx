import { readFile } from "node:fs/promises";
import path from "node:path";

import { getContracts } from "@/lib/api";
import { renderMarkdown } from "@/lib/markdown";
import type { ContractsResponse, StackInfo } from "@/lib/types";

export const metadata = { title: "Docs — agent-launchpad" };

/** Same as /token: indexer reads carry their own revalidate windows (lib/api.ts); the page renders per request. */
export const dynamic = "force-dynamic";

/** The web app runs from web/; the living draft lives at <repo>/docs/public/TRANSPARENCY.md. */
const TRANSPARENCY_PATH = path.join(process.cwd(), "..", "docs", "public", "TRANSPARENCY.md");

async function readDraft(): Promise<string | null> {
  try {
    const text = await readFile(TRANSPARENCY_PATH, "utf8");
    return text.trim() === "" ? null : text;
  } catch {
    return null;
  }
}

/** Per-stack address rows, in this order; only keys present on the stack entry are shown. */
const STACK_KEYS = ["factory", "registry", "hook", "distributor", "nft"] as const;
/** Shared/platform addresses shown first, in this order; any other address keys follow. */
const SHARED_KEYS = ["usdg", "poolManager", "floorVault", "platformToken"] as const;

export default async function DocsPage() {
  const [draft, contracts] = await Promise.all([readDraft(), getContracts()]);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-200">
          Living draft
        </span>
        <p className="text-sm text-slate-500">Docs / Transparency — updated as design decisions land.</p>
      </div>

      {draft !== null ? (
        <article className="flex flex-col gap-4">{renderMarkdown(draft)}</article>
      ) : (
        <section className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
          Draft unavailable: the transparency document could not be read on this server. Nothing below replaces it; the
          live contract addresses are still shown.
        </section>
      )}

      <ContractsSection contracts={contracts} />
    </div>
  );
}

function Addr({ value }: { value: string | null | undefined }) {
  return value ? (
    <span className="break-all font-mono text-xs text-slate-300">{value}</span>
  ) : (
    <span className="text-slate-600">—</span>
  );
}

function AddressTable({ rows }: { rows: { label: string; value: string | null | undefined }[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/40">
      <table className="w-full border-collapse text-left text-sm">
        <tbody className="divide-y divide-slate-800">
          {rows.map((r) => (
            <tr key={r.label} className="align-top">
              <th scope="row" className="w-36 px-3 py-2 text-sm font-normal text-slate-500">
                {r.label}
              </th>
              <td className="px-3 py-2">
                <Addr value={r.value} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StackTable({ stack }: { stack: StackInfo }) {
  const s = stack as unknown as Record<string, string | null | undefined>;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-200">
        Stack v{stack.version}
        {stack.legacy ? (
          <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[11px] font-normal uppercase tracking-wide text-slate-400">
            legacy
          </span>
        ) : null}
      </h3>
      <AddressTable rows={STACK_KEYS.map((k) => ({ label: k, value: s[k] }))} />
    </div>
  );
}

function ContractsSection({ contracts }: { contracts: ContractsResponse | null }) {
  if (contracts === null) {
    return (
      <section className="flex flex-col gap-3">
        <h2 className="mt-4 text-lg font-semibold text-slate-100">Contract addresses (live)</h2>
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
          Contract addresses are unavailable (indexer unreachable). Nothing here is guessed — refresh in a moment.
        </p>
      </section>
    );
  }

  const stackKeys = new Set<string>(STACK_KEYS);
  const addrKeys = Object.keys(contracts.addresses);
  const find = (k: string) => addrKeys.find((a) => a.toLowerCase() === k.toLowerCase());
  const sharedOrdered = SHARED_KEYS.map(find).filter((k): k is string => k !== undefined);
  const rest = addrKeys.filter((k) => !stackKeys.has(k) && !sharedOrdered.includes(k));
  const sharedRows = [...sharedOrdered, ...rest].map((k) => ({ label: k, value: contracts.addresses[k] }));

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="mt-4 text-lg font-semibold text-slate-100">Contract addresses (live)</h2>
        <p className="mt-1 text-xs text-slate-500">
          Served by the indexer&apos;s <span className="font-mono">/api/contracts</span>, chain {contracts.chainId}.
        </p>
      </div>

      {contracts.stacks !== null && contracts.stacks.length > 0 ? (
        contracts.stacks.map((s) => <StackTable key={s.version} stack={s} />)
      ) : (
        <AddressTable rows={STACK_KEYS.map((k) => ({ label: k, value: contracts.addresses[find(k) ?? ""] }))} />
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-slate-200">Shared / platform</h3>
        <AddressTable rows={sharedRows} />
      </div>
    </section>
  );
}
