"use client";

import { useMemo, useRef, useState } from "react";

import { LaunchForm } from "./LaunchForm";
import { LaunchReview } from "./LaunchReview";
import { isArweaveItemId } from "@/lib/config";
import { sameHex } from "@/lib/format";
import {
  chatTiers,
  exactAgentJsonText,
  isLaunchValid,
  validateLaunchInput,
  type PublishState,
} from "@/lib/launch";
import type { LaunchAgentInput, LaunchPrepared, LaunchPublished, LaunchTemplate } from "@/lib/types";

type Phase =
  | { kind: "form" }
  | { kind: "review"; prepared: LaunchPrepared; input: LaunchAgentInput };

function isPublished(v: unknown): v is LaunchPublished {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.txId === "string" && isArweaveItemId(p.txId);
}

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
    (p.agentJsonText === undefined || typeof p.agentJsonText === "string") &&
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

/**
 * /launch client flow: form → POST /api/launch/prepare (web proxy, R4) →
 * POST /api/launch/publish (config → Arweave, SPEC-M4E R3) → review →
 * wallet → tracker.
 */
export function LaunchFlow({
  template,
  fixtures,
  fixtureFailFirstPublish = false,
  primaryFactory,
}: {
  template: LaunchTemplate;
  fixtures: boolean;
  /** SPEC-M4G: the primary (v2) factory from /api/contracts; null = unavailable (launch tx disabled). */
  primaryFactory: `0x${string}` | null;
  /** Fixtures only (`/launch?publish=fail`): the first publish attempt answers 502, to walk the retry UI. */
  fixtureFailFirstPublish?: boolean;
}) {
  const [input, setInput] = useState<LaunchAgentInput>(() => initialInput(template));
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [showErrors, setShowErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverViolations, setServerViolations] = useState<string[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [publish, setPublish] = useState<PublishState>({ kind: "publishing" });
  /** Bumped per prepare/back: a late publish result for an abandoned review is dropped. */
  const publishGen = useRef(0);
  const publishAttempts = useRef(0);

  const validation = useMemo(() => validateLaunchInput(input, template), [input, template]);

  async function runPublish(prepared: LaunchPrepared) {
    const my = publishGen.current;
    const text = exactAgentJsonText(prepared);
    if (text === null) {
      setPublish({
        kind: "error",
        retryable: false,
        message:
          "The launch helper did not return the exact agent.json text, so the config cannot be published to Arweave from here. Launching now would leave genesis unable to find your config.",
      });
      return;
    }
    setPublish({ kind: "publishing" });
    publishAttempts.current += 1;
    const failThis = fixtures && fixtureFailFirstPublish && publishAttempts.current === 1;
    try {
      const res = await fetch("/api/launch/publish", {
        method: "POST",
        headers: { "content-type": "application/json", ...(failThis ? { "x-fixture-publish": "fail" } : {}) },
        body: JSON.stringify({ agentJsonText: text, configHash: prepared.configHash }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (my !== publishGen.current) return;
      if (res.ok && isPublished(body)) {
        if (typeof body.configHash === "string" && !sameHex(body.configHash, prepared.configHash)) {
          setPublish({
            kind: "error",
            retryable: false,
            message: `The published item's configHash (${body.configHash}) does not match the prepared one — not launching. Go back and prepare again.`,
          });
          return;
        }
        setPublish({ kind: "published", txId: body.txId, ref: `ar://${body.txId}` });
        return;
      }
      const b = (body ?? {}) as { error?: unknown; reason?: unknown };
      const detail = [b.error, b.reason].filter((x): x is string => typeof x === "string").join(" — ");
      const suffix = detail !== "" ? `: ${detail}` : "";
      if (res.ok) {
        setPublish({ kind: "error", retryable: true, message: "The launch helper returned an unexpected publish response." });
      } else if (res.status === 413) {
        setPublish({ kind: "error", retryable: false, message: `agent.json is too large for a free Arweave upload (413)${suffix}.` });
      } else if (res.status === 422) {
        setPublish({
          kind: "error",
          retryable: false,
          message: `The launch helper rejected the config text (422 — hash or schema mismatch)${suffix}. Go back and prepare again.`,
        });
      } else {
        setPublish({ kind: "error", retryable: true, message: `Arweave upload failed (${res.status})${suffix}.` });
      }
    } catch (err) {
      if (my !== publishGen.current) return;
      setPublish({
        kind: "error",
        retryable: true,
        message: `Could not reach the site's publish endpoint: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

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
      publishGen.current += 1;
      setPhase({ kind: "review", prepared: body, input: { ...input, name: input.name.trim() } });
      void runPublish(body);
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
        primaryFactory={primaryFactory}
        publish={publish}
        onRetryPublish={() => void runPublish(phase.prepared)}
        onBack={() => {
          publishGen.current += 1;
          setPhase({ kind: "form" });
        }}
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
