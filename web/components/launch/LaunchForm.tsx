"use client";

import { useMemo } from "react";

import { formatUsdg } from "@/lib/format";
import {
  NAME_MAX,
  RECOMMENDED_OPERATORS,
  SYMBOL_MAX,
  chatTiers,
  modelChoices,
  type LaunchValidation,
  type ModelChoice,
} from "@/lib/launch";
import {
  MODERATION_RUBRIC_VERSION,
  PERSONA_MAX_CHARS,
  type ModerationViolation,
} from "@/lib/moderation";
import type { LaunchAgentInput, LaunchTemplate } from "@/lib/types";

const inputClass =
  "w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-accent/60 focus:outline-none";

function modelLabel(c: ModelChoice): string {
  return `${c.model} · ${c.operators.join(", ")} · ${c.tiers.join("/")}${c.attested ? " · attested" : ""}`;
}

function ModerationList({ items }: { items: ModerationViolation[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-300">
      {items.map((v) => (
        <li key={`${v.rule}-${v.field}`}>
          <span className="font-mono text-red-400/80">{v.rule}</span> {v.message}
          <span className="text-red-400/80">
            {" "}
            (matched: “<span className="font-mono">{v.match}</span>”)
          </span>
        </li>
      ))}
    </ul>
  );
}

export function LaunchForm({
  template,
  input,
  onChange,
  validation,
  showErrors,
  onSubmit,
  submitting,
  serverViolations,
  submitError,
}: {
  template: LaunchTemplate;
  input: LaunchAgentInput;
  onChange: (next: LaunchAgentInput) => void;
  validation: LaunchValidation;
  showErrors: boolean;
  onSubmit: () => void;
  submitting: boolean;
  serverViolations: string[];
  submitError: string | null;
}) {
  const models = template.defaults.models;
  const tiers = useMemo(() => chatTiers(models), [models]);
  const choices = useMemo(() => modelChoices(models), [models]);
  const nameViolations = validation.moderation.filter((v) => v.field === "name");
  const personaViolations = validation.moderation.filter((v) => v.field === "persona");
  const { errors } = validation;
  const err = (k: keyof LaunchValidation["errors"]) =>
    showErrors && errors[k] ? <p className="mt-1 text-xs text-red-400">{errors[k]}</p> : null;

  const set = (patch: Partial<LaunchAgentInput>) => onChange({ ...input, ...patch });
  const setModels = (patch: Partial<LaunchAgentInput["models"]>) =>
    onChange({ ...input, models: { ...input.models, ...patch } });

  const personaLen = input.persona.length;

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {/* Identity */}
      <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_10rem]">
        <label className="flex flex-col gap-1">
          <span className="flex justify-between text-xs uppercase tracking-wide text-slate-500">
            Name
            <span className={input.name.trim().length > NAME_MAX ? "text-red-400" : ""}>
              {input.name.trim().length}/{NAME_MAX}
            </span>
          </span>
          <input
            className={inputClass}
            value={input.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Cato"
            autoComplete="off"
          />
          {err("name")}
          <ModerationList items={nameViolations} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="flex justify-between text-xs uppercase tracking-wide text-slate-500">
            Symbol
            <span>
              {input.symbol.length}/{SYMBOL_MAX}
            </span>
          </span>
          <input
            className={`${inputClass} font-mono uppercase`}
            value={input.symbol}
            maxLength={SYMBOL_MAX}
            onChange={(e) => set({ symbol: e.target.value.toUpperCase().replace(/\s+/g, "") })}
            placeholder="CATO"
            autoComplete="off"
          />
          {err("symbol")}
        </label>
      </fieldset>

      {/* Archetype */}
      <fieldset>
        <legend className="mb-2 text-xs uppercase tracking-wide text-slate-500">Archetype</legend>
        <div className="flex flex-wrap gap-2">
          {template.defaults.archetypes.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => set({ archetype: a })}
              aria-pressed={input.archetype === a}
              className={`rounded-md border px-3 py-1.5 text-sm capitalize transition ${
                input.archetype === a
                  ? "border-accent/50 bg-accent/15 text-accent"
                  : "border-slate-700 text-slate-400 hover:border-slate-600 hover:text-slate-200"
              }`}
            >
              {a}
            </button>
          ))}
        </div>
        {err("archetype")}
      </fieldset>

      {/* Persona + live moderation (R5) */}
      <fieldset>
        <label className="flex flex-col gap-1">
          <span className="flex justify-between text-xs uppercase tracking-wide text-slate-500">
            Persona
            <span className={personaLen > PERSONA_MAX_CHARS ? "text-red-400" : ""}>
              {personaLen}/{PERSONA_MAX_CHARS}
            </span>
          </span>
          <textarea
            className={`${inputClass} min-h-40 leading-relaxed`}
            value={input.persona}
            onChange={(e) => set({ persona: e.target.value })}
            placeholder="Who is this agent? How does it speak, what does it care about, how does it trade?"
          />
        </label>
        {personaViolations.length > 0 ? (
          <ModerationList items={personaViolations} />
        ) : input.persona.trim() !== "" ? (
          <p className="mt-1 text-xs text-emerald-400/80">
            Passes the moderation rubric {MODERATION_RUBRIC_VERSION} form-time check (re-checked
            server-side on submit).
          </p>
        ) : null}
        {err("persona")}
        <p className="mt-1 text-xs text-slate-500">
          Tip: avoid hardcoding trade amounts — per-transaction caps apply regardless of what the
          persona says.
        </p>
      </fieldset>

      {/* Models */}
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-xs uppercase tracking-wide text-slate-500">
          Models (from the platform allowlist)
        </legend>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-400">Primary</span>
          <select
            className={inputClass}
            value={input.models.primary}
            onChange={(e) =>
              setModels({
                primary: e.target.value,
                fallbacks: input.models.fallbacks.filter((f) => f !== e.target.value),
              })
            }
          >
            <option value="">Select a model…</option>
            {choices.map((c) => (
              <option key={c.model} value={c.model}>
                {modelLabel(c)}
              </option>
            ))}
          </select>
          {err("primary")}
        </label>

        <div>
          <span className="text-xs text-slate-400">Fallbacks (at least one, in order of preference)</span>
          <ul className="mt-1 flex flex-col gap-1">
            {choices
              .filter((c) => c.model !== input.models.primary)
              .map((c) => {
                const idx = input.models.fallbacks.indexOf(c.model);
                const checked = idx >= 0;
                return (
                  <li key={c.model}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm text-slate-300 hover:bg-slate-900">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setModels({
                            fallbacks: checked
                              ? input.models.fallbacks.filter((f) => f !== c.model)
                              : [...input.models.fallbacks, c.model],
                          })
                        }
                        className="accent-sky-400"
                      />
                      <span className="flex-1">{modelLabel(c)}</span>
                      {checked ? <span className="text-xs text-slate-500">#{idx + 1}</span> : null}
                    </label>
                  </li>
                );
              })}
          </ul>
          {err("fallbacks")}
        </div>

        <label className="flex flex-col gap-1 sm:max-w-xs">
          <span className="text-xs text-slate-400">Chat tier</span>
          <select
            className={inputClass}
            value={input.models.chatTier}
            onChange={(e) => setModels({ chatTier: e.target.value })}
          >
            {tiers.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {err("chatTier")}
        </label>

        <p className="text-xs text-slate-500">
          Distinct operators: {validation.distinctOperators} (recommended ≥ {RECOMMENDED_OPERATORS})
        </p>
        {validation.warnings.map((w) => (
          <p key={w} className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-300">
            {w}
          </p>
        ))}
      </fieldset>

      {/* Cost preview */}
      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-sm">
        <p className="text-xs uppercase tracking-wide text-slate-500">Cost</p>
        <p className="mt-1 font-mono text-slate-100">
          {formatUsdg(template.defaults.creationFeeUsdg)} USDG + gas
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Creation fee, escrowed by the factory until your agent goes live. Gas (RH ETH) for up to
          two transactions: USDG approve (if needed) and createAgent.
        </p>
      </section>

      {serverViolations.length > 0 ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
          <p className="font-medium">The launch helper rejected this agent (server-side check):</p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {serverViolations.map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {submitError ? (
        <p className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
          {submitError}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={submitting}
        className="self-start rounded-md border border-accent/40 bg-accent/15 px-4 py-2 text-sm font-medium text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Preparing…" : "Prepare launch"}
      </button>
    </form>
  );
}
