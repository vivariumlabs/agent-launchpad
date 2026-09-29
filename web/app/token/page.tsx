import Link from "next/link";

import { AddressRow } from "@/components/AddressRow";
import { TxLink } from "@/components/TxLink";
import { RedeemPanel } from "@/components/token/RedeemPanel";
import { getContracts, getFloor } from "@/lib/api";
import { FIXTURES_MODE, RH_CHAIN_ID } from "@/lib/config";
import { fixtureFloorDemoWallet } from "@/lib/fixtures";
import {
  FLOOR_PRICE_DECIMALS,
  FLOOR_SCENARIOS,
  floorFlowLabel,
  floorScenarioOf,
  formatFloorPrice,
  formatScientific,
  formatSignificant,
  formatTokenAmount,
  formatUsdgPrecise,
} from "@/lib/floor";
import { formatAbsoluteTime, formatRelativeTime, sameHex, truncateAddress } from "@/lib/format";
import { contractAddress } from "@/lib/nfts";
import type { ContractsResponse, FloorFlow, FloorView } from "@/lib/types";

export const metadata = { title: "$TOKEN — agent-launchpad" };

/** Floor stats are indexer reads (15 s revalidate in lib/api.ts); the page itself reads searchParams. */
export const dynamic = "force-dynamic";

/**
 * /token (SPEC-M4G §4): the $TOKEN redemption floor (D18). Stats come from
 * the indexer's /api/floor; the redeem panel's addresses come ONLY from
 * /api/contracts (floorVault, platformToken). Fixtures: `?floor=active|
 * fresh|disabled`, plus a walletless simulated redeem walk.
 */
export default async function TokenPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const scenario = floorScenarioOf(sp.floor);
  const [floorRes, contracts] = await Promise.all([getFloor(scenario), getContracts()]);
  const floor = floorRes.kind === "ok" ? floorRes.floor : null;
  const symbol = floor?.token.symbol ?? "$TOKEN";

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-50">$TOKEN</h1>
        <p className="mt-1 text-sm text-slate-500">
          The platform token, backed by a hard USDG redemption floor that only ever rises.
        </p>
      </div>

      <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-xs text-amber-200/90">
        Testnet: mock $TOKEN on testnet
        {floor?.token.symbol ? (
          <>
            {" "}
            (<span className="font-mono">{floor.token.symbol}</span>
            {floor.token.name ? ` — ${floor.token.name}` : ""})
          </>
        ) : null}
        ; the real token launches on PONS at M6.
      </p>

      {FIXTURES_MODE ? (
        <div className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3">
          <p className="text-xs text-slate-400">Fixtures mode: indexer data is mocked. Floor scenario:</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {FLOOR_SCENARIOS.map((s) => (
              <Link
                key={s.id}
                href={s.id === "active" ? "/token" : `/token?floor=${s.id}`}
                className={`rounded-md border px-2.5 py-1 text-xs transition ${
                  scenario === s.id
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-slate-700 text-slate-400 hover:border-slate-600 hover:text-slate-200"
                }`}
              >
                {s.label}
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {floorRes.kind === "disabled" ? (
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="text-lg font-semibold text-slate-100">The floor is not live yet</h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">
            The redemption floor launches with the v2 contract stack: its FloorVault receives the platform leg of every
            v2 agent-token fee. The indexer has no vault configured yet, so there is nothing to show or redeem. Agents on
            the legacy stack sent their platform leg to the retired buyback, which never reaches the vault.
          </p>
        </section>
      ) : floorRes.kind === "unavailable" ? (
        <section className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
          Floor data is unavailable ({floorRes.message}). Nothing below is a reading — refresh in a moment.
        </section>
      ) : floor ? (
        <>
          <FloorHero floor={floor} symbol={symbol} />
          <RedeemPanel {...redeemProps(floor, contracts, symbol)} />
        </>
      ) : null}

      <Explainer symbol={symbol} />

      {floor ? <RecentFlows flows={floor.recent} symbol={symbol} /> : null}

      {floor ? (
        <section className="flex flex-col gap-1.5 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <AddressRow label="FloorVault" address={contractAddress(contracts, "floorVault") ?? floor.vault} />
          <AddressRow label={`${symbol} token`} address={contractAddress(contracts, "platformToken") ?? floor.token.address} />
          <AddressRow label="USDG" address={contractAddress(contracts, "usdg") ?? floor.usdg} />
          <p className="mt-2 text-xs text-slate-500">
            Everything here is also possible without this site: <span className="font-mono">approve(vault, amount)</span>{" "}
            on the token, then <span className="font-mono">redeem(amount)</span> on the vault (
            <span className="font-mono">quoteRedeem(amount)</span> previews the payout). Donating is a plain USDG
            transfer to the vault address.
          </p>
        </section>
      ) : null}
    </div>
  );
}

/** Redeem addresses ONLY from /api/contracts; block (with a reason) on anything inconsistent. */
function redeemProps(floor: FloorView, contracts: ContractsResponse | null, symbol: string) {
  const vault = contractAddress(contracts, "floorVault");
  const token = contractAddress(contracts, "platformToken");
  const blocked =
    contracts === null
      ? "Contract addresses are unavailable (indexer unreachable) — redeem disabled."
      : contracts.chainId !== RH_CHAIN_ID
        ? `The indexer reports chain ${contracts.chainId}, but this site is configured for Robinhood Chain Testnet (${RH_CHAIN_ID}) — redeem disabled.`
        : vault === null || token === null
          ? "The deployment manifest has no floorVault / platformToken address — redeem disabled."
          : (floor.vault !== null && !sameHex(floor.vault, vault)) ||
              (floor.token.address !== null && !sameHex(floor.token.address, token))
            ? "The indexer's floor data and contract addresses disagree — redeem disabled until they match."
            : floor.token.decimals !== null && floor.token.decimals !== 18
              ? `The token reports ${floor.token.decimals} decimals; the vault only accepts 18 — redeem disabled.`
              : null;
  return {
    vault,
    token,
    blocked,
    symbol,
    vaultUsdg: floor.vaultUsdg,
    supply: floor.token.totalSupply,
    fixtures: FIXTURES_MODE,
    demo: FIXTURES_MODE ? fixtureFloorDemoWallet : null,
  };
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 truncate font-mono text-sm text-slate-100" title={value}>
        {value}
      </dd>
      {sub ? <dd className="mt-0.5 truncate text-[11px] text-slate-500">{sub}</dd> : null}
    </div>
  );
}

function usdg(v: string | null): string {
  const f = formatUsdgPrecise(v);
  return f === null ? "—" : `${f} USDG`;
}

function tokens(v: string | null, symbol: string): string {
  const f = formatTokenAmount(v);
  return f === null ? "—" : `${f} ${symbol}`;
}

function FloorHero({ floor, symbol }: { floor: FloorView; symbol: string }) {
  const supplyZero = floor.token.totalSupply === "0";
  const price = formatFloorPrice(floor.floorPriceX18);
  const sci = formatScientific(floor.floorPriceX18, FLOOR_PRICE_DECIMALS);
  const perMillion =
    floor.floorPriceX18 !== null && floor.floorPriceX18 !== "0"
      ? formatSignificant(BigInt(floor.floorPriceX18) * 1_000_000n, FLOOR_PRICE_DECIMALS, 6)
      : null;
  const t = floor.totals;

  return (
    <section className="flex flex-col gap-5 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div>
        <p className="text-[11px] uppercase tracking-wide text-slate-500">Floor price</p>
        {supplyZero ? (
          <p className="mt-1 text-2xl font-semibold text-slate-300">Undefined — the supply is 0</p>
        ) : price === null ? (
          <p className="mt-1 text-2xl font-semibold text-slate-400">—</p>
        ) : (
          <>
            <p className="mt-1 break-all font-mono text-3xl font-semibold text-slate-50">
              {price} <span className="text-lg font-medium text-slate-400">USDG per {symbol}</span>
            </p>
            {sci ? <p className="mt-1 font-mono text-sm text-slate-400">= {sci} USDG</p> : null}
            {perMillion ? (
              <p className="mt-0.5 text-sm text-slate-400">
                = <span className="font-mono">{perMillion}</span> USDG per 1,000,000 {symbol}
              </p>
            ) : price === "0" ? (
              <p className="mt-0.5 text-sm text-slate-500">No USDG in the vault yet — the first fee inflow or donation starts the floor.</p>
            ) : null}
          </>
        )}
        <p className="mt-2 text-xs text-slate-500">
          Vault USDG ÷ total supply, rounded down.
          {floor.updatedAt !== null ? (
            <span title={formatAbsoluteTime(floor.updatedAt)}> Indexed {formatRelativeTime(floor.updatedAt)}.</span>
          ) : null}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Vault USDG" value={usdg(floor.vaultUsdg)} />
        <Stat label="Total supply" value={tokens(floor.token.totalSupply, symbol)} />
        <Stat
          label="Redeemed"
          value={usdg(t.redeemedUsdg)}
          sub={t.redemptions !== null ? `${t.redemptions} redemption${t.redemptions === 1 ? "" : "s"}` : undefined}
        />
        <Stat label="Burned via redeem" value={tokens(t.burnedTokens, symbol)} />
        <Stat label="Inflow: pool fees" value={usdg(t.feePool)} sub="lifetime" />
        <Stat label="Inflow: curve fees" value={usdg(t.feeCurve)} sub="lifetime" />
        <Stat label="Inflow: donations" value={usdg(t.donations)} sub="lifetime" />
        <Stat label="Stray burned" value={tokens(t.strayBurned, symbol)} sub="burnStray()" />
      </dl>
    </section>
  );
}

function Explainer({ symbol }: { symbol: string }) {
  const items: { title: string; body: string }[] = [
    {
      title: "What the floor is",
      body: `The FloorVault holds USDG. The floor is that USDG divided by ${symbol}'s total supply. Anyone can burn tokens through the vault and receive exactly their share: amount × vault USDG ÷ total supply.`,
    },
    {
      title: "It only goes up",
      body: "1% of every agent-token trade (the platform leg of the 3% fee) flows into the vault as USDG, and so do donations — both raise the floor. Tokens burned anywhere shrink the supply, which raises it too. Nothing can lower it.",
    },
    {
      title: "Redeeming at the floor leaves it unchanged",
      body: "You take your pro-rata USDG and your tokens are destroyed in the same transaction, so the floor for everyone else stays where it was. Rounding is always in the vault's favour: the dust stays behind and can only nudge the floor up.",
    },
    {
      title: "No owner, no withdrawal, no market",
      body: "The vault has no admin, no settings and no function that sends USDG anywhere except to the person redeeming. It never trades, swaps or reads a price oracle. Donations are plain USDG transfers to the vault address.",
    },
    {
      title: `${symbol}'s own trading fees are team revenue`,
      body: `The fees from trading ${symbol} itself (its PONS creator-earnings stream) go to the team's wallet as revenue — they do not enter the vault. The floor is funded only by the agent-token platform leg and donations.`,
    },
    {
      title: "Why there is no minimum-out",
      body: `For a fixed amount the payout can only grow over time — inflows add USDG, burns remove supply — so a redemption waiting to be included can only pay more when it lands. This holds because ${symbol} has a fixed supply and cannot be minted. Tokens sent to the vault by plain transfer can be destroyed by anyone with burnStray(), which only raises the floor.`,
    },
  ];
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-slate-100">How the floor works</h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {items.map((it) => (
          <div key={it.title} className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
            <h3 className="text-sm font-medium text-slate-200">{it.title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-slate-400">{it.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

const FLOW_DOT: Record<string, string> = {
  fee_pool: "bg-sky-400",
  fee_curve: "bg-violet-400",
  donation: "bg-emerald-400",
  redeem: "bg-amber-400",
  stray_burn: "bg-red-400",
};

function flowDetail(f: FloorFlow, symbol: string): string {
  const u = formatUsdgPrecise(f.usdg);
  const tk = formatTokenAmount(f.tokens);
  switch (f.kind) {
    case "redeem":
      return [tk !== null ? `burned ${tk} ${symbol}` : null, u !== null ? `paid ${u} USDG` : null]
        .filter(Boolean)
        .join(" → ");
    case "stray_burn":
      return tk !== null ? `burned ${tk} ${symbol}` : "";
    default:
      return u !== null ? `+${u} USDG` : "";
  }
}

function RecentFlows({ flows, symbol }: { flows: FloorFlow[]; symbol: string }) {
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-slate-100">Recent vault activity</h2>
      {flows.length === 0 ? (
        <p className="text-sm text-slate-500">No vault activity yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900/40">
          {flows.map((f) => (
            <li key={`${f.txHash}-${f.logIndex ?? ""}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
              <span className={`h-2 w-2 shrink-0 rounded-full ${FLOW_DOT[f.kind] ?? "bg-slate-400"}`} aria-hidden />
              <span className="text-slate-200">{floorFlowLabel(f.kind)}</span>
              <span className="font-mono text-xs text-slate-300">{flowDetail(f, symbol)}</span>
              {f.agentId !== null ? (
                <Link href={`/agent/${f.agentId}`} className="text-xs text-accent hover:underline">
                  agent #{f.agentId}
                </Link>
              ) : null}
              {f.account && (f.kind === "redeem" || f.kind === "donation" || f.kind === "stray_burn") ? (
                <span className="font-mono text-xs text-slate-500" title={f.account}>
                  {truncateAddress(f.account)}
                </span>
              ) : null}
              <span className="ml-auto flex items-center gap-3">
                <TxLink txHash={f.txHash} />
                {f.ts !== null ? (
                  <span className="w-16 shrink-0 text-right text-xs text-slate-500" title={formatAbsoluteTime(f.ts)}>
                    {formatRelativeTime(f.ts)}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
