"use client";

import { useReadContracts } from "wagmi";

import { erc20ReadAbi, sharePercent } from "@/lib/chat";
import { fixtureIndicativeBalance, type ChatScenario } from "@/lib/chatFixtures";
import { D13_NOTICE, RH_CHAIN_ID } from "@/lib/config";
import { isAddress, parseUint } from "@/lib/factory";
import { formatFixedPoint } from "@/lib/format";

/** Eligibility as reported by the CVM's own responses (R4) — never computed client-side. */
export type Eligibility = "unknown" | "eligible" | "not_eligible" | "gate_unavailable";

const STATE_COPY: Record<Exclude<Eligibility, "unknown">, { text: string; cls: string }> = {
  eligible: {
    text: "Eligible — the agent's gate accepted your last message.",
    cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  },
  not_eligible: {
    text: "Not eligible — the agent's balance gate refused this wallet (403).",
    cls: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  },
  gate_unavailable: {
    text: "Balance gate unavailable — the agent fails closed (503). Try again shortly.",
    cls: "border-red-500/40 bg-red-500/10 text-red-300",
  },
};

/**
 * R4 banner: D9 rule text, the CVM-reported state, an INDICATIVE balance of the
 * agent token (client-side read, labeled as such), and the D13 notice verbatim.
 */
export function EligibilityBanner({
  eligibility,
  wallet,
  token,
  symbol,
  totalSupply,
  fixtureScenario,
}: {
  eligibility: Eligibility;
  wallet: string | null;
  token: string | null;
  symbol: string | null;
  totalSupply: string | null;
  /** Set in fixtures mode: the indicative balance is scripted instead of read from chain. */
  fixtureScenario: ChatScenario | null;
}) {
  const state = eligibility === "unknown" ? null : STATE_COPY[eligibility];

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-slate-100">Holders-only chat</h2>
        <p className="text-sm text-slate-400">
          To chat you need at least <strong className="text-slate-200">0.1%</strong> of this agent&apos;s
          token supply, or at least <strong className="text-slate-200">1%</strong> of the platform
          $TOKEN supply. The agent checks this itself, inside its enclave, on every message.
        </p>
      </div>

      {state ? <p className={`rounded-md border px-3 py-2 text-sm ${state.cls}`}>{state.text}</p> : null}

      {wallet ? (
        fixtureScenario !== null ? (
          <FixtureBalance scenario={fixtureScenario} symbol={symbol} totalSupply={totalSupply} />
        ) : token !== null && isAddress(token) && isAddress(wallet) ? (
          <LiveBalance wallet={wallet} token={token} symbol={symbol} />
        ) : null
      ) : null}

      <p className="rounded-md border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-300">{D13_NOTICE}</p>
    </section>
  );
}

function BalanceLine({ balance, supply, symbol }: { balance: bigint; supply: bigint | null; symbol: string | null }) {
  const pct = supply !== null ? sharePercent(balance, supply) : null;
  return (
    <p className="text-xs text-slate-400">
      Your balance:{" "}
      <span className="font-mono text-slate-200">
        {formatFixedPoint(balance.toString(), 18, 2)} {symbol ?? "tokens"}
      </span>
      {pct !== null ? <span className="text-slate-300"> ({pct} of supply)</span> : null}
      <span className="text-slate-500"> — indicative: the agent checks its own frozen config inside the TEE</span>
    </p>
  );
}

function LiveBalance({ wallet, token, symbol }: { wallet: `0x${string}`; token: `0x${string}`; symbol: string | null }) {
  const { data } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: token, abi: erc20ReadAbi, functionName: "balanceOf", args: [wallet], chainId: RH_CHAIN_ID },
      { address: token, abi: erc20ReadAbi, functionName: "totalSupply", chainId: RH_CHAIN_ID },
    ],
  });
  const bal = data?.[0]?.status === "success" ? data[0].result : null;
  const sup = data?.[1]?.status === "success" ? data[1].result : null;
  if (typeof bal !== "bigint") return null;
  return <BalanceLine balance={bal} supply={typeof sup === "bigint" ? sup : null} symbol={symbol} />;
}

function FixtureBalance({
  scenario,
  symbol,
  totalSupply,
}: {
  scenario: ChatScenario;
  symbol: string | null;
  totalSupply: string | null;
}) {
  const supply = totalSupply !== null ? parseUint(totalSupply) : null;
  if (supply === null || supply === 0n) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <BalanceLine balance={fixtureIndicativeBalance(scenario, supply)} supply={supply} symbol={symbol} />
      <p className="text-[11px] text-slate-600">(fixtures: scripted balance, no chain read)</p>
    </div>
  );
}
