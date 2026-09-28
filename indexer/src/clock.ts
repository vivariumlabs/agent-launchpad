// The ONE wall-clock seam (genesis/src/clock.ts pattern). Everything else takes `now: bigint`
// (unix seconds) as an argument or an injected Clock.

export interface Clock {
  now(): bigint;
}

export const systemClock: Clock = {
  now: () => BigInt(Math.floor(Date.now() / 1000)),
};

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
