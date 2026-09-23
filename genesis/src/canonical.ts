// SPEC-M3B §1 — the ONLY bridge into the runtime package. Hash consistency between the orchestrator
// and the runtime is load-bearing (the attested config-hash init param must equal what boot
// recomputes), so the encoding is NEVER reimplemented here: these are the runtime's own functions,
// resolved through the `agent-runtime` file: dependency (genesis/package.json → ../runtime).
export { canonicalEncode } from "agent-runtime/src/policy/approval.js";
export { frozenConfigHash, FrozenConfigFileSchema } from "agent-runtime/src/config/schema.js";
