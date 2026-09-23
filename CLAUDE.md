# CLAUDE.md — session rules for this repo

Read `docs/00-OVERVIEW.md` and `BUILD-STATE.md` at session start; module doc per current milestone (`docs/07-BUILD-PLAN.md`). Update `BUILD-STATE.md` before every session ends. Never reopen decision-log items (00 §3) without asking Juan.

## Response style

Streamlined and to the point. No verbosity: no restating what Juan said, no long preambles or recaps, no padding around answers. Short sentences, concrete facts, numbers over adjectives. Long-form prose only when Juan asks for analysis.

## Model delegation (protect the weekly Fable limit)

The orchestrating model (Fable 5) does the thinking; subagents do the typing. Spawn subagents via the Agent tool with an explicit `model` override:

- **Fable 5 (this session, no subagent):** architecture, logic and security decisions, anything touching money paths or the policy engine's design, hard debugging, code review/audit of subagent output, and all judgment calls.
- **Opus 5.5 (`model: "opus"`):** harder implementation — contracts, policy engine code, tricky tests, multi-file refactors — against a Fable-written spec.
- **Sonnet 5 (`model: "sonnet"`):** routine implementation — boilerplate, config, scripts, simple tests, doc formatting, mechanical edits, repetitive file generation.

Rules:
- Default to delegating any substantial code-writing; Fable writes code directly only when the writing IS the hard thinking (e.g. a subtle invariant test) or the task is a few lines.
- Subagent prompts must carry a complete spec: exact files, interfaces, constraints, and the relevant decisions from 00 §3. Subagents implement; they do **not** argue, revisit, or "improve" architectural or technical choices — any concern they surface comes back to Fable to decide.
- Fable reviews everything a subagent produces before it counts as done (tests green per 07 §2).
