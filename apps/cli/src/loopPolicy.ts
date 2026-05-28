import chalk from "chalk";

import type { PipelineIndependentQa, ReleaseAgentBrief } from "./cursorAutomation.js";

export function isQaShipClean(qa: PipelineIndependentQa | undefined): boolean {
  return qa?.recommendation === "ship" && (qa?.blockers?.length ?? 0) === 0;
}

export type DurableShipContext = {
  outerQa: PipelineIndependentQa | undefined;
  endQa: PipelineIndependentQa | undefined;
  endQaReused: boolean;
  cursorProductFileCount: number;
  cursorQaArtifactFileCount: number;
};

/** True when ship state will survive the next full outer pipeline (not working-tree-only). */
export function isDurableLoopShip(ctx: DurableShipContext): boolean {
  if (!isQaShipClean(ctx.endQa) || ctx.endQaReused) return false;
  if (isQaShipClean(ctx.outerQa)) return true;
  if (ctx.cursorProductFileCount > 0) return true;
  if (ctx.cursorQaArtifactFileCount > 0) return true;
  return false;
}

export type AutoPromoteDecision = { ok: boolean; reason: string };

export function evaluateAutoPromoteToMain(ctx: DurableShipContext): AutoPromoteDecision {
  if (!isQaShipClean(ctx.endQa)) {
    return { ok: false, reason: "end-of-cycle QA is not ship-clean" };
  }
  if (ctx.endQaReused) {
    return { ok: false, reason: "independent_qa was reused from cache" };
  }
  if (isQaShipClean(ctx.outerQa)) {
    return { ok: true, reason: "outer + end-of-cycle QA both ship-clean" };
  }
  if (ctx.cursorProductFileCount > 0) {
    return {
      ok: true,
      reason: `Cursor committed ${ctx.cursorProductFileCount} product file(s); end QA ship-clean`,
    };
  }
  if (ctx.cursorQaArtifactFileCount > 0) {
    return {
      ok: true,
      reason: `committed ${ctx.cursorQaArtifactFileCount} QA-gating Foundry artifact(s); end QA ship-clean`,
    };
  }
  return {
    ok: false,
    reason:
      "post-Cursor ship only (outer pipeline was red and nothing durable was committed) — skipping merge to main",
  };
}

export function releaseCandidateVerdictForCycle(
  qa: PipelineIndependentQa | undefined,
  release: ReleaseAgentBrief | undefined,
  durable: boolean,
): { yes: boolean; reason: string } {
  if (!isQaShipClean(qa)) {
    return { yes: false, reason: `independent_qa not ship (${qa?.recommendation ?? "missing"})` };
  }
  if (!durable) {
    return {
      yes: false,
      reason:
        "post-Cursor QA is ship but outer pipeline was not — not a durable release candidate until a full pipeline run is green",
    };
  }
  if (!release) {
    return { yes: false, reason: "release_agent output missing" };
  }
  if (release.status === "blocked_by_qa") {
    return { yes: false, reason: "release_agent blocked_by_qa" };
  }
  if (release.status === "blocked_pre_release") {
    return { yes: false, reason: "release_agent blocked_pre_release" };
  }
  const blocked = (release.releaseChecklist ?? []).filter((i) => i.status === "blocked").length;
  if (blocked > 0) {
    return { yes: false, reason: `${blocked} blocked row(s) on release checklist` };
  }
  if (release.status === "approved" || release.status === "auto_approved" || release.status === "awaiting_approval") {
    return { yes: true, reason: `release status=${release.status}` };
  }
  return { yes: false, reason: `release status=${release.status ?? "?"}` };
}

export function logFoundryLoopDiagram(alwaysPromoteToMain: boolean): void {
  console.log(chalk.bold.cyan("\n  Foundry loop (after QA-durable fixes)"));
  console.log(chalk.gray("  ─────────────────────────────────────────────────────────"));
  console.log(
    chalk.white(`
  ┌─────────────────────────────────────────────────────────────┐
  │  OUTER CYCLE (each iteration)                                │
  └─────────────────────────────────────────────────────────────┘
           │
           ▼
  ┌─────────────────────┐
  │ Full pipeline       │  repo_inventory → … → grand_wizard
  │ (Phase 1)           │  → builder → independent_qa → release_agent
  └─────────┬───────────┘
            │
     ┌──────┴──────┐
     │ outer QA?   │
     └──────┬──────┘
            │
    ┌───────┼───────┐
    │ ship  │ red   │
    ▼       ▼       │
  skip      INNER   │
  Cursor?   LOOP    │
            │       │
            ▼       │
  ┌─────────────────────┐
  │ Cursor builder      │  composer model · foundry/<runId> branch
  │ (up to N passes)    │
  └─────────┬───────────┘
            │
            ▼
  ┌─────────────────────┐
  │ Auto-commit         │  ① product paths (apps/, packages/, …)
  │                     │  ② QA-gating .foundry/ (WORK_PACKET, brief, BUILD_SPEC)
  └─────────┬───────────┘
            │
            ▼
  ┌─────────────────────┐
  │ Post-Cursor QA      │  independent_qa + release_agent (+ investor last pass)
  │ (fresh, no cache)   │  disableStageReuse=true
  └─────────┬───────────┘
            │
     ┌──────┴──────────────────────────┐
     │ DURABLE ship?                     │
     │ (outer ship OR product OR         │
     │  QA-artifact commits)              │
     └──────┬────────────────────────────┘
            │
     ┌──────┴──────┐
     │ yes         │ no → more inner passes / next cycle
     ▼             │
  stop inner       │
  (no no-op)       │
            │
            ▼
  ┌─────────────────────┐
  │ Promote to main?    │  ${alwaysPromoteToMain ? "always_promote_to_main: ON" : "always_promote_to_main: OFF"}
  │                     │  requires durable ship + verify (if outer was red)
  └─────────┬───────────┘
            │
     ┌──────┴──────┐
     │ promote     │ skip (stay on foundry/* branch)
     ▼             │
  merge foundry/* ──► main ──► push origin
            │
            ▼
  ┌─────────────────────┐
  │ Investor / release  │  investor_panel if gates clear
  │ (profile investor)  │  EAS deferred until B+ + convergence (if configured)
  └─────────────────────┘
`),
  );
  console.log(chalk.gray("  ─────────────────────────────────────────────────────────\n"));
}
