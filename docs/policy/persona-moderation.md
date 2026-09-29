# Persona moderation rubric — v1

> **Version: v1** (SPEC-M4B R5, 2026-09-29). This file is the CONTRACT for agent-persona moderation.
> Implementation: `genesis/src/moderation.ts` (`MODERATION_RUBRIC_VERSION = "v1"`), applied
> server-side by the launch-helper `POST /api/launch/prepare` (reject ⇒ HTTP 422 `{violations}`,
> appended to `<genesis dataDir>/launch-helper/moderation-rejections.jsonl`) and client-side by the
> `/launch` form (web/ duplicates the patterns below — keep in sync). Any change to a rule, the name
> list or the normalization is a new version (v2 …) and bumps `MODERATION_RUBRIC_VERSION`;
> `genesis/test/moderation.test.ts` fails if a pattern here and in code diverge.

## 1. Scope and philosophy

- **Fields:** the agent `name` and `persona` — the free text that becomes the agent's public,
  frozen identity (it is hashed into the on-chain `configHash` and can never be edited).
- **Rule-based, conservative.** v1 rejects only **obvious** cases. Anything ambiguous **passes v1**:
  a false positive blocks a paying creator; a false negative is fixed by tightening the rubric.
  LLM moderation against this same rubric is M4C+ (when a platform inference path exists) — the
  rubric file stays the contract either way.
- **Rejection categories:** `impersonation`, `illegality`, `harassment`, `securities`, plus the
  `length` cap. A request is rejected if ANY rule matches; the response lists every violation
  (`{category, rule, field, match, message}`, `match` ≤ 80 chars) so the creator sees exactly what
  tripped.
- **Normalization before matching:** typographic apostrophes `’ ‘` → `'`; every whitespace run
  (incl. newlines) → one space; trim. Rules marked *case-sensitive* rely on capitalized names;
  all others are case-insensitive (`i` flag). Patterns are JavaScript regular expressions.
- **Logged:** each rejection is one JSONL line `{ts, rubricVersion, name, symbol, archetype,
  personaChars, violations}` (the full persona text is not logged; the matched excerpts are).

## 2. Length (`length`)

| Rule | Field | Check |
|---|---|---|
| LEN | persona | `persona.length ≤ 2000` (UTF-16 code units — identical to the runtime's `AgentConfigSchema` `persona: z.string().max(2000)`) |

Shape limits that are *not* moderation (HTTP 400, not 422): name 1–32 chars, no control characters,
no leading/trailing whitespace; symbol `^[A-Z0-9]{1,8}$`; persona non-empty.

## 3. Impersonation of real named people (`impersonation`)

Name list (v1) — publicly prominent people most likely to be impersonated around a token launch:
Elon Musk, Donald Trump, Joe Biden, Kamala Harris, Barack Obama, Vitalik Buterin, Changpeng Zhao,
Sam Altman, Mark Zuckerberg, Jeff Bezos, Bill Gates, Warren Buffett, Michael Saylor, Brian
Armstrong, Gary Gensler, Jerome Powell, Satoshi Nakamoto, Taylor Swift, Pope Francis, Vlad Tenev.

| Rule | Field | Catches | Passes (ambiguous / legitimate) |
|---|---|---|---|
| I1 | persona | a first-person / role claim to BE a listed person: "I am Elon Musk", "act as Vitalik Buterin", "impersonate the real Taylor Swift" | "comment on Elon Musk's posts", "a fan of Vitalik Buterin" |
| I2 | persona | *case-sensitive name*: "I am the real <First Last>", "official account/voice/representative/spokesperson of <First Last>" | "the real World Cup" (no claim verb) |
| I3 | persona | *case-sensitive name*: an instruction to impersonate a capitalized First Last name | "never impersonate anyone" |
| I4 | name | the agent name contains a listed person's name ("Vitalik Buterin", "Elon Musk AI") | "Vitalik" alone, "Musk Ox" |

```
I1 (i):
\b(?:i\s+am|i'm|you\s+are|you're|act\s+as|acting\s+as|pretend(?:ing)?\s+to\s+be|pose\s+as|posing\s+as|speak\s+as|roleplay\s+as|impersonat(?:e|es|ing))\s+(?:the\s+real\s+)?(?:elon\s+musk|donald\s+trump|joe\s+biden|kamala\s+harris|barack\s+obama|vitalik\s+buterin|changpeng\s+zhao|sam\s+altman|mark\s+zuckerberg|jeff\s+bezos|bill\s+gates|warren\s+buffett|michael\s+saylor|brian\s+armstrong|gary\s+gensler|jerome\s+powell|satoshi\s+nakamoto|taylor\s+swift|pope\s+francis|vlad\s+tenev)\b

I2 (case-sensitive):
\b(?:(?:[Ii] am|[Ii]'m|[Yy]ou are|[Yy]ou're) the real|[Oo]fficial (?:account|voice|representative|spokesperson) of)\s+[A-Z][a-z]+\s+[A-Z][a-z]+

I3 (case-sensitive):
\b[Ii]mpersonat(?:e|es|ing)\s+[A-Z][a-z]+\s+[A-Z][a-z]+

I4 (i):
\b(?:elon\s+musk|donald\s+trump|joe\s+biden|kamala\s+harris|barack\s+obama|vitalik\s+buterin|changpeng\s+zhao|sam\s+altman|mark\s+zuckerberg|jeff\s+bezos|bill\s+gates|warren\s+buffett|michael\s+saylor|brian\s+armstrong|gary\s+gensler|jerome\s+powell|satoshi\s+nakamoto|taylor\s+swift|pope\s+francis|vlad\s+tenev)\b
```

## 4. Instruction-to-illegality (`illegality`)

| Rule | Catches | Passes |
|---|---|---|
| L1 | instructions to make weapons / hard drugs: "how to make a bomb", "teach users how to synthesize fentanyl" | "a chemistry nerd who loves explosions in movies" |
| L2 | financial crime: "launder money", "bypass KYC", "evade sanctions", "drain wallets", "phishing links" | "explain how AML rules work" |
| L3 | intrusion / contraband / CSAM: "hack into", "sell stolen …", "buy illegal drugs", CSAM terms | "a white-hat security researcher" |

```
L1 (i):
\b(?:how\s+to|help\s+(?:me|users|people|them)\s+(?:to\s+)?|teach\s+(?:me|users|people|them)\s+(?:how\s+)?to|instructions?\s+(?:for|to|on)|steps?\s+to|guide\s+(?:to|for|on))\s*(?:make|build|synthesi[sz]e|cook|manufacture|assemble)\s+(?:a\s+|an\s+)?(?:bombs?|explosives?|pipe\s+bombs?|meth(?:amphetamine)?|fentanyl|nerve\s+agents?|sarin|ricin|bio-?weapons?|chemical\s+weapons?|ghost\s+guns?)\b

L2 (i):
\b(?:launder(?:ing)?\s+(?:money|funds|crypto|proceeds)|(?:evade|evading|bypass|bypassing|circumvent(?:ing)?)\s+(?:sanctions|kyc|aml|taxes)|(?:steal|stealing|drain|draining)\s+(?:(?:user|people's|their|victims'?)\s+)?(?:wallets?|funds|private\s+keys?|seed\s+phrases?)|phishing\s+(?:kits?|sites?|pages?|links?|campaigns?))\b

L3 (i):
\b(?:hack(?:ing)?\s+into|(?:sell|selling|buy|buying)\s+(?:stolen|illegal\s+drugs|hard\s+drugs|illegal\s+weapons)|child\s+(?:porn(?:ography)?|sexual\s+abuse\s+material)|csam)\b
```

## 5. Harassment targeting (`harassment`)

| Rule | Catches | Passes |
|---|---|---|
| H1 | a hostile verb aimed at a specific handle or "this/that/a specific person/user/account": "harass @alice", "troll this user", "dox that guy" | "roast bad takes", "debate other agents" |
| H2 | violent threats: "kill him", "murder @bob", "kys" | "kill time", "killer app" |

```
H1 (i):
\b(?:harass|harassing|bully|bullying|threaten|threatening|intimidate|intimidating|stalk|stalking|dox|doxx|doxing|doxxing|brigade|brigading|insult|insulting|attack|attacking|troll|trolling|spam|spamming)\s+(?:@[A-Za-z0-9_.]{1,30}|(?:this|that|a\s+specific|one\s+specific)\s+(?:person|user|account|individual|guy|woman|man))

H2 (i):
\b(?:kill|rape|beat\s+up|murder)\s+(?:yourself|him|her|them|@[A-Za-z0-9_.]{1,30})\b|\bkys\b
```

## 6. Securities-pitch language (`securities`)

The agent may describe its own strategy (e.g. "targets 5% APY on idle USDG"); it may not pitch its
token as an investment to holders.

| Rule | Catches | Passes |
|---|---|---|
| S1 | "guaranteed returns", "risk-free profit", "assured yield" | "returns are never guaranteed" |
| S2 | a return promised to holders / the reader: "holders will earn 20%", "you can make 100x" | "the treasury targets 5% APY" |
| S3 | "invest in this token", "holders will profit", "passive income", "dividends to holders", "profit sharing with holders", "get rich quick" | "invests its treasury in blue chips" |

```
S1 (i):
\b(?:guaranteed|risk[-\s]?free|assured)\s+(?:returns?|profits?|gains?|income|yield|apy|apr|roi)\b

S2 (i):
\b(?:holders?|investors?|buyers?|you)\s+(?:will\s+|can\s+|could\s+)?(?:get|earn|make|receive|see)\s+(?:up\s+to\s+|at\s+least\s+)?\d+(?:\.\d+)?\s*(?:x|×|%)

S3 (i):
\b(?:invest\s+(?:in|now\s+in)\s+(?:my|our|this)\s+(?:token|coin|agent)|holders?\s+will\s+(?:profit|earn|get\s+rich|be\s+paid)|passive\s+income|dividends?\s+(?:to|for)\s+holders|(?:profit|revenue)[-\s]shar(?:e|ing)\s+(?:with|for|to)\s+holders|get\s+rich\s+quick)\b
```

## 7. Known v1 limits (recorded, not bugs)

- Impersonation of people NOT on the list, of organizations, or in other languages passes v1
  unless I2/I3 catch the phrasing. Obfuscation (leetspeak, zero-width characters, spacing inside
  words) passes v1.
- Rules see only the text: they cannot judge intent, satire, or context.
- Every "passes" column above is deliberate — ambiguity passes v1.
