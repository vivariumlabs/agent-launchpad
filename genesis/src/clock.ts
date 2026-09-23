// The ONE wall-clock seam (hygiene test allowlists Date.now here only). Everything else takes
// `now: bigint` (unix seconds) as an argument.

export interface Clock {
  now(): bigint;
}

export const systemClock: Clock = {
  now: () => BigInt(Math.floor(Date.now() / 1000)),
};

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
