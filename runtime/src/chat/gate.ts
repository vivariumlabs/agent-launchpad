// SPEC-M2C §1 step 1 — D9 balance gate (fail-closed), re-checked on EVERY message (no caching:
// that is what defeats balance-flash).
//
//   pass(h) ⇔ (agentSupply > 0 ∧ agentBal × 10000 ≥ agentSupply × chatAgentGateBps)
//            ∨ (platformSupply > 0 ∧ platformBal × 10000 ≥ platformSupply × chatPlatformGateBps)
//   (exact bigint math; supplies are read on the same call as the balances.)
//
// Dual read: the two BalanceReaders (independent RPC endpoints, cfg.chatRpc) are raced against
// ONE timeout (cfg.chatGateTimeoutMs, 3 s DEFAULT) from an injectable timer (clock-independent).
// Outcome:
//   both resolve, both pass   ⇒ { ok: true }
//   both resolve, both fail   ⇒ { ok: false, reason: "insufficient" }   (server: 403)
//   anything else — disagreement, either throws / rejects, malformed holdings, timeout
//                             ⇒ { ok: false, reason: "unavailable" }    (server: 503, fail closed)

import type { Address } from "viem";

export interface Holdings {
  agentBal: bigint;
  agentSupply: bigint;
  platformBal: bigint;
  platformSupply: bigint;
}

export interface BalanceReader {
  holdings(wallet: Address): Promise<Holdings>;
}

export interface TimerHandle {
  promise: Promise<void>;
  cancel(): void;
}

/** Injectable timer; the default uses setTimeout. */
export interface GateTimer {
  after(ms: number): TimerHandle;
}

export const realTimer: GateTimer = {
  after(ms: number): TimerHandle {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<void>((resolve) => {
      handle = setTimeout(resolve, ms);
    });
    return {
      promise,
      cancel: () => {
        if (handle !== undefined) clearTimeout(handle);
      },
    };
  },
};

export interface GateParams {
  agentBps: number;
  platformBps: number;
}

export type GateResult =
  | { ok: true }
  | { ok: false; reason: "insufficient"; detail: string }
  | { ok: false; reason: "unavailable"; detail: string };

export interface DualGateOptions extends GateParams {
  timeoutMs: number;
  timer?: GateTimer;
}

export interface DualGate {
  check(wallet: Address): Promise<GateResult>;
}

const BPS = 10_000n;

function validHoldings(h: unknown): h is Holdings {
  if (typeof h !== "object" || h === null) return false;
  const r = h as Record<string, unknown>;
  for (const k of ["agentBal", "agentSupply", "platformBal", "platformSupply"]) {
    const v = r[k];
    if (typeof v !== "bigint" || v < 0n) return false;
  }
  return true;
}

/** Pure D9 predicate. A zero supply never passes its leg. */
export function gatePasses(h: Holdings, p: GateParams): boolean {
  const agentLeg = h.agentSupply > 0n && h.agentBal * BPS >= h.agentSupply * BigInt(p.agentBps);
  const platformLeg = h.platformSupply > 0n && h.platformBal * BPS >= h.platformSupply * BigInt(p.platformBps);
  return agentLeg || platformLeg;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const TIMEOUT = Symbol("timeout");

export function createDualGate(readers: readonly [BalanceReader, BalanceReader], opts: DualGateOptions): DualGate {
  const timer = opts.timer ?? realTimer;
  return {
    async check(wallet: Address): Promise<GateResult> {
      const read = (r: BalanceReader): Promise<Holdings> =>
        Promise.resolve()
          .then(() => r.holdings(wallet))
          .then((h) => {
            if (!validHoldings(h)) throw new Error("malformed holdings");
            return h;
          });
      const t = timer.after(opts.timeoutMs);
      try {
        const both = Promise.all([read(readers[0]), read(readers[1])]);
        const outcome = await Promise.race([both, t.promise.then((): typeof TIMEOUT => TIMEOUT)]);
        if (outcome === TIMEOUT) return { ok: false, reason: "unavailable", detail: `balance read timed out after ${opts.timeoutMs} ms` };
        const [a, b] = outcome;
        const pa = gatePasses(a, opts);
        const pb = gatePasses(b, opts);
        if (pa !== pb) return { ok: false, reason: "unavailable", detail: "balance readers disagree" };
        if (!pa) return { ok: false, reason: "insufficient", detail: "holdings below both gate thresholds" };
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: "unavailable", detail: `balance read failed: ${errMsg(e)}` };
      } finally {
        t.cancel();
      }
    },
  };
}
