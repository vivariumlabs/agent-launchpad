/**
 * Launch form rules (SPEC-M4B §3b) — pure, shared by the client form and the
 * web's prepare route. The launch-helper re-checks server-side; this is the
 * form-time layer.
 */
import { moderateAgent, type ModerationViolation } from "./moderation";
import type { LaunchAgentInput, LaunchModelOption, LaunchTemplate } from "./types";

export const NAME_MAX = 32;
export const SYMBOL_MAX = 8;
/** v1: warn (not block) when the model set spans fewer distinct operators than this. */
export const RECOMMENDED_OPERATORS = 3;

export interface LaunchValidation {
  /** Blocking, per field. */
  errors: Partial<Record<"name" | "symbol" | "archetype" | "persona" | "primary" | "fallbacks" | "chatTier", string>>;
  moderation: ModerationViolation[];
  /** Non-blocking. */
  warnings: string[];
  distinctOperators: number;
}

/** One pickable model = every allowlist entry serving that model name. */
export interface ModelChoice {
  model: string;
  operators: string[];
  tiers: string[];
  attested: boolean;
}

/**
 * agent.models refs are MODEL names: the launch-helper validates against
 * entry `model`, and the runtime resolves a ref to every entry whose id OR
 * model matches — so choosing a model enlists all operators serving it.
 */
export function modelChoices(models: LaunchModelOption[]): ModelChoice[] {
  const byModel = new Map<string, ModelChoice>();
  for (const m of models) {
    const c = byModel.get(m.model) ?? { model: m.model, operators: [], tiers: [], attested: false };
    if (!c.operators.includes(m.operator)) c.operators.push(m.operator);
    if (!c.tiers.includes(m.tier)) c.tiers.push(m.tier);
    c.attested = c.attested || m.attested === true;
    byModel.set(m.model, c);
  }
  return [...byModel.values()];
}

export function chatTiers(models: LaunchModelOption[]): string[] {
  return [...new Set(models.map((m) => m.tier))];
}

export function validateLaunchInput(
  input: LaunchAgentInput,
  template: LaunchTemplate,
): LaunchValidation {
  const errors: LaunchValidation["errors"] = {};
  const warnings: string[] = [];
  const models = template.defaults.models;

  const name = input.name.trim();
  if (name === "") errors.name = "Name is required.";
  else if (name.length > NAME_MAX) errors.name = `Name is ${name.length} characters (max ${NAME_MAX}).`;

  if (input.symbol === "") errors.symbol = "Symbol is required.";
  else if (!/^[A-Z0-9]+$/.test(input.symbol)) errors.symbol = "Symbol: uppercase letters and digits only.";
  else if (input.symbol.length > SYMBOL_MAX) errors.symbol = `Symbol is ${input.symbol.length} characters (max ${SYMBOL_MAX}).`;

  if (!template.defaults.archetypes.includes(input.archetype)) errors.archetype = "Pick an archetype.";

  const moderation = moderateAgent({ name: input.name, persona: input.persona });
  if (input.persona.trim() === "") errors.persona = "Persona is required.";

  const known = new Set(models.map((m) => m.model));
  const primaryOk = known.has(input.models.primary);
  if (!primaryOk) errors.primary = "Pick a primary model.";

  const fallbacks = input.models.fallbacks.filter((f) => known.has(f));
  if (fallbacks.length !== input.models.fallbacks.length)
    errors.fallbacks = "A fallback is not on the platform allowlist.";
  else if (fallbacks.length < 1) errors.fallbacks = "Pick at least one fallback model.";
  else if (fallbacks.includes(input.models.primary))
    errors.fallbacks = "A fallback cannot be the primary model.";
  else if (new Set(fallbacks).size !== fallbacks.length) errors.fallbacks = "Fallbacks must be distinct.";

  if (!chatTiers(models).includes(input.models.chatTier)) errors.chatTier = "Pick a chat tier.";

  const chosen = new Set([...(primaryOk ? [input.models.primary] : []), ...fallbacks]);
  const operators = new Set(models.filter((m) => chosen.has(m.model)).map((m) => m.operator));
  const distinctOperators = operators.size;
  if (primaryOk && fallbacks.length > 0 && distinctOperators < RECOMMENDED_OPERATORS) {
    warnings.push(
      `Your models span ${distinctOperators} distinct operator${distinctOperators === 1 ? "" : "s"}. ` +
        `We recommend at least ${RECOMMENDED_OPERATORS}: if one operator goes down or reprices, the agent keeps thinking on another.`,
    );
  }

  return { errors, moderation, warnings, distinctOperators };
}

export function isLaunchValid(v: LaunchValidation): boolean {
  return Object.keys(v.errors).length === 0 && v.moderation.length === 0;
}

/** Coerce an untrusted JSON body into a LaunchAgentInput, or null. */
export function parseLaunchBody(body: unknown): LaunchAgentInput | null {
  if (typeof body !== "object" || body === null) return null;
  const agent = (body as { agent?: unknown }).agent;
  if (typeof agent !== "object" || agent === null) return null;
  const a = agent as Record<string, unknown>;
  const m = a.models as Record<string, unknown> | undefined;
  if (
    typeof a.name !== "string" ||
    typeof a.symbol !== "string" ||
    typeof a.archetype !== "string" ||
    typeof a.persona !== "string" ||
    typeof m !== "object" ||
    m === null ||
    typeof m.primary !== "string" ||
    typeof m.chatTier !== "string" ||
    !Array.isArray(m.fallbacks) ||
    !m.fallbacks.every((f) => typeof f === "string")
  ) {
    return null;
  }
  return {
    name: a.name,
    symbol: a.symbol,
    archetype: a.archetype,
    persona: a.persona,
    models: { primary: m.primary, fallbacks: m.fallbacks as string[], chatTier: m.chatTier },
  };
}
