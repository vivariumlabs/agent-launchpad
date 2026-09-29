"use client";

import { useMemo, useState } from "react";

import { LaunchForm } from "./LaunchForm";
import { LaunchReview } from "./LaunchReview";
import { chatTiers, isLaunchValid, validateLaunchInput } from "@/lib/launch";
import type { LaunchAgentInput, LaunchPrepared, LaunchTemplate } from "@/lib/types";

type Phase =
  | { kind: "form" }
  | { kind: "review"; prepared: LaunchPrepared; input: LaunchAgentInput };

function initialInput(template: LaunchTemplate): LaunchAgentInput {
  const tiers = chatTiers(template.defaults.models);
  const defaultTier = template.defaults.chatTier;
  return {
    name: "",
    symbol: "",
    archetype: template.defaults.archetypes[0] ?? "",
    persona: "",
    models: {
      primary: "",
      fallbacks: [],
      chatTier:
        defaultTier && tiers.includes(defaultTier)
          ? defaultTier
          : tiers.includes("cheap")
            ? "cheap"
            : (tiers[0] ?? ""),
    },
  };
}

function isPrepared(v: unknown): v is LaunchPrepared {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  const ca = p.createArgs as Record<string, unknown> | undefined;
  return (
    typeof p.agentId === "number" &&
    Number.isSafeInteger(p.agentId) &&
    (typeof p.agentJson === "string" || (typeof p.agentJson === "object" && p.agentJson !== null)) &&
    typeof p.configHash === "string" &&
    typeof p.imageId === "string" &&
    typeof p.expectedTreasuryEOA === "string" &&
    typeof p.actionEOA === "string" &&
    typeof ca === "object" &&
    ca !== null &&
    typeof ca.factory === "string" &&
    typeof ca.usdg === "string" &&
    typeof ca.fee === "string"
  );
}

/**
 * Server-side rejection details -> display strings. Accepts plain strings
 * (pinned shape), the helper's moderation Violation objects
 * {field, rule, message, match} and zod-style issues {path, message}.
 */
function serverMessages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string") out.push(v);
    else if (typeof v === "object" && v !== null && typeof (v as { message?: unknown }).message === "string") {
      const o = v as { message: string; field?: unknown; rule?: unknown; path?: unknown; match?: unknown };
      const where = [o.field, o.rule, o.path].filter((x): x is string => typeof x === "string" && x !== "");
      const match = typeof o.match === "string" ? ` (matched: “${o.match}”)` : "";
      out.push(`${where.length > 0 ? `${where.join(" · ")}: ` : ""}${o.message}${match}`);
    }
  }
  return out;
}

/** /launch client flow: form → POST /api/launch/prepare (web proxy, R4) → review → wallet → tracker. */
export function LaunchFlow({ template, fixtures }: { template: LaunchTemplate; fixtures: boolean }) {
  const [input, setInput] = useState<LaunchAgentInput>(() => initialInput(template));
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [showErrors, setShowErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverViolations, setServerViolations] = useState<string[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const validation = useMemo(() => validateLaunchInput(input, template), [input, template]);

  async function submit() {
    setShowErrors(true);
    setServerViolations([]);
    setSubmitError(null);
    if (!isLaunchValid(validation)) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/launch/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: { ...input, name: input.name.trim() } }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (res.status === 422) {
        const v = serverMessages((body as { violations?: unknown } | null)?.violations);
        setServerViolations(v.length > 0 ? v : ["Rejected by server-side moderation (no reason given)."]);
        return;
      }
      if (res.status === 400) {
        const v = serverMessages((body as { issues?: unknown } | null)?.issues);
        if (v.length > 0) {
          setServerViolations(v);
          return;
        }
      }
      if (!res.ok) {
        const b = (body ?? {}) as { error?: unknown; reason?: unknown; stage?: unknown };
        const parts = [b.error, b.stage, b.reason].filter((x): x is string => typeof x === "string");
        setSubmitError(
          `Could not prepare the launch (${res.status})${parts.length > 0 ? `: ${parts.join(" — ")}` : ""}. Nothing was submitted on-chain.`,
        );
        return;
      }
      if (!isPrepared(body)) {
        setSubmitError("The launch helper returned an unexpected response. Nothing was submitted on-chain.");
        return;
      }
      setPhase({ kind: "review", prepared: body, input: { ...input, name: input.name.trim() } });
    } catch (err) {
      setSubmitError(
        `Could not reach the site's launch endpoint: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (phase.kind === "review") {
    return (
      <LaunchReview
        input={phase.input}
        prepared={phase.prepared}
        fixtures={fixtures}
        onBack={() => setPhase({ kind: "form" })}
      />
    );
  }

  return (
    <LaunchForm
      template={template}
      input={input}
      onChange={setInput}
      validation={validation}
      showErrors={showErrors}
      onSubmit={submit}
      submitting={submitting}
      serverViolations={serverViolations}
      submitError={submitError}
    />
  );
}
