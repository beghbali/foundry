# Foundry engine issues

Product-agnostic defects in the Foundry **engine** (pipeline, stages, loop, CLI).
A defect belongs here when the answer to *"would a different project hit this?"* is **yes**.

Project-specific asks (what GutCheck should do/feel like) do **not** belong here —
those go in that project's `.foundry/PRODUCT_BACKLOG.md`.

## Conventions

- Every engine fix lands with a regression test (or a clear note why it can't have one yet).
- Never hand-edit generated artifacts (`WORK_PACKET.json`, ledgers, resolver-domains).
  If an artifact is wrong, fix its **generator** and add an entry here.
- One concern per commit; keep engine commits out of product commits.

## Status legend

`OPEN` · `IN PROGRESS` · `FIXED (<sha>)` · `WONTFIX`

---

## FIXED

### FND-1 — Loop spins forever when green but investor convergence unreachable — FIXED (524052b)
Outer loop re-ran the full pipeline (~140s `independent_qa`) every cycle when the build
was green but the investor mean couldn't reach the bar and there was no new work to raise it.
Added `consecutiveNoProgressCycles` halt (`apps/cli/src/index.ts`,
`FOUNDRY_MAX_NOPROGRESS_CYCLES`, default 3).

### FND-2 — Investor panel certified products it never saw — FIXED (this batch)
When the LLM grader (`cursor-agent`) was unavailable, the panel fell back to a heuristic
that grades planning **documents** (one-liner length, must-ship count, convergence flags),
still emitting A/B/A grades. It certified an incomprehensible app.
Fix: `packages/stages/src/investor_panel.ts` now **fails closed** (all-F, non-passing,
`panelUnavailable: true`) when the LLM is unavailable. Opt back into the heuristic with
`FOUNDRY_INVESTOR_ALLOW_HEURISTIC=1`.

### FND-3 — Re-promoted identical green state every cycle — FIXED (this batch)
Cycles 40–43 merged the same build to `main` repeatedly with no product change, churning
Foundry artifacts into `main`. Fix: `apps/cli/src/index.ts` skips auto-promote when a cycle
made no product/QA-artifact progress and the green signature matches the last promotion.

### FND-4 — Builder could only add surfaces, never remove them — FIXED (this batch)
`builder.directives` only produced "build/wire X" work. A directive to *remove* clutter
("strip investor meta from user-facing screens") had no actionable path, so the loop kept
accreting. Fix: `builder.directives[].action: "remove"` (`packages/core/src/config.ts`);
removal directives become work-packet items verified by **absence** (text/testID gone).

### FND-5 — `qa_automation.maestro.required: true` didn't actually block — FIXED (this batch)
When Maestro was required but couldn't run (no simulator / env-only failure), it downgraded
to a warning, so a required UX smoke silently "passed". Fix: `packages/stages/src/independent_qa.ts`
now blocks ship when `required: true` and the smoke can't be verified — "couldn't verify" ≠ "ship".

### FND-7 — Grand Wizard drops product directives while meta tasks close — FIXED (this batch)
Heuristic decomposition returned `tasks: []` for vague investor directives while
testable meta work closed via contract gates. `builder.directives` in project.yaml
were ignored upstream.
Fix: inject `project_directive` parents from yaml; synthesize concrete tasks when
LLM fails; mandatory strict-model LLM retry when tasks stay empty; protect yaml
directives from stuck-drop; include builder.directives in upstream fingerprint
(`packages/stages/src/grand_wizard.ts`, `packages/core/src/buildSpec.ts`).

### FND-8 — Maestro QA used bare binary when yaml only set npm wrapper `command` — FIXED (this batch)
`independent_qa` ran `~/.maestro/bin/maestro test` without Metro when
`qa_automation.maestro.command` was `npm run maestro:smoke …` but
`pipeline_command` was unset. Fix: auto-promote npm/yarn wrapper commands to
`pipeline_command` (`packages/stages/src/independent_qa.ts`).

### FND-9 — Model defaults still assumed Free `auto` / gpt-5.4 — FIXED (this batch)
Paid-plan defaults: Opus 4.8 (builder + investor), Composer 2.5 fast/economy,
Codex 5.3 (Grand Wizard primary), Opus 4.8 strict retry. Added
`investor_panel_model` / `grand_wizard_strict_model` config fields
(`packages/core/src/cursorModels.ts`, `apps/cli/src/cursorAutomation.ts`).

---

## OPEN

### FND-6 — Investor panel + QA are document/contract gates, not UX gates — PARTIAL
FND-2/FND-5 close the worst holes, but there is still no first-class Foundry check that
asserts a human-comprehensible first session (e.g. product identity + result visible).
Today this is delegated to the product's Maestro flow (made enforceable by FND-5).
Next: a stage-level "UX legibility" check that doesn't depend on each project wiring it.
