import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import chalk from "chalk";
import { readLatestArtifact, type FoundryConfig, type RunManifest } from "@foundry/core";
import { stripBriefIdComment } from "@foundry/core/briefIntent";

export interface CursorAutomationSettings {
  enabled: boolean;
  command: string;
  builderModel: string;
  builderFastModel: string;
  /** Cursor model for near-release refinement (default `auto`). */
  builderEconomyModel: string;
  /**
   * When true, after QA ships with no code blockers and release is `awaiting_approval` (human approval; brief already complete),
   * the Cursor builder uses `builderEconomyModel` for every inner pass. Not used while `blocked_pre_release` (open brief / builder gates).
   */
  useBuilderEconomyNearRelease: boolean;
  qaModel: string;
  qaStrictModel: string;
  maxInnerLoops: number;
  timeoutMinutes: number;
}

export interface FileDiffStat {
  file: string;
  added: number;
  removed: number;
}

export interface CursorAgentRunResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  promptPath: string;
  logPath: string;
  changedFiles: string[];
  /** Committed `.foundry/` paths that gate tests (WORK_PACKET, CURSOR_BRIEF, etc.). */
  qaArtifactFiles: string[];
  hadCodeChanges: boolean;
  /** LOC + file accounting for the commit Cursor just landed. */
  diffStats?: FileDiffStat[];
  totalLocAdded?: number;
  totalLocRemoved?: number;
  /** When no product files were committed, summarizes porcelain (generated vs product paths). */
  statusHint?: string;
  /** True when a second Cursor pass ran after the first produced no committable product changes. */
  implementationRetryUsed?: boolean;
  /** Set when changes were committed locally but `git push` failed (remote offline, no origin, auth, etc.). */
  pushWarning?: string;
}

export async function readDiffStatsForHead(repoPath: string): Promise<FileDiffStat[]> {
  const result = await exec("git show --numstat --pretty=format: HEAD", repoPath, 15_000);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && /^[0-9-]+\s+[0-9-]+\s+/.test(line))
    .map((line) => {
      const [addedRaw, removedRaw, ...fileParts] = line.split(/\s+/);
      const added = addedRaw === "-" ? 0 : Number.parseInt(addedRaw ?? "0", 10) || 0;
      const removed = removedRaw === "-" ? 0 : Number.parseInt(removedRaw ?? "0", 10) || 0;
      return { file: fileParts.join(" "), added, removed };
    });
}

export function summarizeDiffStats(stats: ReadonlyArray<FileDiffStat>): string {
  if (stats.length === 0) return "no diff";
  const totalAdded = stats.reduce((s, x) => s + x.added, 0);
  const totalRemoved = stats.reduce((s, x) => s + x.removed, 0);
  const top = [...stats]
    .sort((a, b) => b.added + b.removed - (a.added + a.removed))
    .slice(0, 4)
    .map((s) => `${s.file} (+${s.added}/-${s.removed})`)
    .join(", ");
  return `${stats.length} file(s), +${totalAdded}/-${totalRemoved} LOC · Top: ${top}`;
}

export interface BriefCriticalCounts {
  mustShip: number;
  shouldShip: number;
  unresolvedGaps: number;
  monetization: number;
  edgeFunctions: number;
  /** Open items under ## Runtime Failures To Fix First */
  runtime: number;
  total: number;
}

export async function readBuilderRemainingBlockers(repoPath: string): Promise<string[]> {
  const path = join(repoPath, ".foundry", "CURSOR_BUILDER_REPORT.md");
  try {
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n");
    const out: string[] = [];
    let inSection = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "## Remaining Blockers") {
        inSection = true;
        continue;
      }
      if (inSection && trimmed.startsWith("## ")) break;
      if (!inSection) continue;
      if (trimmed.startsWith("- ")) out.push(trimmed.slice(2).trim());
      else if (/^\d+\.\s/.test(trimmed)) out.push(trimmed.replace(/^\d+\.\s/, "").trim());
    }
    return out;
  } catch {
    return [];
  }
}

export function extractManualUnblocks(items: string[]): string[] {
  const patterns = [
    /manual action/i,
    /manual configuration/i,
    /manual unblock/i,
    /manual tool setup/i,
    /manual repo\/tooling setup/i,
    /human input/i,
    /requires human/i,
    /cannot be done from this workspace/i,
    /apple developer/i,
    /developer console/i,
    /app store connect/i,
    /sign in to/i,
    /authenticate/i,
    /credentials/i,
    /secret/i,
    /environment variable/i,
    /device registration/i,
    /provisioning profile/i,
    /not installed on the booted simulator/i,
    /app is not installed/i,
    /environment-only/i,
    /environmental warning/i,
    /qa_automation\.maestro\.required.*false/i,
    /install maestro/i,
    /maestro cli/i,
    /restart the terminal/i,
    /external to the repository/i,
    /not by product code/i,
    /shell_session_update/i,
    /repository-wide hygiene warnings/i,
    /non-blocking.*outside/i,
    /playwright chromium was not installed/i,
    /\benospc\b/i,
    /\brun:\s+curl\b/i,
  ];
  return [...new Set(items.filter((item) => patterns.some((p) => p.test(item))))];
}

export function separateManualAndCodeItems(items: string[]): {
  manual: string[];
  code: string[];
} {
  const manualSet = new Set(extractManualUnblocks(items));
  return {
    manual: [...manualSet],
    code: items.filter((item) => !manualSet.has(item)),
  };
}

/** Generic Maestro failure line from `independent_qa` when flows did not pass (may still be env/device). */
export function qaCodeBlockersAreOnlyMaestroSmokeFailed(qa: PipelineIndependentQa | undefined): boolean {
  const code = separateManualAndCodeItems(qa?.blockers ?? []).code;
  if (code.length === 0) return false;
  return code.every((b) => /^maestro smoke flows failed\.?$/i.test(b.trim()));
}

/** Maestro-only blocker while otherwise ship + tests green → don't burn primary on every inner pass; stall detection ignores QA "stuck". */
export function qaMaestroSmokeOnlyShipGreen(qa: PipelineIndependentQa | undefined): boolean {
  if (!qa || qa.recommendation !== "ship") return false;
  if (qa.testsRan === true && qa.testsPassed === false) return false;
  return qaCodeBlockersAreOnlyMaestroSmokeFailed(qa);
}

function envUseBuilderEconomyNearRelease(
  raw: { use_builder_economy_near_release?: boolean } | undefined,
  overrides: Partial<CursorAutomationSettings> | undefined,
): boolean {
  const e = process.env.FOUNDRY_USE_BUILDER_ECONOMY?.trim().toLowerCase();
  if (e === "0" || e === "false" || e === "off") return false;
  if (e === "1" || e === "true" || e === "on") return true;
  return overrides?.useBuilderEconomyNearRelease ?? raw?.use_builder_economy_near_release ?? true;
}

export function resolveCursorAutomationSettings(
  config: FoundryConfig,
  overrides?: Partial<CursorAutomationSettings>,
): CursorAutomationSettings {
  const raw = config.project.cursor_automation;
  const envPrimary = process.env.FOUNDRY_BUILDER_MODEL?.trim();
  const envFast = process.env.FOUNDRY_BUILDER_FAST_MODEL?.trim();
  return {
    enabled: overrides?.enabled ?? raw?.enabled ?? false,
    command: overrides?.command ?? raw?.command ?? process.env.FOUNDRY_CURSOR_AGENT_CMD ?? "agent",
    /** Default `auto` omits `--model` so the Cursor agent uses your workspace default (CLI may reject `--model auto`). Override in project.yaml or FOUNDRY_BUILDER_MODEL. */
    builderModel: overrides?.builderModel ?? raw?.builder_model ?? envPrimary ?? "auto",
    builderFastModel:
      overrides?.builderFastModel ??
      raw?.builder_fast_model ??
      envFast ??
      "auto",
    builderEconomyModel:
      overrides?.builderEconomyModel ??
      raw?.builder_economy_model ??
      process.env.FOUNDRY_BUILDER_ECONOMY_MODEL ??
      "auto",
    useBuilderEconomyNearRelease: envUseBuilderEconomyNearRelease(raw, overrides),
    qaModel: overrides?.qaModel ?? raw?.qa_model ?? "gpt-5.4-high",
    qaStrictModel: overrides?.qaStrictModel ?? raw?.qa_strict_model ?? "gpt-5.4-xhigh",
    maxInnerLoops: Math.min(overrides?.maxInnerLoops ?? raw?.max_inner_loops ?? 3, 3),
    timeoutMinutes: overrides?.timeoutMinutes ?? raw?.timeout_minutes ?? 45,
  };
}

export interface CursorModelChoice {
  model: string;
  reason: string;
}

/** Latest `independent_qa` stage output shape (pipeline QA — single source of truth). */
export type PipelineIndependentQa = {
  recommendation?: string;
  blockers?: string[];
  manualTasks?: string[];
  screenshotArtifacts?: string[];
  warnings?: string[];
  score?: number;
  testsRan?: boolean;
  testsPassed?: boolean;
  /** Truncated combined stdout/stderr from the test runner — surfaced in iteration focus so Cursor sees actual failure traces. */
  testSummary?: string;
  checks?: Array<{ name: string; passed?: boolean; details: string }>;
};

/** Use premium (primary) Cursor builder until automated QA is clean — not for cheap brief-only churn. */
export function qaNeedsPremiumCursorBuilder(qa: PipelineIndependentQa | undefined): boolean {
  if (!qa) return false;
  if (qa.recommendation !== "ship") return true;
  if (qa.testsRan === true && qa.testsPassed === false) return true;
  if (qaMaestroSmokeOnlyShipGreen(qa)) return false;
  return separateManualAndCodeItems(qa.blockers ?? []).code.length > 0;
}

/**
 * When QA/tests are not green, allow more inner iterations than `--max-inner-loops` so Cursor can iterate on fixes.
 * `FOUNDRY_QA_FIX_MAX_INNER_LOOPS` (default 12) is the floor; `FOUNDRY_QA_FIX_MAX_INNER_CAP` (default 50) hard-caps.
 */
export function resolveEffectiveInnerLoopMax(
  baseMaxInner: number,
  qa: PipelineIndependentQa | undefined,
): number {
  if (!qaNeedsPremiumCursorBuilder(qa)) return baseMaxInner;
  const floor = Number.parseInt(process.env.FOUNDRY_QA_FIX_MAX_INNER_LOOPS ?? "12", 10);
  const cap = Number.parseInt(process.env.FOUNDRY_QA_FIX_MAX_INNER_CAP ?? "50", 10);
  const f = Number.isFinite(floor) && floor > 0 ? floor : 12;
  const c = Number.isFinite(cap) && cap > 0 ? cap : 50;
  return Math.min(c, Math.max(baseMaxInner, f));
}

const CORE_QA_CHECK_ORDER = ["test_suite", "lint", "typecheck", "maestro_smoke"] as const;

/** One-line summary of the main automated QA steps (from last `independent_qa` artifact). */
export function summarizeCoreQaPlanForConsole(qa: PipelineIndependentQa | undefined): string {
  const checks = qa?.checks;
  if (!checks?.length) {
    return "unit tests · lint · typecheck · Maestro (if enabled) — see independent_qa after next pipeline run";
  }
  const parts: string[] = [];
  for (const key of CORE_QA_CHECK_ORDER) {
    const c = checks.find((x) => x.name === key);
    if (!c) continue;
    const d = c.details.trim();
    if (/^skipped/i.test(d) || /skipped:/i.test(d)) {
      const short =
        key === "test_suite"
          ? "tests"
          : key === "maestro_smoke"
            ? "Maestro"
            : key === "typecheck"
              ? "typecheck"
              : "lint";
      parts.push(`${short}: skipped`);
      continue;
    }
    const cmd = d.match(/\(([^)]+)\)/)?.[1];
    parts.push(cmd ?? key);
  }
  return parts.length ? parts.join(" · ") : "see independent_qa output";
}

/** Subset of `release_agent` output.json for console summaries (ship gate is pipeline-driven). */
/** Minimal shape consumed by the ship-gate console for the skipped-panel hint. */
export type ConvergenceContractBrief = {
  isConverged?: boolean;
  refinementRound?: number;
  panelFingerprint?: string;
  openObjections?: Array<{
    id: string;
    objection: string;
    status: "open" | "reduced" | "resolved" | "regressed";
    requiredEvidence?: string;
  }>;
  autoResolvedEvidence?: Array<{ objectionId: string; evidence: string }>;
  convergenceWarnings?: string[];
};

export type ReleaseAgentBrief = {
  status?: string;
  qaScore?: number;
  qaRecommendation?: string;
  gatesChecked?: string[];
  manualApprovalRequired?: boolean;
  approvalFile?: string;
  releaseChecklist?: Array<{ item: string; status: string; notes?: string }>;
  version?: string;
  easAvailable?: boolean;
  notes?: string[];
  /** Open `- [ ]` lines under tracked brief sections; mirrors `.foundry/OPEN_TRACKED_BRIEF.md`. */
  openTrackedBriefLines?: string[];
};

/**
 * Model policy (matches “one wholesale pass, then cheap refinement”):
 *
 * - **Inner pass 1** with real work (open packet items, QA blockers, or queued implement-now feedback)
 *   uses the **primary** builder (`auto` by default, or a fixed id from project.yaml / FOUNDRY_BUILDER_MODEL).
 * - **Inner pass 2+** uses the **fast** builder unless the loop is **stalled** (no progress), then
 *   we escalate to primary again.
 *
 * Pipeline stages `builder` and `independent_qa` do not use LLMs — only this Cursor step does.
 */
/**
 * Use cheap `builder_economy_model` (e.g. `auto`) only when the release is **waiting on human approval**
 * (`awaiting_approval`) — brief is complete, builder gates satisfied, QA ship. Do **not** use for `blocked_pre_release`,
 * which still means tracked CURSOR_BRIEF / builder work is outstanding (wholesale implementation; use primary).
 */
export function shouldUseNearReleaseEconomyBuilder(
  releaseStatus: string | undefined,
  pipelineQaRecommendation: string | undefined,
  pipelineQaCodeBlockerCount: number,
  feedbackImplementQueued: number,
): boolean {
  if (pipelineQaRecommendation !== "ship" || pipelineQaCodeBlockerCount > 0) return false;
  if (feedbackImplementQueued > 0) return false;
  return releaseStatus === "awaiting_approval";
}

export function chooseBuilderModel(
  settings: CursorAutomationSettings,
  briefCounts: BriefCriticalCounts,
  pipelineQa: PipelineIndependentQa | undefined,
  stalledIterations: number,
  innerLoopIndex: number,
  feedbackImplementQueued: number,
  releaseStatus: string | undefined,
  investorBelowTarget = false,
): CursorModelChoice {
  const primary = settings.builderModel;
  const fast = settings.builderFastModel;
  const economy = settings.builderEconomyModel;
  const pipelineQaRecommendation = pipelineQa?.recommendation;
  const pipelineQaCodeBlockerCount = separateManualAndCodeItems(pipelineQa?.blockers ?? []).code.length;

  if (stalledIterations > 0) {
    return { model: primary, reason: "stalled inner loop; escalating to primary builder model" };
  }

  if (qaNeedsPremiumCursorBuilder(pipelineQa)) {
    return {
      model: primary,
      reason: `QA/tests repair — primary builder until ship + tests green (rec=${pipelineQaRecommendation ?? "?"}, testsPassed=${String(pipelineQa?.testsPassed ?? "n/a")}, code_blockers=${pipelineQaCodeBlockerCount})`,
    };
  }

  if (
    settings.useBuilderEconomyNearRelease &&
    !investorBelowTarget &&
    shouldUseNearReleaseEconomyBuilder(
      releaseStatus,
      pipelineQaRecommendation,
      pipelineQaCodeBlockerCount,
      feedbackImplementQueued,
    )
  ) {
    return {
      model: economy,
      reason: `near-release economy (${economy}) — QA ship, no code blockers, release is awaiting_approval (human approval only); skipping premium builder`,
    };
  }

  if (innerLoopIndex > 1) {
    return {
      model: fast,
      reason: `inner pass ${innerLoopIndex}: refinement — fast builder (primary only when stalled)`,
    };
  }

  const hasWholesaleSurface =
    briefCounts.total > 0 || pipelineQaCodeBlockerCount > 0 || feedbackImplementQueued > 0;
  if (hasWholesaleSurface) {
    return {
      model: primary,
      reason:
        "first inner pass — primary builder for wholesale work across the full work packet + CURSOR_BRIEF (read listed files)",
    };
  }

  return {
    model: fast,
    reason: "first pass but no packet/QA/feedback surface — fast builder",
  };
}

export async function readStageJson<T = unknown>(
  repoPath: string,
  manifest: RunManifest,
  stageName: string,
): Promise<T | undefined> {
  const idx = manifest.stages.findIndex((s) => s.stage === stageName);
  if (idx < 0) return undefined;
  const prefix = String(idx).padStart(2, "0");
  const file = join(repoPath, ".foundry", "out", manifest.runId, `${prefix}_${stageName}`, "output.json");
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * True iff the named stage executed in this manifest (status `ok` / `warn`),
 * vs being skipped by a gate (e.g. investor_panel deferred behind QA). Caller
 * uses this to distinguish "investor_panel ran and produced grades" from
 * "investor_panel was deferred" without re-reading the manifest itself.
 */
export function manifestStageRan(manifest: RunManifest | undefined, stageName: string): boolean {
  if (!manifest) return false;
  const stage = manifest.stages.find((s) => s.stage === stageName);
  if (!stage) return false;
  // "Ran" = produced an output (not skipped by a gate). `passed` is the
  // expected success state; we deliberately exclude `failed` because failed
  // stages don't produce a usable output.json (the loop tracks "investor
  // panel actually generated grades", not "investor panel was attempted").
  return stage.status === "passed";
}

/** Console summary: pipeline `independent_qa` + `release_agent` (single QA/ship picture). */
export async function logShipGateConsole(
  repoPath: string,
  manifest: RunManifest,
  cached?: { pipelineQa?: PipelineIndependentQa; release?: ReleaseAgentBrief },
): Promise<void> {
  const pipelineQa =
    cached?.pipelineQa ??
    (await readStageJson<PipelineIndependentQa>(repoPath, manifest, "independent_qa"));
  const release =
    cached?.release ?? (await readStageJson<ReleaseAgentBrief>(repoPath, manifest, "release_agent"));

  console.log(chalk.bold.dim(`\n  ╭ Ship gate (independent_qa + release_agent) · ${manifest.runId}`));
  const rec = pipelineQa?.recommendation ?? "missing";
  const score = pipelineQa?.score;
  const pqHead =
    score !== undefined
      ? `independent_qa: recommendation=${rec} · score=${score}`
      : `independent_qa: recommendation=${rec}`;
  const pqChalk = rec === "ship" ? chalk.green : chalk.yellow;
  console.log(pqChalk(`  │ ${pqHead}`));
  const bl = pipelineQa?.blockers ?? [];
  if (bl.length === 0) {
    console.log(chalk.gray("  │ Pipeline QA blockers: none"));
  } else {
    console.log(chalk.yellow(`  │ Pipeline QA blockers (${bl.length}):`));
    bl.slice(0, 14).forEach((b, i) => {
      console.log(chalk.yellow(`  │   ${i + 1}. ${truncateForDisplay(b, 102)}`));
    });
    if (bl.length > 14) console.log(chalk.gray(`  │   … +${bl.length - 14} more (see independent_qa/output.json)`));
  }
  const manual = pipelineQa?.manualTasks ?? [];
  if (manual.length > 0) {
    console.log(chalk.yellow(`  │ Manual tasks (${manual.length}):`));
    manual.slice(0, 8).forEach((task, i) => {
      console.log(chalk.yellow(`  │   ${i + 1}. ${truncateForDisplay(task, 102)}`));
    });
    if (manual.length > 8) console.log(chalk.gray(`  │   … +${manual.length - 8} more (see independent_qa/output.json)`));
  }
  const screenshots = pipelineQa?.screenshotArtifacts ?? [];
  if (screenshots.length > 0) {
    console.log(chalk.gray(`  │ QA screenshots (${screenshots.length}):`));
    screenshots.slice(0, 6).forEach((shot, i) => {
      console.log(chalk.gray(`  │   ${i + 1}. ${truncateForDisplay(shot, 102)}`));
    });
    if (screenshots.length > 6) console.log(chalk.gray(`  │   … +${screenshots.length - 6} more (see independent_qa/output.json)`));
  }

  if (!release) {
    console.log(chalk.red("  │ release_agent: output not readable"));
    console.log(chalk.bold.dim("  ╯"));
    return;
  }

  const st = release.status ?? "?";
  const stChalk =
    st === "awaiting_approval" || st === "auto_approved" || st === "approved"
      ? chalk.green
      : st === "blocked_by_qa"
        ? chalk.red
        : st === "blocked_pre_release"
          ? chalk.yellow
          : chalk.yellow;
  console.log(stChalk(`  │ release_agent.status: ${st}`));
  console.log(
    chalk.gray(
      `  │ release_agent fields: qaRecommendation=${release.qaRecommendation ?? "?"} · qaScore=${release.qaScore ?? "?"} · easAvailable=${String(release.easAvailable ?? "?")}`,
    ),
  );
  if (release.version) console.log(chalk.gray(`  │ app version: ${release.version}`));
  if (release.manualApprovalRequired) {
    console.log(chalk.yellow(`  │ manualApprovalRequired: true`));
    if (release.approvalFile) console.log(chalk.yellow(`  │ approvalFile: ${release.approvalFile}`));
  }
  if (release.gatesChecked?.length) {
    console.log(chalk.gray(`  │ gatesChecked: ${release.gatesChecked.join(", ")}`));
  }
  const openBrief = release.openTrackedBriefLines ?? [];
  if (openBrief.length > 0) {
    console.log(chalk.bold.yellow("  │ Open tracked CURSOR_BRIEF (- [ ]):"));
    openBrief.slice(0, 20).forEach((line, i) => {
      console.log(chalk.yellow(`  │   ${i + 1}. ${truncateForDisplay(line, 102)}`));
    });
    if (openBrief.length > 20) {
      console.log(chalk.gray(`  │   … +${openBrief.length - 20} more (see .foundry/OPEN_TRACKED_BRIEF.md)`));
    }
    console.log(chalk.gray("  │   Full mirror: .foundry/OPEN_TRACKED_BRIEF.md"));
  }

  if (release.releaseChecklist?.length) {
    console.log(chalk.bold("  │ Release checklist:"));
    for (const c of release.releaseChecklist) {
      const mark =
        c.status === "done"
          ? chalk.green("✓")
          : c.status === "blocked"
            ? chalk.red("✗")
            : c.status === "deferred"
              ? chalk.gray("—")
              : c.status === "interactive"
                ? chalk.cyan("?")
                : chalk.yellow("…");
      const detail = c.notes ? ` — ${truncateForDisplay(c.notes, 70)}` : "";
      console.log(chalk.gray(`  │   ${mark} [${c.status}] ${truncateForDisplay(c.item, 56)}${detail}`));
    }
  }
  if (release.notes?.length) {
    console.log(chalk.gray("  │ Notes:"));
    for (const n of release.notes) console.log(chalk.gray(`  │   - ${truncateForDisplay(n, 100)}`));
  }

  // Surface the investor_panel gate so it's clear *why* the panel didn't grade
  // this run. Without this, a passing pipeline can hide the fact that the panel
  // was deliberately skipped (and any "passed" signal you might infer is wrong).
  const investorStage = manifest.stages.find((s) => s.stage === "investor_panel");
  if (investorStage?.status === "skipped") {
    console.log(chalk.bold.yellow("  │ investor_panel: SKIPPED (no grades this run)"));
    if (investorStage.error) {
      console.log(chalk.yellow(`  │   reason: ${truncateForDisplay(investorStage.error, 102)}`));
    }

    // For convergence-gated skips, show the top open objections and any
    // auto-resolved evidence so the user knows *exactly* what the next loop
    // needs to do (close brief items, ship a parked-feature decision, add a
    // metric, or trigger a fresh panel grade).
    if (investorStage.skipCause === "convergence") {
      const cc = await readStageJson<ConvergenceContractBrief>(
        repoPath,
        manifest,
        "convergence_contract",
      );
      if (cc) {
        const open = (cc.openObjections ?? []).filter(
          (o) => o.status === "open" || o.status === "regressed",
        );
        if (open.length > 0) {
          console.log(chalk.yellow(`  │   open objections (${open.length}):`));
          open.slice(0, 5).forEach((o, i) => {
            console.log(
              chalk.yellow(
                `  │     ${i + 1}. [${o.status}] ${truncateForDisplay(o.objection, 88)}`,
              ),
            );
            if (o.requiredEvidence) {
              console.log(
                chalk.gray(`  │        evidence: ${truncateForDisplay(o.requiredEvidence, 88)}`),
              );
            }
          });
          if (open.length > 5) console.log(chalk.gray(`  │     … +${open.length - 5} more`));
        }
        const resolved = cc.autoResolvedEvidence ?? [];
        if (resolved.length > 0) {
          console.log(chalk.green(`  │   auto-resolved this run (${resolved.length}):`));
          resolved.slice(0, 5).forEach((e, i) => {
            console.log(chalk.green(`  │     ${i + 1}. ${truncateForDisplay(e.evidence, 88)}`));
          });
        }
      }
    }

    console.log(
      chalk.gray(
        "  │   Pitch must reflect built product+repo. Run `foundry convergence status` and `foundry ledger list` to see what blocks the next pitch.",
      ),
    );

    // The unit that gets presented to investors is a converged + released app.
    // Tell the user the *one* command that loops to that state instead of
    // re-running `foundry run` by hand.
    if (investorStage.skipCause === "directives_unaddressed") {
      console.log(
        chalk.yellow(
          "  │   The pitch is deliberately held until BUILD_SPEC_LEDGER.addressedParents covers each prior directive. " +
            "Inspect .foundry/INVESTOR_PANEL_STATE.json (`lastDirectives`) and .foundry/BUILD_SPEC_LEDGER.json (`addressedParents`).",
        ),
      );
    }

    const nextCmd =
      investorStage.skipCause === "release_readiness"
        ? "foundry loop --cursor-auto --profile investor"
        : investorStage.skipCause === "convergence"
          ? "foundry loop --cursor-auto --profile investor   # iterates: builds → QA → release → re-pitches"
          : investorStage.skipCause === "directives_unaddressed"
            ? "foundry loop --cursor-auto --profile investor   # closes child tasks of unaddressed parent directives"
            : "foundry loop --cursor-auto --profile investor";
    console.log(chalk.cyan(`  │   ▶ next: ${nextCmd}`));
  }

  console.log(chalk.bold.dim("  ╯"));
}

/** One screenful: Foundry `builder` + `independent_qa` + `release_agent` for this run. */
export type PipelineConsoleSnapshot = {
  runId: string;
  buildLine: string;
  builderBranch?: string;
  qaLabel: string;
  blockerCount: number;
  blockers: string[];
  blockerOverflow: number;
  releaseLine?: string;
  briefOpenTotal?: number;
};

export async function getPipelineSnapshotForConsole(
  repoPath: string,
  manifest: RunManifest,
  opts?: { maxBlockers?: number; blockerMaxLen?: number; briefOpenTotal?: number },
): Promise<PipelineConsoleSnapshot> {
  const maxB = opts?.maxBlockers ?? 25;
  const maxLen = opts?.blockerMaxLen ?? 100;

  const builder = await readStageJson<{
    status?: string;
    branchName?: string;
    commit?: { sha?: string };
    changes?: { filesCreated?: string[]; filesModified?: string[]; filesSkipped?: string[] };
  }>(repoPath, manifest, "builder");

  const qa = await readStageJson<PipelineIndependentQa>(repoPath, manifest, "independent_qa");
  const release = await readStageJson<{ status?: string }>(repoPath, manifest, "release_agent");

  const bStage = manifest.stages.find((s) => s.stage === "builder");
  const reused = bStage?.reused === true;

  let buildLine: string;
  if (!builder) {
    buildLine = "(no builder stage output)";
  } else {
    const c = builder.changes?.filesCreated?.length ?? 0;
    const m = builder.changes?.filesModified?.length ?? 0;
    const s = builder.changes?.filesSkipped?.length ?? 0;
    const sha = builder.commit?.sha?.slice(0, 7);
    const parts = [
      `status=${builder.status ?? "?"}`,
      reused ? "stage reused" : null,
      `+${c} files`,
      `~${m} files`,
      s ? `${s} skipped` : null,
      sha ? `commit ${sha}` : null,
      builder.branchName ? truncateForDisplay(builder.branchName, 36) : null,
    ].filter(Boolean) as string[];
    buildLine = parts.join(" · ");
  }

  const rec = qa?.recommendation ?? "missing";
  const score = qa?.score;
  const qaLabel = score !== undefined ? `${rec} · score ${score}` : rec;
  const rawBlockers = qa?.blockers ?? [];
  const blockers = rawBlockers.map((b) => truncateForDisplay(b, maxLen)).slice(0, maxB);

  return {
    runId: manifest.runId,
    buildLine,
    builderBranch: builder?.branchName,
    qaLabel,
    blockerCount: rawBlockers.length,
    blockers,
    blockerOverflow: Math.max(0, rawBlockers.length - blockers.length),
    releaseLine: release?.status ? `release_agent: ${release.status}` : undefined,
    briefOpenTotal: opts?.briefOpenTotal,
  };
}

function extractMarkdownSectionLines(md: string, headingLine: string): string[] {
  const lines = md.split(/\r?\n/);
  const h = headingLine.trim();
  const i = lines.findIndex((l) => l.trim() === h);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line.startsWith("## ") && line.trim() !== h) break;
    out.push(line);
  }
  return out;
}

function countBulletLines(sectionLines: string[]): number {
  return sectionLines.filter((line) => /^\s*([-*]|\d+\.)\s/.test(line)).length;
}

function countTopLevelNumberedLines(sectionLines: string[]): number {
  return sectionLines.filter((line) => /^\d+\.\s/.test(line.trim())).length;
}

function extractMarkdownSubsectionLines(md: string, headingLine: string): string[] {
  const lines = md.split(/\r?\n/);
  const h = headingLine.trim();
  const i = lines.findIndex((l) => l.trim() === h);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line.startsWith("### ") && line.trim() !== h) break;
    if (line.startsWith("## ")) break;
    out.push(line);
  }
  return out;
}

type BriefProgress = { complete: number; total: number };

async function countTrackedBriefProgress(briefPath: string): Promise<BriefProgress> {
  let raw = "";
  try {
    raw = await readFile(briefPath, "utf8");
  } catch {
    return { complete: 0, total: 0 };
  }

  let section: "must" | "should" | "gaps" | "monetization" | "edge" | "runtime" | "other" = "other";
  let complete = 0;
  let total = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "### Must Ship (Phase 1)") section = "must";
    else if (trimmed === "### Should Ship (stretch)") section = "should";
    else if (trimmed === "## Unresolved Gaps (Cursor should fix these)") section = "gaps";
    else if (trimmed === "## Monetization Integration") section = "monetization";
    else if (trimmed === "## Edge Function Rate Limiting") section = "edge";
    else if (trimmed === "## Runtime Failures To Fix First") section = "runtime";
    else if (trimmed.startsWith("## ") || trimmed.startsWith("### ")) section = "other";

    if (!trimmed.startsWith("- [")) continue;
    if (section === "other") continue;
    total++;
    if (trimmed.startsWith("- [x]")) complete++;
  }
  return { complete, total };
}

/** One-line summary of the last Cursor builder session report. */
export async function summarizeCursorBuilderReportMd(repoPath: string): Promise<string> {
  const p = join(repoPath, ".foundry", "CURSOR_BUILDER_REPORT.md");
  try {
    const raw = await readFile(p, "utf8");
    const brief = await countTrackedBriefProgress(join(repoPath, ".foundry", "CURSOR_BRIEF.md"));
    const feedbackResolved = countTopLevelNumberedLines(
      extractMarkdownSubsectionLines(raw, "### Feedback ledger items resolved:"),
    );
    const fixed = countTopLevelNumberedLines(extractMarkdownSectionLines(raw, "## QA Blockers Fixed"));
    const remain = countTopLevelNumberedLines(extractMarkdownSectionLines(raw, "## Remaining Blockers"));

    let feedbackTotal = feedbackResolved;
    try {
      const ledgerRaw = await readFile(join(repoPath, ".foundry", "feedback-ledger.json"), "utf8");
      const ledger = JSON.parse(ledgerRaw) as { items?: Array<{ status?: string; shouldImplement?: boolean }> };
      feedbackTotal = (ledger.items ?? []).filter((item) => item.status === "open" && item.shouldImplement === true).length;
    } catch {
      const feedbackArtifact = await readLatestArtifact(repoPath, "feedback_agent/output.json");
      if (feedbackArtifact) {
        try {
          const parsed = JSON.parse(feedbackArtifact) as { ledgerSummary?: { implementNowItems?: number } };
          feedbackTotal = parsed.ledgerSummary?.implementNowItems ?? feedbackResolved;
        } catch {
          /* ignore parse errors */
        }
      }
    }

    return `brief ${brief.complete}/${brief.total} complete · feedback ${feedbackResolved}/${feedbackTotal} addressed · qa ${fixed} fixes noted · ${remain} remaining blockers`;
  } catch {
    return "(no CURSOR_BUILDER_REPORT.md)";
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function countCriticalBriefItems(briefPath: string): Promise<BriefCriticalCounts> {
  const counts: BriefCriticalCounts = {
    mustShip: 0,
    shouldShip: 0,
    unresolvedGaps: 0,
    monetization: 0,
    edgeFunctions: 0,
    runtime: 0,
    total: 0,
  };

  // Prefer BUILD_SPEC_LEDGER as the source of truth: the brief markdown's
  // checkbox state never persists across cycles (the wizard regenerates it),
  // so deriving counts from the ledger keeps "remaining work" stable across
  // cycles. The brief is still consulted for `runtime`/`should`/legacy
  // sections that the wizard doesn't cover.
  const foundryDir = briefPath.replace(/\/[^/]+$/, "");
  try {
    const specRaw = await readFile(`${foundryDir}/BUILD_SPEC.json`, "utf8");
    const ledgerRaw = await readFile(`${foundryDir}/BUILD_SPEC_LEDGER.json`, "utf8").catch(() => "");
    type SpecShape = { slices?: Array<{ tasks?: Array<{ id?: string }> }> };
    type LedgerShape = { tasks?: Record<string, unknown> };
    const spec = JSON.parse(specRaw) as SpecShape;
    const ledger = ledgerRaw ? (JSON.parse(ledgerRaw) as LedgerShape) : { tasks: {} };
    const tasks = spec.slices?.[0]?.tasks ?? [];
    const closed = ledger.tasks ?? {};
    counts.mustShip = tasks.filter((t) => !t.id || !(t.id in closed)).length;
    counts.total = counts.mustShip;
  } catch {
    /* fall through to legacy markdown scan when no spec exists */
  }

  let raw = "";
  try {
    raw = await readFile(briefPath, "utf8");
  } catch {
    return counts;
  }

  let section: "must" | "should" | "gaps" | "monetization" | "edge" | "runtime" | "other" = "other";
  // Markdown scan: skip "must" when we already derived it from BUILD_SPEC_LEDGER
  // (counts.mustShip > 0 means the ledger sourced it). Always count
  // should/gaps/monetization/edge/runtime from the brief — these sections aren't
  // owned by the wizard.
  const wizardSourcedMust = counts.mustShip > 0 || counts.total > 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "### Must Ship (Phase 1)") section = "must";
    else if (trimmed === "### Should Ship (stretch)") section = "should";
    else if (trimmed === "## Unresolved Gaps (Cursor should fix these)") section = "gaps";
    else if (trimmed === "## Monetization Integration") section = "monetization";
    else if (trimmed === "## Edge Function Rate Limiting") section = "edge";
    else if (trimmed === "## Runtime Failures To Fix First") section = "runtime";
    else if (trimmed.startsWith("## ") || trimmed.startsWith("### ")) section = "other";

    if (!trimmed.startsWith("- [ ]")) continue;
    if (section === "must" && !wizardSourcedMust) counts.mustShip++;
    if (section === "should") counts.shouldShip++;
    if (section === "gaps") counts.unresolvedGaps++;
    if (section === "monetization") counts.monetization++;
    if (section === "edge") counts.edgeFunctions++;
    if (section === "runtime") counts.runtime++;
  }

  counts.total =
    counts.mustShip +
    counts.shouldShip +
    counts.unresolvedGaps +
    counts.monetization +
    counts.edgeFunctions +
    counts.runtime;
  return counts;
}

type BriefTrackedSection = "must" | "should" | "gaps" | "monetization" | "edge" | "runtime";

function briefSectionLabel(section: BriefTrackedSection): string {
  switch (section) {
    case "must":
      return "Must ship";
    case "should":
      return "Should ship";
    case "gaps":
      return "Gaps";
    case "monetization":
      return "Monetization";
    case "edge":
      return "Edge";
    case "runtime":
      return "Runtime first";
    default:
      return section;
  }
}

/** Truncate a single line for terminal / markdown summaries. */
export function truncateForDisplay(text: string, maxLen: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= maxLen) return one;
  return `${one.slice(0, Math.max(0, maxLen - 1))}…`;
}

/**
 * Sample open `- [ ]` lines from tracked CURSOR_BRIEF sections (same scope as `countCriticalBriefItems`).
 */
export async function sampleUncheckedBriefLines(
  briefPath: string,
  maxTotal: number,
  maxLineLen = 130,
): Promise<string[]> {
  let raw = "";
  try {
    raw = await readFile(briefPath, "utf8");
  } catch {
    return [];
  }

  let section: BriefTrackedSection | "other" = "other";
  const out: string[] = [];

  for (const line of raw.split("\n")) {
    if (out.length >= maxTotal) break;
    const trimmed = line.trim();
    if (trimmed === "### Must Ship (Phase 1)") section = "must";
    else if (trimmed === "### Should Ship (stretch)") section = "should";
    else if (trimmed === "## Unresolved Gaps (Cursor should fix these)") section = "gaps";
    else if (trimmed === "## Monetization Integration") section = "monetization";
    else if (trimmed === "## Edge Function Rate Limiting") section = "edge";
    else if (trimmed === "## Runtime Failures To Fix First") section = "runtime";
    else if (trimmed.startsWith("## ") || trimmed.startsWith("### ")) section = "other";

    if (!trimmed.startsWith("- [ ]")) continue;
    if (section === "other") continue;
    const item = stripBriefIdComment(trimmed.slice("- [ ]".length).trim());
    if (!item) continue;
    const label = briefSectionLabel(section);
    out.push(`[${label}] ${truncateForDisplay(item, maxLineLen)}`);
  }
  return out;
}

export function formatIterationFocusMarkdown(params: {
  inner: number;
  maxInner: number;
  briefCounts: BriefCriticalCounts;
  briefSamples: string[];
  pipelineQa: PipelineIndependentQa | undefined;
  builderRemainingBlockers: string[];
  stabilize?: boolean;
  /** Same scope as release_agent tracked `- [ ]` (from CURSOR_BRIEF.md). */
  openTrackedBriefSample?: string[];
}): string {
  const lines: string[] = [
    `# Inner loop ${params.inner}/${params.maxInner} — what this run is working on`,
    "",
  ];
  if (params.stabilize) {
    lines.push(
      "> **Stabilize mode:** outer cycles skip upstream product/gap/monetization pipeline stages. Goal: `independent_qa` → **ship** with **zero blockers** (tests, lint, typecheck, Maestro), then full brief scope returns for release checklist items.",
      "",
    );
  }
  if (params.openTrackedBriefSample && params.openTrackedBriefSample.length > 0) {
    lines.push("## Open tracked CURSOR_BRIEF (`- [ ]` — same list as release gate)", "");
    for (const L of params.openTrackedBriefSample) lines.push(`- ${L}`);
    lines.push("", "_Also: `.foundry/OPEN_TRACKED_BRIEF.md` after each pipeline run._", "");
  }
  lines.push(
    "## Active work packet counts",
    "",
    `- must=${params.briefCounts.mustShip}, should=${params.briefCounts.shouldShip}, gaps=${params.briefCounts.unresolvedGaps}, monetization=${params.briefCounts.monetization}, edge=${params.briefCounts.edgeFunctions}, runtime=${params.briefCounts.runtime}`,
    "",
    "## Pipeline QA (`independent_qa`) — before this builder pass",
    "",
    `- recommendation: \`${params.pipelineQa?.recommendation ?? "missing"}\``,
    `- score: ${params.pipelineQa?.score ?? "—"}`,
    "",
  );
  if (params.pipelineQa?.blockers?.length) {
    lines.push("### Blockers (builder should drive these to zero)", "");
    for (const b of params.pipelineQa.blockers) lines.push(`- ${b}`);
    lines.push("");
  }
  // When tests failed, paste the *tail* of the test runner output (where most
  // assertion text lives) so Cursor has the actual stack traces to grep/fix
  // without re-running the suite. Tail (not head) because compilers/runners
  // tend to emit progress lines first and the actual error context last.
  if (
    params.pipelineQa?.testsRan &&
    params.pipelineQa?.testsPassed === false &&
    params.pipelineQa?.testSummary?.trim()
  ) {
    const summary = params.pipelineQa.testSummary;
    const TAIL_BYTES = 2400;
    const tail = summary.length > TAIL_BYTES ? summary.slice(summary.length - TAIL_BYTES) : summary;
    lines.push("### Failing-test output (tail of test runner stdout/stderr)", "");
    lines.push("```");
    lines.push(tail);
    lines.push("```", "");
  }
  if (params.pipelineQa?.warnings?.length) {
    lines.push("### Warnings", "");
    for (const w of params.pipelineQa.warnings) lines.push(`- ${w}`);
    lines.push("");
  }

  lines.push("## CURSOR_BUILDER_REPORT.md — Remaining blockers", "");
  if (params.builderRemainingBlockers.length === 0) {
    lines.push("_None listed._", "");
  } else {
    for (const b of params.builderRemainingBlockers) lines.push(`- ${b}`);
    lines.push("");
  }

  lines.push("## Sample open packet items", "");
  if (params.briefSamples.length === 0) {
    lines.push("_No open items remain in the packet._", "");
  } else {
    for (const s of params.briefSamples) lines.push(`- ${s}`);
    lines.push("");
  }

  lines.push("## Next step", "");
  lines.push(
    "Re-run the **Foundry pipeline** so `independent_qa` re-executes tests/lint/typecheck. Ship/release gates use **only** that stage — there is no separate Cursor QA pass.",
    "",
  );

  return lines.join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellBootstrapCommand(inner: string): string {
  const setup = [
    // macOS Terminal.app bash often sources profiles that call `shell_session_update` (undefined in non-interactive shells).
    "shell_session_update() { :; }",
    "[ -f ~/.bash_profile ] && source ~/.bash_profile >/dev/null 2>&1 || true",
    "[ -f ~/.bashrc ] && source ~/.bashrc >/dev/null 2>&1 || true",
    "[ -f ~/.profile ] && source ~/.profile >/dev/null 2>&1 || true",
  ].join("; ");
  return `${setup}; ${inner}`;
}

const GENERATED_FOUNDRY_PATHS = new Set([
  ".foundry/.pipeline-stage-cache.json",
  ".foundry/APPROVAL_REQUIRED.md",
  ".foundry/feedback-ledger.json",
  ".foundry/LATEST_INSTALL.md",
  ".foundry/resolver-domains.json",
  ".foundry/CURSOR_BRIEF.md",
  ".foundry/CURSOR_BUILDER_REPORT.md",
  ".foundry/CURSOR_QA_REPORT.md",
  ".foundry/WORK_PACKET.json",
  ".foundry/WORK_PACKET.md",
  ".foundry/OPEN_TRACKED_BRIEF.md",
  ".foundry/BUILD_SPEC.json",
  ".foundry/BUILD_SPEC.md",
  ".foundry/BUILD_SPEC_LEDGER.json",
  ".foundry/INVESTOR_PANEL_STATE.json",
]);

const GENERATED_FOUNDRY_PREFIXES = [
  ".foundry/out/",
  ".foundry/automation/",
  ".foundry/releases/",
  ".foundry/approvals/",
  /** Agent/typo variant of `approvals/` — never treat as product code. */
  ".foundry/approval/",
  /** Pre-Cursor snapshots of BUILD_SPEC / BUILD_SPEC_LEDGER (loop-internal). */
  ".foundry/.pre-cursor-snapshots/",
  /**
   * Maestro `--debug-output` artifacts (logs, commands JSON, screenshots). `--flatten-debug-output`
   * can emit odd path segments; git may list entries that are not on disk. Never auto-commit as product code.
   */
  ".maestro-debug/",
] as const;

function normalizePorcelainPath(path: string): string {
  return path.replace(/\\/g, "/").trim().replace(/^"|"$/g, "");
}

/** Use with `git status --porcelain=1` only. Newer Git defaults can emit porcelain v2, which breaks naive `slice(3)` parsing. */
function extractPorcelainPath(line: string): string | undefined {
  const t = line.trimEnd();
  if (!t || t.startsWith("#")) return undefined;
  // Porcelain v2 (ignore; caller must pass --porcelain=1)
  if (/^[0-9] /.test(t)) return undefined;
  if (t.length < 4) return undefined;
  const sep = t[2];
  if (sep !== " " && sep !== "\t") return undefined;
  let rawPath = t.slice(3).trim();
  if (!rawPath) return undefined;
  const renameArrow = rawPath.lastIndexOf(" -> ");
  if (renameArrow >= 0) {
    rawPath = rawPath.slice(renameArrow + 4).trim();
  }
  return normalizePorcelainPath(rawPath);
}

function isGeneratedFoundryPath(path: string): boolean {
  if (GENERATED_FOUNDRY_PATHS.has(path)) return true;
  return GENERATED_FOUNDRY_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Paths that gate `independent_qa` / repo tests — must be committed when Cursor fixes them. */
const QA_GATING_FOUNDRY_COMMIT_PATHS = new Set([
  ".foundry/WORK_PACKET.json",
  ".foundry/WORK_PACKET.md",
  ".foundry/CURSOR_BRIEF.md",
  ".foundry/BUILD_SPEC.json",
  ".foundry/BUILD_SPEC.md",
]);

function isQaGatingFoundryPath(path: string): boolean {
  return QA_GATING_FOUNDRY_COMMIT_PATHS.has(path);
}

/**
 * Commit QA-gating Foundry artifacts that are normally excluded from product
 * auto-commit. Without this, Cursor can close WORK_PACKET on disk, post-Cursor
 * QA passes, but promotion merges a branch that still fails the next outer run.
 */
export async function commitQaGatingFoundryArtifacts(
  repoPath: string,
  runId: string,
): Promise<{ files: string[]; pushWarning?: string }> {
  const branch = await currentGitBranch(repoPath);
  if (!branch) return { files: [] };

  const status = await exec("git status --porcelain=1", repoPath, 15_000);
  if (status.exitCode !== 0) return { files: [] };

  const paths = status.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => extractPorcelainPath(line))
    .filter((p): p is string => Boolean(p))
    .filter((path) => isQaGatingFoundryPath(path));

  if (paths.length === 0) return { files: [] };

  const { stage, skipped } = await filterStageableGitPaths(repoPath, paths);
  if (stage.length === 0) return { files: [] };

  const add = await exec(
    `git add -A -- ${stage.map((file) => shellQuote(file)).join(" ")}`,
    repoPath,
    30_000,
  );
  if (add.exitCode !== 0) {
    throw new Error(`Could not stage QA-gating Foundry artifacts.\n${add.stderr || add.stdout}`.trim());
  }

  const subject = `foundry(qa-sync): ${stage.length} file(s) — ${runId}`;
  const body = [
    "Auto-commit QA-gating Foundry artifacts after Cursor (WORK_PACKET / brief / BUILD_SPEC).",
    "",
    ...stage.map((f) => `- ${f}`),
  ].join("\n");
  const commit = await exec(
    `git commit -m ${shellQuote(subject)} -m ${shellQuote(body)}`,
    repoPath,
    60_000,
  );
  if (commit.exitCode !== 0) {
    throw new Error(
      `QA-gating Foundry artifacts were modified but could not be committed.\n${commit.stderr || commit.stdout}`.trim(),
    );
  }

  const pushResult = await pushWithUpstreamRecovery(repoPath, branch);
  const pushWarning = !pushResult.ok
    ? `Committed QA artifacts on '${branch}' but could not push: ${pushResult.detail}`
    : skipped.length > 0
      ? `Ignored unstageable QA paths: ${skipped.join(", ")}`
      : undefined;

  return { files: stage, pushWarning };
}

/**
 * `git status --porcelain` can occasionally list paths that are not stageable (race, bad rename parse, or agent junk).
 * Skip paths that are neither on disk nor tracked (so we cannot stage content or a deletion).
 */
async function filterStageableGitPaths(repoPath: string, paths: string[]): Promise<{ stage: string[]; skipped: string[] }> {
  const stage: string[] = [];
  const skipped: string[] = [];
  for (const p of paths) {
    const abs = join(repoPath, p);
    try {
      await access(abs);
      stage.push(p);
      continue;
    } catch {
      /* not on disk — may still be a tracked file whose deletion should be staged */
    }
    const tracked = await exec(`git ls-files --error-unmatch -- ${shellQuote(p)}`, repoPath, 10_000);
    if (tracked.exitCode === 0 && tracked.stdout.trim().length > 0) {
      stage.push(p);
    } else {
      skipped.push(p);
    }
  }
  return { stage, skipped };
}

async function classifyPorcelainPaths(repoPath: string): Promise<{ product: string[]; generated: string[] }> {
  const status = await exec("git status --porcelain=1", repoPath, 15_000);
  if (status.exitCode !== 0) {
    return { product: [], generated: [] };
  }
  const product: string[] = [];
  const generated: string[] = [];
  for (const line of status.stdout.split("\n").map((l) => l.trimEnd()).filter(Boolean)) {
    const p = extractPorcelainPath(line);
    if (!p) continue;
    (isGeneratedFoundryPath(p) ? generated : product).push(p);
  }
  return { product, generated };
}

function formatBuilderStatusHint(classified: { product: string[]; generated: string[] }): string {
  if (classified.product.length === 0 && classified.generated.length === 0) {
    return "Git working tree was clean after Cursor (no modified files).";
  }
  if (classified.product.length === 0 && classified.generated.length > 0) {
    return `Only generated Foundry paths changed (not auto-committed as product code): ${classified.generated.slice(0, 12).join(", ")}${classified.generated.length > 12 ? " …" : ""}`;
  }
  return `Uncommitted product paths still present: ${classified.product.slice(0, 12).join(", ")}${classified.product.length > 12 ? " …" : ""}`;
}

async function currentGitBranch(repoPath: string): Promise<string | undefined> {
  const result = await exec("git rev-parse --abbrev-ref HEAD", repoPath, 15_000);
  if (result.exitCode !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

async function ensureCursorBuilderBranch(
  repoPath: string,
  manifest: RunManifest,
): Promise<void> {
  const builder = await readStageJson<{ branchName?: string }>(repoPath, manifest, "builder");
  const targetBranch = builder?.branchName?.trim();
  if (!targetBranch) return;
  const current = await currentGitBranch(repoPath);
  if (current === targetBranch) return;

  const exists = await exec(`git show-ref --verify --quiet ${shellQuote(`refs/heads/${targetBranch}`)}`, repoPath, 15_000);
  const checkoutCmd =
    exists.exitCode === 0
      ? `git checkout ${shellQuote(targetBranch)}`
      : `git checkout -b ${shellQuote(targetBranch)}`;
  const checkedOut = await exec(checkoutCmd, repoPath, 30_000);
  if (checkedOut.exitCode !== 0) {
    throw new Error(
      `Could not switch Cursor builder to branch '${targetBranch}'.\n${checkedOut.stderr || checkedOut.stdout}`.trim(),
    );
  }
}

type AutoCommitOutcome = {
  files: string[];
  /** Present when commit succeeded but push did not — local branch still has the work. */
  pushWarning?: string;
  /** Porcelain paths ignored because they were not on disk and not tracked (stale/junk). */
  skippedUnstageablePaths?: string[];
};

function formatCursorBuilderCommitMessage(runId: string, files: string[]): { subject: string; body: string } {
  const unique = [...new Set(files.filter((f) => !isGeneratedFoundryPath(f)))].sort();
  const sample = unique.slice(0, 8);
  const rest = unique.length - sample.length;
  const listTail = rest > 0 ? ` (+${rest} more)` : "";
  let subject = `foundry(cursor): ${unique.length} file(s) — ${sample.join(", ")}${listTail}`;
  if (subject.length > 200) subject = `${subject.slice(0, 197)}…`;
  const body = unique.length ? `run ${runId}\n\n${unique.join("\n")}` : `run ${runId}`;
  return { subject, body };
}

/**
 * `git push` does not report "merge conflicts" — it fails when the remote refuses a non-fast-forward
 * update (someone else pushed, or another machine updated the branch). Foundry then fetches, rebases or
 * merges onto `origin/<branch>`, then pushes again. Auth/network/no-remote failures are left to the caller.
 */
function looksLikeRemoteAheadPushRejection(text: string): boolean {
  const t = text.toLowerCase();
  if (
    t.includes("permission denied") ||
    t.includes("authentication failed") ||
    t.includes("could not read from remote repository") ||
    t.includes("repository not found") ||
    t.includes("network is unreachable") ||
    t.includes("could not resolve host")
  ) {
    return false;
  }
  return (
    t.includes("non-fast-forward") ||
    t.includes("updates were rejected") ||
    t.includes("fetch first") ||
    t.includes("tip of your current branch is behind") ||
    (t.includes("! [rejected]") && t.includes("non-fast-forward"))
  );
}

async function remoteBranchExists(repoPath: string, branch: string): Promise<boolean> {
  const r = await exec(`git rev-parse --verify ${shellQuote(`refs/remotes/origin/${branch}`)}`, repoPath, 15_000);
  return r.exitCode === 0;
}

async function pushWithUpstreamRecovery(repoPath: string, branch: string): Promise<{ ok: boolean; detail: string }> {
  const push = () => exec(`git push -u origin ${shellQuote(branch)}`, repoPath, 120_000);

  let r = await push();
  if (r.exitCode === 0) return { ok: true, detail: "" };

  const combined = [r.stderr, r.stdout].filter(Boolean).join("\n").trim();
  if (!looksLikeRemoteAheadPushRejection(combined)) {
    return { ok: false, detail: combined || "(push failed with no output)" };
  }

  if (!(await remoteBranchExists(repoPath, branch))) {
    return { ok: false, detail: combined };
  }

  const fetch = await exec("git fetch origin", repoPath, 120_000);
  if (fetch.exitCode !== 0) {
    return {
      ok: false,
      detail: [`git fetch origin failed after push was rejected:`, fetch.stderr || fetch.stdout, "", combined]
        .filter(Boolean)
        .join("\n"),
    };
  }

  const rebase = await exec(`git rebase ${shellQuote(`origin/${branch}`)}`, repoPath, 180_000);
  if (rebase.exitCode === 0) {
    r = await push();
    if (r.exitCode === 0) return { ok: true, detail: "" };
    return { ok: false, detail: [`rebased onto origin/${branch} but push failed:`, r.stderr || r.stdout].join("\n") };
  }

  await exec("git rebase --abort", repoPath, 60_000);

  const merge = await exec(
    `git merge ${shellQuote(`origin/${branch}`)} -m ${shellQuote("foundry: merge origin before push")} -X ours`,
    repoPath,
    180_000,
  );
  if (merge.exitCode === 0) {
    r = await push();
    if (r.exitCode === 0) return { ok: true, detail: "" };
    return {
      ok: false,
      detail: [`merged origin/${branch} (-X ours) but push failed:`, r.stderr || r.stdout].join("\n"),
    };
  }

  await exec("git merge --abort", repoPath, 60_000);

  return {
    ok: false,
    detail: [
      `Could not integrate origin/${branch} (rebase and merge -X ours both failed). You may need to resolve manually.`,
      rebase.stderr || rebase.stdout,
      merge.stderr || merge.stdout,
      combined,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

async function autoCommitCursorBuilderChanges(repoPath: string, runId: string): Promise<AutoCommitOutcome> {
  const branch = await currentGitBranch(repoPath);
  if (!branch) {
    throw new Error("Could not determine current branch after Cursor builder.");
  }
  const status = await exec("git status --porcelain=1", repoPath, 15_000);
  if (status.exitCode !== 0) {
    throw new Error(`Could not read git status after Cursor builder.\n${status.stderr || status.stdout}`.trim());
  }

  const relevant = status.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => extractPorcelainPath(line))
    .filter((p): p is string => Boolean(p))
    .filter((path) => !isGeneratedFoundryPath(path));

  if (relevant.length === 0) return { files: [] };

  const { stage, skipped } = await filterStageableGitPaths(repoPath, relevant);
  if (stage.length === 0) {
    throw new Error(
      `Cursor builder changes could not be staged — no valid paths after filtering git status.\n` +
        (skipped.length ? `Skipped (missing and not tracked): ${skipped.join(", ")}` : ""),
    );
  }

  const files = stage;
  const add = await exec(
    `git add -A -- ${files.map((file) => shellQuote(file)).join(" ")}`,
    repoPath,
    30_000,
  );
  if (add.exitCode !== 0) {
    throw new Error(`Cursor builder changes could not be staged.\n${add.stderr || add.stdout}`.trim());
  }

  const { subject, body } = formatCursorBuilderCommitMessage(runId, files);
  const commit = await exec(
    `git commit -m ${shellQuote(subject)} -m ${shellQuote(body)}`,
    repoPath,
    60_000,
  );
  if (commit.exitCode !== 0) {
    throw new Error(
      `Cursor builder left code changes uncommitted and the auto-commit failed.\n${commit.stderr || commit.stdout}`.trim(),
    );
  }
  // Ensure the commit that just landed on HEAD actually contains non-generated product paths.
  const headNames = await exec("git show --name-only --pretty=format: HEAD", repoPath, 15_000);
  if (headNames.exitCode === 0) {
    const committed = headNames.stdout
      .split("\n")
      .map((line) => normalizePorcelainPath(line))
      .filter(Boolean)
      .filter((path) => !isGeneratedFoundryPath(path));
    const missing = files.filter((f) => !committed.includes(f));
    if (committed.length === 0 || missing.length === files.length) {
      throw new Error(
        "Cursor builder commit verification failed: HEAD did not include expected non-generated product file paths.",
      );
    }
  }

  const pushResult = await pushWithUpstreamRecovery(repoPath, branch);
  const skipNote =
    skipped.length > 0
      ? `Ignored junk/stale paths from git status (not on disk and not tracked): ${skipped.join(", ")}`
      : undefined;
  if (!pushResult.ok) {
    return {
      files,
      pushWarning: [skipNote, `Committed on '${branch}' but could not push to origin (integrated remote when possible).`, pushResult.detail]
        .filter(Boolean)
        .join("\n"),
      skippedUnstageablePaths: skipped.length ? skipped : undefined,
    };
  }
  return {
    files,
    pushWarning: skipNote,
    skippedUnstageablePaths: skipped.length ? skipped : undefined,
  };
}

/** How long Cursor may emit only reconnect-style output before Foundry SIGTERM (ms). `0` disables the watchdog. Default 120s. */
function transportWatchdogGraceMs(): number {
  const raw = process.env.FOUNDRY_CURSOR_TRANSPORT_GRACE_MS?.trim();
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) return Math.max(0, n);
  }
  return 120_000;
}

/**
 * Heuristic: did the Cursor agent die because of transport/network issues
 * (rather than producing a real error response)? Used by the inner-loop driver
 * to short-circuit additional outer cycles when consecutive runs hit network
 * stalls — those subsequent cycles burn quota for no productive output.
 */
export function isLikelyCursorTransportFailure(text: string): boolean {
  if (!text) return false;
  return /reconnect-only output|\[transport-watchdog\]|Connection lost,?\s*reconnecting|network error.*reconnect/i.test(
    text,
  );
}

function exec(
  command: string,
  cwd: string,
  timeoutMs: number,
  liveLogPath?: string,
  appendLog?: boolean,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/bash";
    const logStream = liveLogPath
      ? createWriteStream(liveLogPath, { flags: appendLog ? "a" : "w" })
      : undefined;
    const transportFailurePattern = /(Connection lost,\s*reconnecting|Retry attempt \d+|network error.*reconnect|reconnecting\.\.\.)/i;
    const transportFailureGraceMs = transportWatchdogGraceMs();
    let reconnectTimer: NodeJS.Timeout | undefined;
    let killedForTransportFailure = false;
    let transportFailureNote = "";
    const child = execFile(
      shell,
      ["-lc", shellBootstrapCommand(command)],
      {
        cwd,
        env: process.env,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const extra =
          error && typeof error === "object" && "message" in error
            ? String((error as { message?: string }).message ?? "")
            : "";
        if (reconnectTimer) clearTimeout(reconnectTimer);
        const transportExtra = killedForTransportFailure ? transportFailureNote : "";
        if (extra && logStream) {
          logStream.write(`\n[process-error]\n${extra}\n`);
        }
        if (transportExtra && logStream) {
          logStream.write(`\n[transport-failure]\n${transportExtra}\n`);
        }
        logStream?.end();
        resolve({
          exitCode: error ? 1 : 0,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr:
            [typeof stderr === "string" ? stderr : "", extra, transportExtra]
              .filter(Boolean)
              .join("\n") || "",
        });
      },
    );
    const noteTransportActivity = (chunk: unknown) => {
      const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (transportFailurePattern.test(text)) {
        if (transportFailureGraceMs <= 0) return;
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            killedForTransportFailure = true;
            transportFailureNote =
              `Cursor agent produced reconnect-only output for ${transportFailureGraceMs / 1000}s and was terminated to avoid burning more quota. Set FOUNDRY_CURSOR_TRANSPORT_GRACE_MS (ms) higher or 0 to disable this watchdog.`;
            logStream?.write(`\n[transport-watchdog]\n${transportFailureNote}\n`);
            child.kill("SIGTERM");
          }, transportFailureGraceMs);
        }
        return;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
    };
    if (logStream) {
      logStream.write(`command: ${command}\n`);
      logStream.write(`cwd: ${cwd}\n\n`);
      logStream.write("=== STDOUT ===\n");
      child.stdout?.on("data", (chunk) => {
        logStream.write(chunk);
        noteTransportActivity(chunk);
      });
      child.stdout?.on("end", () => {
        logStream.write("\n=== STDERR ===\n");
      });
      child.stderr?.on("data", (chunk) => {
        logStream.write(chunk);
        noteTransportActivity(chunk);
      });
    } else {
      child.stdout?.on("data", noteTransportActivity);
      child.stderr?.on("data", noteTransportActivity);
    }
  });
}

function stagePath(repoPath: string, manifest: RunManifest, stageName: string, filename = "output.json"): string {
  const idx = manifest.stages.findIndex((s) => s.stage === stageName);
  const prefix = idx >= 0 ? String(idx).padStart(2, "0") : "99";
  return join(repoPath, ".foundry", "out", manifest.runId, `${prefix}_${stageName}`, filename);
}

function buildBuilderPrompt(
  repoPath: string,
  manifest: RunManifest,
  options?: { implementationRetry?: boolean; innerLoopIndex?: number },
): string {
  const iterationFocusPath =
    options?.innerLoopIndex !== undefined
      ? join(
          repoPath,
          ".foundry",
          "automation",
          manifest.runId,
          `iteration-${options.innerLoopIndex}-focus.md`,
        )
      : undefined;

  const base = [
    "You are the dedicated Cursor builder agent for this repository.",
    "",
    "Scope: implement the **primary slice** from `.foundry/BUILD_SPEC.md` (if present) via the active work packet (`.foundry/WORK_PACKET.md`). When BUILD_SPEC exists, do **not** widen beyond that slice or deferred items.",
    "",
    "Read these files first:",
    `- ${join(repoPath, ".foundry", "project.yaml")}`,
    `- ${join(repoPath, ".foundry", "BUILD_SPEC.md")} (canonical slice spec — read ONLY; never write/edit this file)`,
    `- ${join(repoPath, ".foundry", "BUILD_SPEC.json")} (machine-readable spec — read ONLY; never write/edit this file)`,
    `- ${join(repoPath, ".foundry", "BUILD_SPEC_LEDGER.json")} (already-completed task IDs — READ ONLY; do NOT modify, do NOT delete, do NOT 'clean up'. Foundry restores it from snapshot after every pass if you touch it, but you waste a cycle.)`,
    `- ${join(repoPath, ".foundry", "WORK_PACKET.md")} (frozen scope for this cycle; highest priority)`,
    ...(iterationFocusPath
      ? [
          `- ${iterationFocusPath} (this pass: QA snapshot + sampled open packet lines — read alongside WORK_PACKET)`,
        ]
      : []),
    `- ${join(repoPath, ".foundry", "CURSOR_BRIEF.md")}`,
    `- ${join(repoPath, ".foundry", "CURSOR_BUILDER_REPORT.md")} (if it exists, continue from prior work)`,
    `- ${join(repoPath, ".foundry", "feedback-ledger.json")} (durable feedback state; respect status and shouldImplement if present)`,
    `- ${stagePath(repoPath, manifest, "independent_qa", "output.json")} (pipeline QA — source of truth for ship)`,
    `- ${stagePath(repoPath, manifest, "current_state_audit")}`,
    `- ${stagePath(repoPath, manifest, "product_definition")}`,
    `- ${stagePath(repoPath, manifest, "monetization_architect")}`,
    `- ${stagePath(repoPath, manifest, "builder", "IMPLEMENTATION_PLAN.md")}`,
    `- ${stagePath(repoPath, manifest, "feedback_agent")}`,
    "",
    "Then do all of the following autonomously:",
    "1. If `.foundry/BUILD_SPEC.md` exists, treat its **primary slice** as the only feature scope for this pass.",
    "   - For each concrete task, you MUST edit EVERY file listed in `task.files[]` (otherwise the task ledger will not close).",
    "   - Cover the full task list (3-4 tasks); do not stop after one. The ledger marks a task done only when its full `files[]` set is touched.",
    "   - When `BUILD_SPEC_LEDGER.json` lists a task as completed, skip re-editing those files unless QA requires it.",
    "2. Read the latest `feedback_agent` output and `.foundry/feedback-ledger.json`; only act on feedback items that are still open and marked `shouldImplement: true`.",
    "3. For each active work-packet item, write or update a focused test first when the repo has a natural place for that test.",
    "4. Then implement the feature code needed to make that test pass.",
    "5. Close every still-open item in `.foundry/WORK_PACKET.md` before touching deferred backlog work.",
    "6. Address **pipeline QA blockers** from `independent_qa/output.json` when they map to active work-packet items or the current primary slice.",
    "7. Use `.foundry/CURSOR_BRIEF.md` as supporting context aligned with BUILD_SPEC; do not widen scope beyond the primary slice while packet items remain open.",
    "8. Prefer modifying existing files over creating new ones.",
    "9. Run the relevant validation commands for the repo after your changes.",
    "10. Only mark an item complete if product code and tests changed or you verified the implementation already exists in code and documented that evidence.",
    "11. Update `.foundry/CURSOR_BRIEF.md` by changing completed checklist items from `- [ ]` to `- [x]` only when fully implemented in product code (not before).",
    "12. For feedback items you fixed, update `.foundry/feedback-ledger.json` to set `status: \"resolved\"` and add concise verification to `implementationNote`; leave unrelated/open items untouched.",
    "13. Write `.foundry/CURSOR_BUILDER_REPORT.md` with these sections:",
    "   - `## Implemented`",
    "   - `## QA Blockers Fixed`",
    "   - `## Files Changed`",
    "   - `## Commands Run`",
    "   - `## Verification Evidence`",
    "   - `## Remaining Blockers`",
    "13. If `.maestro/` flows exist and QA reported device smoke failures, fix the product code and/or the Maestro flows so they pass without weakening coverage.",
    "14. Leave the repo with product source changes ready: Foundry auto-commits non-`.foundry` paths. Do not leave `apps/` / `packages/` / `supabase/` edits unstaged.",
    "",
    "Important constraints:",
    "- Do not ask for human input.",
    "- Do not stop at planning; write code.",
    "- When BUILD_SPEC exists, implement **one primary slice** only — ignore deferred items and template must-ship churn.",
    "- Do not widen scope beyond `.foundry/WORK_PACKET.md` while it has open items.",
    "- Deliver a focused vertical slice (screens/hooks/services + tests) for the primary BUILD_SPEC acceptance criteria.",
    "- You MUST change at least one file outside `.foundry/` (e.g. under `apps/`, `packages/`, `supabase/`, or the repo's primary app source). Updating only `.foundry/CURSOR_BRIEF.md`, `CURSOR_BUILDER_REPORT.md`, or other generated Foundry metadata is NOT sufficient implementation.",
    "- If you make no non-generated code changes for the active packet, treat the pass as failed and explain why.",
    "- If something is impossible, document it in `CURSOR_BUILDER_REPORT.md` under `Remaining Blockers`.",
    "- Keep changes production-oriented and minimal-diff.",
    "- **Depth:** While Must Ship / Gaps / Runtime items in `CURSOR_BRIEF.md` stay open, prioritize **user-visible product work** (screens, navigation, core domain logic under `apps/` and shared product packages). Do **not** spend the iteration on edge-function rate limits, analytics/telemetry wiring, or paywall plumbing unless the active work packet explicitly requires it.",
  ].join("\n");

  if (!options?.implementationRetry) return base;

  return [
    base,
    "",
    "## CRITICAL — IMPLEMENTATION RETRY",
    "The previous Cursor pass did not produce any committable **product** changes (only generated `.foundry/` paths, or a clean tree). That outcome is invalid for this task.",
    "",
    "You MUST now:",
    "1. Edit at least one real source file under `apps/`, `packages/`, `supabase/`, or equivalent non-`.foundry` project code.",
    "2. Add or update tests in the repo's usual test locations when you change behavior.",
    "3. Implement a concrete open item from `.foundry/WORK_PACKET.md` (or the brief) — not paperwork only.",
    "4. Run the project's lint/test commands for the touched area and fix failures.",
    "",
    "Do NOT satisfy this pass by only editing `.foundry/CURSOR_BRIEF.md`, `.foundry/CURSOR_BUILDER_REPORT.md`, `.foundry/WORK_PACKET.md`, or automation logs.",
  ].join("\n");
}

async function runCursorAgent(
  repoPath: string,
  runId: string,
  command: string,
  model: string,
  prompt: string,
  timeoutMinutes: number,
  options?: { appendLog?: boolean },
): Promise<CursorAgentRunResult> {
  const automationDir = join(repoPath, ".foundry", "automation", runId);
  await mkdir(automationDir, { recursive: true });

  const promptPath = join(automationDir, "builder-prompt.md");
  const logPath = join(automationDir, "builder.log");
  await writeFile(promptPath, prompt, "utf8");
  if (options?.appendLog) {
    await appendFile(
      logPath,
      `\n\n=== CURSOR BUILDER RETRY (implementation required) ===\nmodel: ${model}\n\n`,
      "utf8",
    );
  }

  const args = [
    "-p",
    "--output-format",
    "text",
    "--force",
    "--trust",
    "--approve-mcps",
    "--workspace",
    repoPath,
    ...(cursorAgentUsesImplicitModel(model) ? [] : (["--model", model] as const)),
    prompt,
  ];

  const shellCommand = [command, ...args.map(shellQuote)].join(" ");

  const extraTransportRetries = Number.parseInt(process.env.FOUNDRY_CURSOR_TRANSPORT_RETRIES ?? "2", 10);
  const maxAttempts =
    1 +
    (Number.isFinite(extraTransportRetries) && extraTransportRetries >= 0
      ? Math.min(extraTransportRetries, 5)
      : 2);

  let result = { exitCode: 1 as number, stdout: "", stderr: "" };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const useAppend = Boolean(options?.appendLog) || attempt > 1;
    if (attempt > 1) {
      await appendFile(
        logPath,
        `\n\n=== FOUNDRY TRANSPORT RETRY (${attempt}/${maxAttempts}, model ${model}) ===\n\n`,
        "utf8",
      );
      await new Promise((r) => setTimeout(r, Math.min(20_000, 4000 * (attempt - 1))));
    }

    result = await exec(shellCommand, repoPath, timeoutMinutes * 60_000, logPath, useAppend);
    if (result.exitCode === 0) break;

    const blob = `${result.stdout}\n${result.stderr}`;
    const retryable = isLikelyCursorTransportFailure(blob);
    if (!retryable || attempt >= maxAttempts) break;
  }

  const finalFooter = [
    "",
    "=== EXIT ===",
    `exitCode: ${result.exitCode}`,
    maxAttempts > 1 ? `(after up to ${maxAttempts} attempt(s); transport retries: FOUNDRY_CURSOR_TRANSPORT_RETRIES)` : "",
    "",
  ]
    .filter(Boolean)
    .join("\n");
  await writeFile(logPath, `${await readFile(logPath, "utf8")}${finalFooter}`, "utf8");

  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    promptPath,
    logPath,
    changedFiles: [],
    qaArtifactFiles: [],
    hadCodeChanges: false,
  };
}

async function finalizeBuilderAgentResult(
  repoPath: string,
  runId: string,
  base: CursorAgentRunResult,
  productFiles: string[],
  opts?: {
    statusHint?: string;
    implementationRetryUsed?: boolean;
    pushWarning?: string;
  },
): Promise<CursorAgentRunResult> {
  const qaSync = await commitQaGatingFoundryArtifacts(repoPath, runId);
  const pushWarning = [opts?.pushWarning, qaSync.pushWarning].filter(Boolean).join("\n") || undefined;
  const diffStats = productFiles.length > 0 ? await readDiffStatsForHead(repoPath) : [];
  return {
    ...base,
    changedFiles: productFiles,
    qaArtifactFiles: qaSync.files,
    hadCodeChanges: productFiles.length > 0 || qaSync.files.length > 0,
    diffStats,
    totalLocAdded: diffStats.reduce((s, x) => s + x.added, 0),
    totalLocRemoved: diffStats.reduce((s, x) => s + x.removed, 0),
    statusHint: opts?.statusHint,
    implementationRetryUsed: opts?.implementationRetryUsed,
    pushWarning,
  };
}

export async function runBuilderAgent(
  repoPath: string,
  manifest: RunManifest,
  settings: CursorAutomationSettings,
  modelOverride?: string,
  builderContext?: { innerLoopIndex?: number },
): Promise<CursorAgentRunResult> {
  try {
    await ensureCursorBuilderBranch(repoPath, manifest);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: message,
      promptPath: "",
      logPath: join(repoPath, ".foundry", "automation", manifest.runId, "builder.log"),
      changedFiles: [],
      qaArtifactFiles: [],
      hadCodeChanges: false,
    };
  }

  const chosenModel = modelOverride ?? settings.builderModel;

  const innerIdx = builderContext?.innerLoopIndex;
  let result = await runCursorAgent(
    repoPath,
    manifest.runId,
    settings.command,
    chosenModel,
    buildBuilderPrompt(repoPath, manifest, { innerLoopIndex: innerIdx }),
    settings.timeoutMinutes,
  );
  if (!result.ok) return result;

  let statusHint: string | undefined;
  let implementationRetryUsed = false;

  try {
    let commitOutcome = await autoCommitCursorBuilderChanges(repoPath, manifest.runId);
    let pushWarning = commitOutcome.pushWarning;
    if (commitOutcome.files.length > 0) {
      return finalizeBuilderAgentResult(repoPath, manifest.runId, result, commitOutcome.files, {
        pushWarning,
      });
    }

    const classifiedFirst = await classifyPorcelainPaths(repoPath);
    statusHint = formatBuilderStatusHint(classifiedFirst);

    result = await runCursorAgent(
      repoPath,
      manifest.runId,
      settings.command,
      chosenModel,
      buildBuilderPrompt(repoPath, manifest, { implementationRetry: true, innerLoopIndex: innerIdx }),
      settings.timeoutMinutes,
      { appendLog: true },
    );
    implementationRetryUsed = true;
    if (!result.ok) {
      return {
        ...result,
        changedFiles: [],
        qaArtifactFiles: [],
        hadCodeChanges: false,
        statusHint,
        implementationRetryUsed,
      };
    }

    commitOutcome = await autoCommitCursorBuilderChanges(repoPath, manifest.runId);
    pushWarning = commitOutcome.pushWarning;
    const changedFiles = commitOutcome.files;
    if (changedFiles.length === 0) {
      const classifiedSecond = await classifyPorcelainPaths(repoPath);
      statusHint = `${statusHint} After implementation retry: ${formatBuilderStatusHint(classifiedSecond)}`;
    } else {
      statusHint = undefined;
    }

    return finalizeBuilderAgentResult(repoPath, manifest.runId, result, changedFiles, {
      statusHint,
      implementationRetryUsed,
      pushWarning,
    });
  } catch (err) {
    return {
      ...result,
      ok: false,
      exitCode: 1,
      stderr: [result.stderr, err instanceof Error ? err.message : String(err)].filter(Boolean).join("\n\n"),
      changedFiles: [],
      qaArtifactFiles: [],
      hadCodeChanges: false,
      statusHint,
      implementationRetryUsed,
    };
  }
}

/**
 * Whether to run the Cursor builder between pipeline cycles. Gated on pipeline `independent_qa`
 * (and brief work). There is no separate Cursor QA agent — ship uses `independent_qa` only.
 *
 * If QA is already green but the feedback ledger has open `shouldImplement=true` items, we still
 * allow the Cursor builder to run so product requests can be implemented without having to regress
 * QA first. `approved` / `auto_approved` still stop automation because the release is already past
 * the point where additional code changes are safe.
 */
export function shouldRunCursorAutomation(
  releaseStatus: string | undefined,
  briefCounts: BriefCriticalCounts,
  pipelineQaRecommendation?: string,
  implementNowFeedbackCount = 0,
  opts?: {
    stabilize?: boolean;
    /** When set, keep automation alive through `awaiting_approval` until release gates are met. */
    autonomousDeferRelease?: boolean;
    /** False when autonomous mode still needs a higher mean investor grade. */
    investorTargetMet?: boolean;
    /** False when `convergence_contract` is not converged or still has open/regressed objections. */
    contractConvergenceMet?: boolean;
  },
): boolean {
  const hasActionableBriefWork = briefCounts.total > 0;
  const feedbackCount = opts?.stabilize ? 0 : implementNowFeedbackCount;
  const hasQueuedImplementationWork = feedbackCount > 0;

  if (releaseStatus === "approved" || releaseStatus === "auto_approved") return false;

  // QA is green and nothing actionable remains — never burn Cursor quota, even when
  // investor convergence still wants a higher grade (run investor_panel instead).
  if (
    pipelineQaRecommendation === "ship" &&
    !hasActionableBriefWork &&
    !hasQueuedImplementationWork
  ) {
    return false;
  }

  if (
    releaseStatus === "awaiting_approval" &&
    !hasActionableBriefWork &&
    !hasQueuedImplementationWork
  ) {
    return false;
  }

  return (
    hasActionableBriefWork ||
    hasQueuedImplementationWork ||
    pipelineQaRecommendation !== "ship" ||
    releaseStatus === "blocked_by_qa" ||
    releaseStatus === "blocked_pre_release"
  );
}

export async function preflightCursorCommand(command: string, cwd: string): Promise<{
  ok: boolean;
  detail: string;
}> {
  const shell = process.env.SHELL || "/bin/bash";
  const availability = `command -v ${shellQuote(command)} >/dev/null 2>&1 || ${command} --help >/dev/null 2>&1`;
  const availableResult = await execFilePreflight(shell, ["-lc", shellBootstrapCommand(availability)], cwd);
  if (availableResult.exitCode !== 0) {
    return {
      ok: false,
      detail:
        `Cursor command '${command}' could not be executed from the current shell. ` +
        `Set 'cursor_automation.command' in .foundry/project.yaml to the absolute binary path if needed.`,
    };
  }

  const authResult = await execFilePreflight(
    shell,
    ["-lc", shellBootstrapCommand(`${command} status`)],
    cwd,
  );
  const combined = `${authResult.stdout}\n${authResult.stderr}`;
  // Strip ANSI escape sequences from the output before pattern matching.
  // Some older cursor-agent versions emit clear-line/cursor-move codes around
  // the status banner (e.g. "\x1b[2K\x1b[G Starting login process...") which
  // can break negative regex checks even when the binary is authenticated.
  const stripped = combined.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
  if (/Cannot find module '@anysphere\/file-service/i.test(combined)) {
    return {
      ok: false,
      detail:
        `Cursor command '${command}' failed to load a native dependency (@anysphere/file-service-*). ` +
        `This usually means the Cursor CLI install is incomplete, mismatched to your CPU architecture, or corrupted. ` +
        `Reinstall/update the Cursor desktop app (which bundles the CLI), or point 'cursor_automation.command' / FOUNDRY_CURSOR_AGENT_CMD to a working \`agent\` binary.`,
    };
  }

  // POSITIVE signal takes priority. If the binary clearly says "✓ Logged in",
  // "Logged in as", or "authenticated as" and exited cleanly, trust it — even
  // if other parts of the output mention "login" or "Sign in" as a banner.
  const positiveAuth =
    authResult.exitCode === 0 &&
    /(?:^|\s)(?:✓\s*)?Logged in(?: as |[!.\s])/i.test(stripped);
  if (positiveAuth) {
    return { ok: true, detail: `Cursor command '${command}' is available and authenticated.` };
  }

  // Otherwise: explicit unauthenticated phrases or non-zero exit ⇒ not authed.
  const explicitlyUnauthed =
    /authentication required|not logged in|login required|please (?:log ?in|sign ?in)|run [`'"]?cursor-agent login/i.test(
      stripped,
    );
  if (authResult.exitCode !== 0 || explicitlyUnauthed) {
    const lines: string[] = [
      `Cursor command '${command}' is available, but not authenticated.`,
      `Run '${command} login' in your shell first, or set CURSOR_API_KEY in the environment used by Foundry.`,
    ];
    // Most common failure mode: FOUNDRY_CURSOR_AGENT_CMD env var pins Foundry
    // to a stale `cursor-agent` versioned path while the user ran `cursor-agent
    // login` against a different (PATH-resolved) version. Surface this hint
    // up front so they don't waste time re-running `login`.
    const envCmd = process.env.FOUNDRY_CURSOR_AGENT_CMD?.trim();
    if (envCmd && envCmd === command && /\/cursor-agent\/versions\//.test(envCmd)) {
      lines.push("");
      lines.push("HINT: Foundry is using FOUNDRY_CURSOR_AGENT_CMD pinned to a versioned cursor-agent binary:");
      lines.push(`  ${envCmd}`);
      lines.push("If you logged in via `cursor-agent` (PATH-resolved), it likely authenticated a DIFFERENT version.");
      lines.push("Fix by either:");
      lines.push("  (a) `unset FOUNDRY_CURSOR_AGENT_CMD` so Foundry uses your PATH cursor-agent (recommended), OR");
      lines.push("  (b) explicitly authenticate the pinned binary: `\"$FOUNDRY_CURSOR_AGENT_CMD\" login`");
    }
    // Short raw-output trace helps debug binaries that print unexpected text.
    const trace = stripped.slice(0, 240).replace(/\s+/g, " ");
    if (trace.length > 0) {
      lines.push("");
      lines.push(`(raw status output: "${trace}${stripped.length > 240 ? "…" : ""}", exit=${authResult.exitCode})`);
    }
    return { ok: false, detail: lines.join("\n") };
  }

  return { ok: true, detail: `Cursor command '${command}' is available and authenticated.` };
}

function cursorModelSkipsAvailabilityCheck(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m === "auto" || m === "default";
}

/** Cursor `agent` often rejects `--model auto`; use the app/workspace default by omitting the flag. */
export function cursorAgentUsesImplicitModel(model: string): boolean {
  return cursorModelSkipsAvailabilityCheck(model);
}

export async function preflightCursorModels(
  command: string,
  cwd: string,
  models: string[],
): Promise<{ ok: boolean; detail: string }> {
  const shell = process.env.SHELL || "/bin/bash";
  const result = await execFilePreflight(
    shell,
    ["-lc", shellBootstrapCommand(`${command} models`)],
    cwd,
  );
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode !== 0) {
    return {
      ok: false,
      detail:
        `Could not list models from Cursor CLI. Run '${command} models' manually and verify access.`,
    };
  }

  const toVerify = [...new Set(models)].filter((model) => !cursorModelSkipsAvailabilityCheck(model));
  if (toVerify.length === 0) {
    return {
      ok: true,
      detail:
        "Cursor builder uses `auto` / `default` — Foundry omits `--model` (use Cursor's default) and skips `agent models` substring check.",
    };
  }

  // Parse the model list into the exact set of identifiers cursor-agent
  // accepts. Each line is `<model-id> - <Display Name>`; everything before
  // the first " - " is the id. Substring matching (the prior behavior) was
  // too loose — e.g. a configured `claude-opus-4-7-high` could "match" a
  // listed `claude-opus-4-7-high-fast` and still get rejected at runtime.
  const validIds = new Set<string>();
  for (const line of combined.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^Available models/i.test(trimmed)) continue;
    const idMatch = trimmed.match(/^([A-Za-z0-9._-]+)\b/);
    if (idMatch) validIds.add(idMatch[1]);
  }

  const missing = toVerify.filter((model) => !validIds.has(model));
  if (missing.length > 0) {
    // Suggest the closest valid alternatives (same prefix, then any with the
    // model's "family" stem). Helps the operator pick the right rename fast.
    const suggestions = missing.map((m) => {
      const stem = m.replace(/-(?:low|medium|high|xhigh|max|fast|thinking)(?:-|$).*$/g, "");
      const candidates = [...validIds]
        .filter((v) => v.startsWith(stem) || v.includes(stem.split("-")[0] ?? stem))
        .slice(0, 6);
      return `${m}${candidates.length > 0 ? ` (try: ${candidates.join(", ")})` : ""}`;
    });
    return {
      ok: false,
      detail:
        `Configured Cursor model(s) not in '${command} models' list:\n  - ${suggestions.join("\n  - ")}\n` +
        `Edit .foundry/project.yaml \`cursor_automation\` settings (or set builder_model: "auto" to use Cursor's default).`,
    };
  }

  return {
    ok: true,
    detail: `Cursor models are available: ${[...new Set(models)].join(", ")}.`,
  };
}

function execFilePreflight(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, env: process.env, timeout: 15_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error ? 1 : 0,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
        });
      },
    );
  });
}
