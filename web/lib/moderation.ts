/**
 * Persona moderation v1 — client-side copy for live form feedback
 * (SPEC-M4B R5).
 *
 * KEEP IN SYNC with the versioned rubric at docs/policy/persona-moderation.md
 * (v1 — the contract) and with the launch-helper's server-side copy
 * genesis/src/moderation.ts, which this file mirrors rule-for-rule (same
 * ids, patterns, fields, messages). Deliberately DUPLICATED: no cross-package
 * import into the Next bundle (SPEC-M4A §2). Bump MODERATION_RUBRIC_VERSION
 * in all three places on any change. The SERVER is authoritative: prepare
 * re-runs moderation and returns 422 {violations}.
 *
 * v1 is conservative: obvious cases only; anything ambiguous passes.
 * Applied to `name` and `persona`. Pure, deterministic.
 */

export const MODERATION_RUBRIC_VERSION = "v1";
/** R5 length cap (= runtime AgentConfigSchema persona .max(2000), UTF-16 code units like zod). */
export const PERSONA_MAX_CHARS = 2000;

export type ModerationCategory =
  | "length"
  | "impersonation"
  | "illegality"
  | "harassment"
  | "securities";
export type ModeratedField = "name" | "persona";

export interface ModerationViolation {
  category: ModerationCategory;
  /** Rubric rule id (docs/policy/persona-moderation.md). */
  rule: string;
  field: ModeratedField;
  /** The matched text (≤ 80 chars). */
  match: string;
  message: string;
}

/** I1/I4 list — rubric v1 §2 (extend only via a rubric version bump). */
const IMPERSONATION_NAMES: readonly string[] = [
  "elon musk",
  "donald trump",
  "joe biden",
  "kamala harris",
  "barack obama",
  "vitalik buterin",
  "changpeng zhao",
  "sam altman",
  "mark zuckerberg",
  "jeff bezos",
  "bill gates",
  "warren buffett",
  "michael saylor",
  "brian armstrong",
  "gary gensler",
  "jerome powell",
  "satoshi nakamoto",
  "taylor swift",
  "pope francis",
  "vlad tenev",
];

const NAMES_ALT = IMPERSONATION_NAMES.map((n) => n.replace(/ /g, "\\s+")).join("|");

interface Rule {
  id: string;
  category: Exclude<ModerationCategory, "length">;
  fields: readonly ModeratedField[];
  re: RegExp;
  message: string;
}

/** Rubric v1 §2–§5. Case-insensitive unless noted; applied to whitespace-normalized text. */
const RULES: readonly Rule[] = [
  // §2 impersonation of real named people
  {
    id: "I1",
    category: "impersonation",
    fields: ["persona"],
    re: new RegExp(
      `\\b(?:i\\s+am|i'm|you\\s+are|you're|act\\s+as|acting\\s+as|pretend(?:ing)?\\s+to\\s+be|pose\\s+as|posing\\s+as|speak\\s+as|roleplay\\s+as|impersonat(?:e|es|ing))\\s+(?:the\\s+real\\s+)?(?:${NAMES_ALT})\\b`,
      "i",
    ),
    message: "claims to be (or to impersonate) a real, named public figure",
  },
  {
    id: "I2",
    category: "impersonation",
    fields: ["persona"],
    // Case-SENSITIVE name part.
    re: /\b(?:(?:[Ii] am|[Ii]'m|[Yy]ou are|[Yy]ou're) the real|[Oo]fficial (?:account|voice|representative|spokesperson) of)\s+[A-Z][a-z]+\s+[A-Z][a-z]+/,
    message: "presents itself as the real / official voice of a named person",
  },
  {
    id: "I3",
    category: "impersonation",
    fields: ["persona"],
    // Case-SENSITIVE name part.
    re: /\b[Ii]mpersonat(?:e|es|ing)\s+[A-Z][a-z]+\s+[A-Z][a-z]+/,
    message: "instructs the agent to impersonate a named person",
  },
  {
    id: "I4",
    category: "impersonation",
    fields: ["name"],
    re: new RegExp(`\\b(?:${NAMES_ALT})\\b`, "i"),
    message: "agent name is a real, named public figure",
  },
  // §3 instruction-to-illegality
  {
    id: "L1",
    category: "illegality",
    fields: ["persona"],
    re: /\b(?:how\s+to|help\s+(?:me|users|people|them)\s+(?:to\s+)?|teach\s+(?:me|users|people|them)\s+(?:how\s+)?to|instructions?\s+(?:for|to|on)|steps?\s+to|guide\s+(?:to|for|on))\s*(?:make|build|synthesi[sz]e|cook|manufacture|assemble)\s+(?:a\s+|an\s+)?(?:bombs?|explosives?|pipe\s+bombs?|meth(?:amphetamine)?|fentanyl|nerve\s+agents?|sarin|ricin|bio-?weapons?|chemical\s+weapons?|ghost\s+guns?)\b/i,
    message: "instructions for weapons / hard-drug manufacture",
  },
  {
    id: "L2",
    category: "illegality",
    fields: ["persona"],
    re: /\b(?:launder(?:ing)?\s+(?:money|funds|crypto|proceeds)|(?:evade|evading|bypass|bypassing|circumvent(?:ing)?)\s+(?:sanctions|kyc|aml|taxes)|(?:steal|stealing|drain|draining)\s+(?:(?:user|people's|their|victims'?)\s+)?(?:wallets?|funds|private\s+keys?|seed\s+phrases?)|phishing\s+(?:kits?|sites?|pages?|links?|campaigns?))\b/i,
    message: "facilitates financial crime (laundering, sanctions/KYC evasion, theft, phishing)",
  },
  {
    id: "L3",
    category: "illegality",
    fields: ["persona"],
    re: /\b(?:hack(?:ing)?\s+into|(?:sell|selling|buy|buying)\s+(?:stolen|illegal\s+drugs|hard\s+drugs|illegal\s+weapons)|child\s+(?:porn(?:ography)?|sexual\s+abuse\s+material)|csam)\b/i,
    message: "instructs illegal activity (intrusion, contraband, CSAM)",
  },
  // §4 harassment targeting
  {
    id: "H1",
    category: "harassment",
    fields: ["persona"],
    re: /\b(?:harass|harassing|bully|bullying|threaten|threatening|intimidate|intimidating|stalk|stalking|dox|doxx|doxing|doxxing|brigade|brigading|insult|insulting|attack|attacking|troll|trolling|spam|spamming)\s+(?:@[A-Za-z0-9_.]{1,30}|(?:this|that|a\s+specific|one\s+specific)\s+(?:person|user|account|individual|guy|woman|man))/i,
    message: "directs the agent at a specific person or account (harassment targeting)",
  },
  {
    id: "H2",
    category: "harassment",
    fields: ["persona"],
    re: /\b(?:kill|rape|beat\s+up|murder)\s+(?:yourself|him|her|them|@[A-Za-z0-9_.]{1,30})\b|\bkys\b/i,
    message: "violent threat",
  },
  // §5 securities-pitch language
  {
    id: "S1",
    category: "securities",
    fields: ["persona"],
    re: /\b(?:guaranteed|risk[-\s]?free|assured)\s+(?:returns?|profits?|gains?|income|yield|apy|apr|roi)\b/i,
    message: "promises guaranteed / risk-free returns",
  },
  {
    id: "S2",
    category: "securities",
    fields: ["persona"],
    re: /\b(?:holders?|investors?|buyers?|you)\s+(?:will\s+|can\s+|could\s+)?(?:get|earn|make|receive|see)\s+(?:up\s+to\s+|at\s+least\s+)?\d+(?:\.\d+)?\s*(?:x|×|%)/i,
    message: "promises holders a specific return multiple / percentage",
  },
  {
    id: "S3",
    category: "securities",
    fields: ["persona"],
    re: /\b(?:invest\s+(?:in|now\s+in)\s+(?:my|our|this)\s+(?:token|coin|agent)|holders?\s+will\s+(?:profit|earn|get\s+rich|be\s+paid)|passive\s+income|dividends?\s+(?:to|for)\s+holders|(?:profit|revenue)[-\s]shar(?:e|ing)\s+(?:with|for|to)\s+holders|get\s+rich\s+quick)\b/i,
    message: "pitches the token as an investment (securities-pitch language)",
  },
];

function normalize(s: string): string {
  // Collapse whitespace (incl. newlines) and fold typographic apostrophes so "I’m" matches "i'm".
  return s.replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
}

function excerpt(s: string): string {
  return s.length <= 80 ? s : `${s.slice(0, 77)}...`;
}

/** R5 v1 over one field's text. Pure. */
export function moderateText(field: ModeratedField, text: string): ModerationViolation[] {
  const out: ModerationViolation[] = [];
  if (field === "persona" && text.length > PERSONA_MAX_CHARS) {
    out.push({
      category: "length",
      rule: "LEN",
      field,
      match: `${text.length} chars`,
      message: `persona is ${text.length} chars (max ${PERSONA_MAX_CHARS})`,
    });
  }
  const t = normalize(text);
  for (const r of RULES) {
    if (!r.fields.includes(field)) continue;
    const m = r.re.exec(t);
    if (m !== null) {
      out.push({ category: r.category, rule: r.id, field, match: excerpt(m[0]), message: r.message });
    }
  }
  return out;
}

/** R5 v1 over the agent's free-text identity (name + persona). Empty = no objection. */
export function moderateAgent(a: { name: string; persona: string }): ModerationViolation[] {
  return [...moderateText("name", a.name), ...moderateText("persona", a.persona)];
}

/** One-line display string for a violation. */
export function describeViolation(v: Pick<ModerationViolation, "field" | "rule" | "message">): string {
  return `${v.field} · ${v.rule}: ${v.message}`;
}
