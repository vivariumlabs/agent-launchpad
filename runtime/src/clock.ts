// SPEC-M2C §3. The runtime's single wall-clock source. This is THE ONLY file in
// src/ permitted to read Date.now (hygiene test allowlist); every other module
// takes time from an injected Clock.

import type { UnixSeconds } from "./policy/types.js";

/** Injected time source: current unix time in whole seconds. */
export type Clock = () => UnixSeconds;

export const systemClock: Clock = () => BigInt(Math.trunc(Date.now() / 1000));
