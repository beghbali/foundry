#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { mkdir, writeFile, access, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { loadFoundryConfig, listRegisteredStageNames, runPipeline, type RunManifest } from "@foundry/core";
import { readLatestArtifact } from "@foundry/core/artifacts";
import {
  computeInvestorTargetFields,
  hasAutonomousInvestorConvergenceKey,
  resolveAutonomousInvestorConvergenceForRun,
} from "@foundry/core/investorGrades";
import {
  applyBuildSpecTaskCompletions,
  computeUpstreamFingerprint,
  isEnvironmentalWorkItem,
  primaryBuildSpecSlice,
  readBuildSpecFromRepo,
  readBuildSpecLedger,
  writeBuildSpecLedger,
} from "@foundry/core/buildSpec";
import {
  resolveFeedbackOwnerEmails,
  type FeedbackImplementationApproval,
} from "@foundry/core/feedbackPolicy";

import {
  chooseBuilderModel,
  qaNeedsPremiumCursorBuilder,
  qaMaestroSmokeOnlyShipGreen,
  resolveEffectiveInnerLoopMax,
  countCriticalBriefItems,
  formatIterationFocusMarkdown,
  getPipelineSnapshotForConsole,
  logShipGateConsole,
  separateManualAndCodeItems,
  summarizeCoreQaPlanForConsole,
  summarizeCursorBuilderReportMd,
  truncateForDisplay,
  preflightCursorCommand,
  preflightCursorModels,
  manifestStageRan,
  readBuilderRemainingBlockers,
  readStageJson,
  resolveCursorAutomationSettings,
  isLikelyCursorTransportFailure,
  isCursorFreePlanAutoOnlyError,
  runBuilderAgent,
  commitQaGatingFoundryArtifacts,
  syncCursorBuilderReportFromRecentCommits,
  reconcileBuildSpecLedgerFromGitHistory,
  sampleUncheckedBriefLines,
  shouldRunCursorAutomation,
  type BriefCriticalCounts,
  type PipelineIndependentQa,
  type ReleaseAgentBrief,
} from "./cursorAutomation.js";
import {
  evaluateAutoPromoteToMain,
  isDurableLoopShip,
  isQaShipClean,
  shouldRunPrePromotePipelineVerify,
  logFoundryLoopDiagram,
  releaseCandidateVerdictForCycle,
  type DurableShipContext,
} from "./loopPolicy.js";
import {
  backfillExpoBuildViews,
  maybeRunApprovedEasBuild,
  maybeSubmitLatestToTestFlight,
  promoteApprovedBranch,
  resolveEasBuildSettings,
  type EasBuildResult,
  type TestFlightSubmitResult,
} from "./releaseAutomation.js";
import {
  actionableWorkPacketOpenCount,
  createWorkPacket,
  filterBriefItemsForStabilizePhase,
  isNonActionableWorkPacketItem,
  readCheckedBriefItems,
  readOpenBriefItems,
  refreshWorkPacket,
  sampleOpenPacketItems,
  workPacketClosedCount,
  workPacketOpenCount,
  workPacketReopenCount,
  workPacketSummaryLine,
  syncBuilderDirectivePacketClosure,
  type WorkPacket,
} from "./workPacket.js";

function logEasQueuedToConsole(easBuild: EasBuildResult, blankLineBeforeTitle: boolean): void {
  const title = blankLineBeforeTitle ? "\n  EAS build queued." : "  EAS build queued.";
  console.log(chalk.green.bold(title));
  if (easBuild.buildUrl) console.log(chalk.green(`  Build URL: ${easBuild.buildUrl}`));
  if (easBuild.qrCodePngPath) {
    console.log(
      chalk.gray(
        "  Scannable QR (open this image and scan with the phone camera — most reliable):",
      ),
    );
    console.log(chalk.cyan(`  ${easBuild.qrCodePngPath}`));
  }
  if (easBuild.qrCodeAscii) {
    console.log(
      chalk.gray(
        "  Terminal QR (larger cells than before; may still be hard to scan — use PNG above if needed):",
      ),
    );
    console.log(easBuild.qrCodeAscii);
  }
  if (easBuild.logPath) console.log(chalk.gray(`  Build log: ${easBuild.logPath}`));
}

function logTestFlightSubmitToConsole(result: TestFlightSubmitResult, blankLineBeforeTitle: boolean): void {
  const title = blankLineBeforeTitle ? "\n  TestFlight submit queued." : "  TestFlight submit queued.";
  console.log(chalk.green.bold(title));
  console.log(chalk.green(`  ${result.detail}`));
  if (result.logPath) console.log(chalk.gray(`  Submit log: ${result.logPath}`));
}

type BuilderReleaseMeta = {
  branchName?: string;
  baseBranch?: string;
};

type BuilderLoopMeta = BuilderReleaseMeta & {
  status?: "ok" | "partial" | "blocked" | "failed";
  notes?: string[];
  commit?: { sha?: string; message?: string };
  changes?: { filesCreated?: string[]; filesModified?: string[]; filesSkipped?: string[] };
  plan?: { feedbackAddressed?: string[]; gapsAddressed?: string[]; goals?: string[] };
};

function extractBuilderBlockers(builder: BuilderLoopMeta | undefined): string[] {
  if (!builder?.notes?.length) return [];
  const blockerPattern = /(blocked|failed|could not|no resolvable|no files changed|review commands|cannot|error)/i;
  return builder.notes.filter((note) => blockerPattern.test(note)).slice(0, 6);
}

type UnblockGuidance = {
  humanSteps: string[];
  automatableSteps: string[];
};

type InvestorPanelBrief = {
  investors?: Array<{ displayName?: string; grade?: string }>;
  worstGrade?: string;
  meetsMinimumGradeA?: boolean;
  meetsInvestorTarget?: boolean;
  averageInvestorRank?: number;
  combinedRefinementDirectives?: string[];
  refinementRound?: number;
};

function investorPanelMetTarget(
  panel: InvestorPanelBrief | undefined,
  foundry: { autonomous_investor_convergence?: unknown } | undefined,
  loopProfile: LoopProfile,
): boolean {
  if (!panel?.investors?.length) return false;
  const grades = panel.investors
    .map((i) => (typeof i.grade === "string" ? i.grade.trim() : ""))
    .filter((g) => g.length > 0);
  if (grades.length !== 3) return false;
  const auto = resolveAutonomousInvestorConvergenceForRun(foundry, {
    investorLoopDefaults: loopProfile === "investor",
  });
  return computeInvestorTargetFields(grades, auto).meetsInvestorTarget;
}

/** Latest convergence_contract on disk (post-Cursor pipeline slices omit this stage from manifest). */
async function readContractConvergenceGate(repoPath: string): Promise<{ ok: boolean; detail: string }> {
  const raw = await readLatestArtifact(repoPath, "convergence_contract/output.json");
  if (!raw) {
    return { ok: false, detail: "no convergence_contract artifact (run a full pipeline at least once)" };
  }
  try {
    const j = JSON.parse(raw) as {
      isConverged?: boolean;
      openObjections?: Array<{ status?: string }>;
    };
    const open = (j.openObjections ?? []).filter((o) => o.status === "open" || o.status === "regressed").length;
    if (j.isConverged !== true) {
      return { ok: false, detail: "isConverged is not true" };
    }
    if (open > 0) {
      return { ok: false, detail: `${open} open or regressed investor objection(s) on contract` };
    }
    return { ok: true, detail: "converged with no blocking objections" };
  } catch {
    return { ok: false, detail: "could not parse convergence_contract output.json" };
  }
}

type IterationProgress = {
  packetOpen: number;
  packetClosed: number;
  packetReopened: number;
  briefOpen: number;
  briefChecked: number;
  briefTotal: number;
  feedbackAddressed: number;
  gapsAddressed: number;
  filesChanged: number;
  committedChanges: number;
  adaptiveDirectivesLoaded: number;
  adaptiveDirectivesActiveTotal: number;
  investorDirectives: number;
  qaBlockers: number;
  qaManualTasks: number;
  blockedChecklist: number;
};

function isNoOpPacketText(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    /no files changed.*already present/.test(t) ||
    /^nothing to do\b/.test(t) ||
    /^no-op\b/.test(t)
  );
}

function packetBriefCounts(packet: WorkPacket | undefined): BriefCriticalCounts {
  const counts: BriefCriticalCounts = {
    mustShip: 0,
    shouldShip: 0,
    unresolvedGaps: 0,
    monetization: 0,
    edgeFunctions: 0,
    runtime: 0,
    total: 0,
  };
  for (const item of packet?.items ?? []) {
    if (item.status !== "open") continue;
    if (isNoOpPacketText(item.text)) continue;
    if (isNonActionableWorkPacketItem(item.text)) continue;
    if (item.section === "runtime") counts.runtime++;
    else if (item.section === "must" || item.section === "qa") counts.mustShip++;
    else if (item.section === "should") counts.shouldShip++;
    else if (item.section === "gaps" || item.section === "builder") counts.unresolvedGaps++;
    else if (item.section === "monetization") counts.monetization++;
    else if (item.section === "edge") counts.edgeFunctions++;
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

function safeLen(arr: unknown[] | undefined): number {
  return Array.isArray(arr) ? arr.length : 0;
}

function blockedChecklistCount(release: ReleaseAgentBrief | undefined): number {
  return safeLen((release?.releaseChecklist ?? []).filter((i) => i.status === "blocked"));
}

type LoopProfile = "release" | "investor";

function postCursorPipelineStages(profile: LoopProfile, includeInvestor: boolean): string[] {
  if (profile === "investor") {
    const base = ["independent_qa", "release_agent", "growth_operator"];
    return includeInvestor ? [...base, "investor_panel"] : base;
  }
  return ["independent_qa", "release_agent"];
}

/**
 * Stabilize loops never run growth/investor after Cursor.
 * For investor profile, we run investor_panel only ONCE per outer cycle (the final
 * inner pass) instead of after every inner Cursor pass — investors should grade
 * the cycle's full delta, not partial in-progress edits. This cuts ~2-3 min/cycle
 * of LLM panel calls scoring the same product across inner passes.
 */
function postCursorStagesForLoop(
  profile: LoopProfile,
  stabilize: boolean,
  isLastInnerPass: boolean,
): string[] {
  if (stabilize) return ["independent_qa", "release_agent"];
  return postCursorPipelineStages(profile, isLastInnerPass);
}

function logReleaseCandidateLine(
  qa: PipelineIndependentQa | undefined,
  release: ReleaseAgentBrief | undefined,
  opts?: { durableShip?: boolean; qaReused?: boolean },
): void {
  const v = releaseCandidateVerdictForCycle(qa, release, opts?.durableShip === true);
  if (v.yes) {
    console.log(chalk.green.bold(`\n  RELEASE_CANDIDATE: YES  (${v.reason})`));
  } else {
    console.log(chalk.red.bold(`\n  RELEASE_CANDIDATE: NO  (${v.reason})`));
  }
  if (opts?.qaReused) {
    console.log(
      chalk.yellow(
        "  Note: independent_qa output was reused from cache this pass — verify with a fresh `foundry run` if this looks wrong.",
      ),
    );
  }
}

function formatQaLine(qa: PipelineIndependentQa | undefined): string {
  if (!qa) return "missing";
  const blockers = qa.blockers?.length ?? 0;
  const first =
    blockers > 0 && qa.blockers?.[0]
      ? ` · ${truncateForDisplay(qa.blockers[0], 72)}`
      : "";
  return `${qa.recommendation ?? "?"} · score=${qa.score ?? "?"} · blockers=${blockers}${first}`;
}

function logCycleQaSummary(args: {
  outerQa: PipelineIndependentQa | undefined;
  endQa: PipelineIndependentQa | undefined;
  endQaReused: boolean;
  innerPasses: number;
  cursorProductFileCount: number;
  cursorQaArtifactFileCount: number;
  durableShip: boolean;
  promoted: boolean;
  promoteReason?: string;
  builderBranch?: string;
}): void {
  console.log(chalk.bold("\n  Cycle QA summary"));
  console.log(chalk.gray(`  Outer pipeline:  ${formatQaLine(args.outerQa)}`));
  console.log(
    chalk.gray(
      `  End of cycle:    ${formatQaLine(args.endQa)}${args.endQaReused ? " · independent_qa reused" : ""}`,
    ),
  );
  console.log(
    chalk.gray(
      `  Cursor: ${args.innerPasses} inner pass(es) · ${args.cursorProductFileCount} product file(s) · ${args.cursorQaArtifactFileCount} QA-artifact file(s) committed`,
    ),
  );
  console.log(
    args.durableShip
      ? chalk.green("  Durable ship:  yes (safe to merge — changes should survive the next outer pipeline)")
      : chalk.yellow("  Durable ship:  no (post-Cursor green only — will not merge to main)"),
  );
  if (args.promoted && args.builderBranch) {
    console.log(chalk.gray(`  Promoted: ${args.builderBranch} → main → origin (${args.promoteReason ?? "ok"})`));
  } else if (args.builderBranch?.startsWith("foundry/")) {
    console.log(chalk.gray(`  Promoted: skipped (${args.promoteReason ?? "QA gate"})`));
  }
}

function logInvestorScoreLine(investor: InvestorPanelBrief | undefined): void {
  if (!investor?.investors?.length) {
    console.log(chalk.gray("\n  INVESTOR_PANEL: (no output this run — stage skipped or not executed)"));
    return;
  }
  const grades = investor.investors.map((i) => `${i.displayName ?? "investor"}=${i.grade ?? "?"}`).join(" · ");
  const bar = investor.meetsMinimumGradeA ? chalk.green("all A- or better: YES") : chalk.yellow("all A- or better: NO");
  const tgt =
    investor.meetsInvestorTarget !== undefined
      ? investor.meetsInvestorTarget
        ? chalk.green("target met: YES")
        : chalk.yellow("target met: NO")
      : null;
  const avg =
    typeof investor.averageInvestorRank === "number"
      ? ` · mean_rank=${investor.averageInvestorRank.toFixed(2)}`
      : "";
  console.log(chalk.bold(`\n  INVESTOR_SCORES: ${grades}`));
  console.log(chalk.gray(`  worst=${investor.worstGrade ?? "?"} · ${bar}${avg}${tgt ? ` · ${tgt}` : ""}`));
  const d = investor.combinedRefinementDirectives?.length ?? 0;
  if (d > 0) {
    console.log(chalk.gray(`  refinement directives queued: ${d} (fed into next product stages when refinement runs)`));
  }
}

async function runInvestorPanelForLoop(args: {
  repoPath: string;
  pipelineName: string;
  foundryRoot: string;
  manifest: RunManifest;
  loopProfile: LoopProfile;
  forceBypassQa?: boolean;
  spinnerLabel?: string;
}): Promise<{ manifest: RunManifest; investorOutput: InvestorPanelBrief | undefined; ran: boolean }> {
  if (args.loopProfile !== "investor") {
    return { manifest: args.manifest, investorOutput: undefined, ran: false };
  }
  const ipSpinner = ora(
    args.spinnerLabel ??
      (args.forceBypassQa
        ? "Running investor_panel (QA-gate-bypassed backfill)..."
        : "Running investor_panel..."),
  ).start();
  try {
    const manifest = await runPipeline({
      repoPath: args.repoPath,
      pipelineName: args.pipelineName,
      foundryRoot: args.foundryRoot,
      quiet: true,
      allowInvestorRefinement: false,
      investorLoopAutonomousDefaults: true,
      stagesOverride: ["investor_panel"],
      forceInvestorPanelBypassQaGate: args.forceBypassQa,
    });
    const ran = manifestStageRan(manifest, "investor_panel");
    if (ran) ipSpinner.succeed("investor_panel completed.");
    else ipSpinner.warn("investor_panel still skipped by another gate (builder/convergence/directives).");
    const investorOutput = await readStageJson<InvestorPanelBrief>(args.repoPath, manifest, "investor_panel");
    if (ran) logInvestorScoreLine(investorOutput);
    return { manifest, investorOutput, ran };
  } catch (err) {
    ipSpinner.fail(err instanceof Error ? err.message : String(err));
    return { manifest: args.manifest, investorOutput: undefined, ran: false };
  }
}

type BriefMetrics = {
  open: number;
  checked: number;
  total: number;
};

async function readBriefMetrics(briefPath: string): Promise<BriefMetrics> {
  let raw = "";
  try {
    raw = await readFile(briefPath, "utf8");
  } catch {
    return { open: 0, checked: 0, total: 0 };
  }

  let section: "must" | "should" | "gaps" | "monetization" | "edge" | "runtime" | "other" = "other";
  let open = 0;
  let checked = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "### Must Ship (Phase 1)") section = "must";
    else if (trimmed === "### Should Ship (stretch)") section = "should";
    else if (trimmed === "## Unresolved Gaps (Cursor should fix these)") section = "gaps";
    else if (trimmed === "## Monetization Integration") section = "monetization";
    else if (trimmed === "## Edge Function Rate Limiting") section = "edge";
    else if (trimmed === "## Runtime Failures To Fix First") section = "runtime";
    else if (trimmed.startsWith("## ") || trimmed.startsWith("### ")) section = "other";

    if (section === "other") continue;
    if (trimmed.startsWith("- [ ]")) open++;
    if (trimmed.startsWith("- [x]")) checked++;
  }
  return { open, checked, total: open + checked };
}

async function findLatestPipelineRunId(foundryDir: string): Promise<string | undefined> {
  const outRoot = join(foundryDir, "out");
  let names: string[];
  try {
    names = await readdir(outRoot);
  } catch {
    return undefined;
  }
  let best: { id: string; ms: number } | undefined;
  for (const id of names) {
    try {
      const st = await stat(join(outRoot, id, "run.json"));
      if (!best || st.mtimeMs > best.ms) best = { id, ms: st.mtimeMs };
    } catch {
      /* not a run dir */
    }
  }
  return best?.id;
}

async function tryReadJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Readable snapshot: packet, brief, last QA/release/investor — without running the pipeline. */
async function printFoundryStatusDashboard(repoPath: string): Promise<void> {
  const foundryDir = join(repoPath, ".foundry");
  const briefPath = join(foundryDir, "CURSOR_BRIEF.md");
  const brief = await readBriefMetrics(briefPath);
  const bar = "═".repeat(56);

  console.log(chalk.bold.cyan(`\n${bar}`));
  console.log(chalk.bold.cyan("  FOUNDRY STATUS (read-only snapshot)"));
  console.log(chalk.bold.cyan(`${bar}`));
  console.log(chalk.gray(`  Repo: ${repoPath}\n`));

  const wpPath = join(foundryDir, "WORK_PACKET.json");
  const wpRaw = await tryReadJson(wpPath);
  const wp = wpRaw as
    | {
        runId?: string;
        items?: Array<{ status?: string; section?: string; source?: string; text?: string }>;
        manualOnly?: string[];
      }
    | undefined;

  console.log(chalk.bold.white("  ACTIVE WORK PACKET"));
  if (!wp?.items?.length) {
    console.log(chalk.gray("    (no WORK_PACKET.json — run a pipeline + loop to generate one)\n"));
  } else {
    const open = wp.items.filter((i) => i.status === "open");
    console.log(
      chalk.gray(
        `    Frozen for outer-cycle scope · packet run ${wp.runId ?? "?"} · ${open.length} open / ${wp.items.length} total`,
      ),
    );
    console.log(
      chalk.gray(
        "    Inner Cursor passes only target these lines (not the whole brief backlog at once).\n",
      ),
    );
    open.forEach((it, i) => {
      const tag = [it.source, it.section].filter(Boolean).join("/") || "item";
      console.log(chalk.yellow(`    ${i + 1}. [${tag}] ${truncateForDisplay(it.text ?? "", 118)}`));
    });
    console.log("");
    if (wp.manualOnly?.length) {
      console.log(chalk.bold.white("  MANUAL-ONLY (outside packet closure)"));
      wp.manualOnly.slice(0, 8).forEach((line, i) => {
        console.log(chalk.gray(`    ${i + 1}. ${truncateForDisplay(line, 118)}`));
      });
      console.log("");
    }
  }

  console.log(chalk.bold.white("  BRIEF (tracked sections)"));
  console.log(
    chalk.gray(`    Open: ${brief.open} · Checked: ${brief.checked} · Total: ${brief.total}  →  ${join(foundryDir, "CURSOR_BRIEF.md")}`),
  );
  if (brief.open > 0) {
    const bl = await sampleUncheckedBriefLines(briefPath, 15);
    if (bl.length > 0) {
      console.log(chalk.gray("    Open `- [ ]` lines:"));
      bl.forEach((line, i) => console.log(chalk.yellow(`      ${i + 1}. ${truncateForDisplay(line, 112)}`)));
    }
    console.log(
      chalk.gray(`    Mirror: ${join(foundryDir, "OPEN_TRACKED_BRIEF.md")} (from last release_agent run)`),
    );
  }
  console.log("");

  const runId = await findLatestPipelineRunId(foundryDir);
  if (!runId) {
    console.log(chalk.bold.white("  LAST PIPELINE RUN"));
    console.log(chalk.gray("    (no .foundry/out/<run>/ yet — run `foundry run` once)\n"));
    console.log(chalk.bold.dim(`${bar}\n`));
    return;
  }

  const outDir = join(foundryDir, "out", runId);
  const qa = (await tryReadJson(join(outDir, "independent_qa", "output.json"))) as
    | PipelineIndependentQa
    | undefined;
  const release = (await tryReadJson(join(outDir, "release_agent", "output.json"))) as
    | ReleaseAgentBrief
    | undefined;
  const investor = (await tryReadJson(join(outDir, "investor_panel", "output.json"))) as
    | InvestorPanelBrief
    | undefined;

  console.log(chalk.bold.white(`  LAST PIPELINE RUN  (${runId})`));
  const rec = qa?.recommendation ?? "missing";
  const bl = qa?.blockers ?? [];
  console.log(
    rec === "ship" && bl.length === 0
      ? chalk.green(`    independent_qa: ${rec} · score=${qa?.score ?? "—"} · blockers: none`)
      : chalk.yellow(
          `    independent_qa: ${rec} · score=${qa?.score ?? "—"} · blockers: ${bl.length}`,
        ),
  );
  bl.slice(0, 6).forEach((b, i) => console.log(chalk.yellow(`      ${i + 1}. ${truncateForDisplay(b, 110)}`)));
  if (bl.length > 6) console.log(chalk.gray(`      … +${bl.length - 6} more`));
  const maestroCheck = qa?.checks?.find((c: { name?: string }) => c.name === "maestro_smoke");
  if (maestroCheck && typeof maestroCheck === "object" && "details" in maestroCheck) {
    const d = String((maestroCheck as { details?: string }).details ?? "");
    if (d && d.length > 20) {
      console.log(chalk.gray(`    Maestro check: ${truncateForDisplay(d.replace(/\s+/g, " ").trim(), 140)}`));
    }
  }
  console.log(chalk.gray(`    Artifacts: ${outDir}`));
  console.log("");

  console.log(chalk.bold.white("  RELEASE"));
  const rs = release?.status ?? "missing";
  console.log(chalk.gray(`    release_agent.status: ${rs}`));
  const blockedRows = (release?.releaseChecklist ?? []).filter((r) => r.status === "blocked");
  blockedRows.slice(0, 6).forEach((row, i) => {
    console.log(chalk.yellow(`      blocked ${i + 1}. ${truncateForDisplay(row.item + (row.notes ? ` — ${row.notes}` : ""), 108)}`));
  });
  console.log("");

  console.log(chalk.bold.white("  INVESTOR (same run, if stage ran)"));
  if (!investor || (!investor.investors?.length && !(investor.combinedRefinementDirectives?.length ?? 0))) {
    console.log(chalk.gray("    (no investor_panel output in this run — use `foundry loop --profile investor`)\n"));
  } else {
    const inv0 = investor;
    console.log(
      chalk.gray(
        `    meets_A-=${inv0.meetsMinimumGradeA ? "yes" : "no"} · worst=${inv0.worstGrade ?? "?"} · directives=${inv0.combinedRefinementDirectives?.length ?? 0}`,
      ),
    );
    (inv0.investors ?? []).slice(0, 4).forEach((inv) => {
      console.log(
        chalk.gray(
          `      ${inv.displayName ?? "?"}: ${inv.grade ?? "?"}`,
        ),
      );
    });
    const dirs = inv0.combinedRefinementDirectives ?? [];
    dirs.slice(0, 5).forEach((d, i) => {
      console.log(chalk.cyan(`      D${i + 1}. ${truncateForDisplay(d, 110)}`));
    });
    if (dirs.length > 5) console.log(chalk.gray(`      … +${dirs.length - 5} more directives`));
    console.log("");
  }

  console.log(chalk.bold.white("  WHY THIS DOES NOT ALL CONVERGE AT ONCE"));
  console.log(
    chalk.gray(
      "    • Work packet is one frozen slice per outer cycle — Maestro, monetization, and brief items are separate goals.",
    ),
  );
  console.log(
    chalk.gray(
      "    • Investor directives refine upstream stages (product_definition, etc.); they do not auto-remove packet rows.",
    ),
  );
  console.log(
    chalk.gray(
      "    • `foundry/*` builder branches and main are a merge/push gate — not conflicting feature code unless you have real merge conflicts.",
    ),
  );
  console.log(
    chalk.gray(
      "    • Maestro in CI/pipeline needs a simulator + app + Metro (or use `qa_automation.maestro.pipeline_command` → e.g. npm preflight).",
    ),
  );
  console.log("");
  console.log(chalk.bold.white("  COMMANDS"));
  console.log(chalk.gray("    foundry status --repo .          ← this dashboard"));
  console.log(chalk.gray("    foundry run --repo . --quiet     ← pipeline without per-stage log spam"));
  console.log(chalk.bold.dim(`${bar}\n`));
}

/**
 * After a Cursor pass commits product code, update BUILD_SPEC_LEDGER:
 *   - mark tasks whose `files[]` are entirely covered by the diff as complete
 *   - accumulate LOC totals for those tasks
 * Logs a one-liner summary so the operator sees which directives actually closed.
 */
/**
 * Snapshot the BUILD_SPEC_LEDGER and BUILD_SPEC before each Cursor pass so
 * that if Cursor edits the generated files (despite the prompt telling it
 * not to), we can detect and restore. Returns the absolute path of the
 * snapshot file (consumed by `updateBuildSpecLedgerFromPass`).
 *
 * Without this, the ledger's `tasks` map gets wiped between inner passes
 * and the same tasks appear as "newly closed" cycle after cycle.
 */
/**
 * Resolve the canonical snapshot directory. We deliberately put this under
 * `.foundry/automation/` (already covered by GENERATED_FOUNDRY_PREFIXES and
 * the .gitignore block) so Cursor's autocommit never picks the snapshot
 * files up as "changed product files". Prior versions used
 * `.foundry/.pre-cursor-snapshots/`; if that path exists on disk we
 * one-time-untrack it from git so old commits don't keep re-staging.
 */
function ledgerSnapshotDir(repoPath: string): string {
  return join(repoPath, ".foundry", "automation", ".pre-cursor-snapshots");
}

async function untrackLegacySnapshotDirIfPresent(repoPath: string): Promise<void> {
  const fs = await import("node:fs/promises");
  const legacy = join(repoPath, ".foundry", ".pre-cursor-snapshots");
  try {
    const st = await fs.stat(legacy);
    if (!st.isDirectory()) return;
  } catch {
    return;
  }
  try {
    const cp = await import("node:child_process");
    await new Promise<void>((res) => {
      const child = cp.spawn(
        "git",
        ["rm", "-rf", "--cached", "--ignore-unmatch", ".foundry/.pre-cursor-snapshots"],
        { cwd: repoPath, stdio: "ignore" },
      );
      child.on("close", () => res());
      child.on("error", () => res());
    });
  } catch {
    // best-effort
  }
  try {
    await fs.rm(legacy, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

async function snapshotBuildSpecArtifactsBeforeCursor(repoPath: string): Promise<void> {
  await untrackLegacySnapshotDirIfPresent(repoPath);
  const fs = await import("node:fs/promises");
  const snapDir = ledgerSnapshotDir(repoPath);
  await fs.mkdir(snapDir, { recursive: true });
  for (const rel of ["BUILD_SPEC_LEDGER.json", "BUILD_SPEC.json"]) {
    const src = join(repoPath, ".foundry", rel);
    const dst = join(snapDir, rel);
    try {
      await fs.copyFile(src, dst);
    } catch {
      try { await fs.unlink(dst); } catch { /* ignore */ }
    }
  }
}

function snapshotPathFor(repoPath: string, rel: string): string {
  return join(ledgerSnapshotDir(repoPath), rel);
}

/**
 * Restore the ledger from the pre-Cursor snapshot if Cursor wiped or
 * truncated it. We trust the snapshot when (a) snapshot has more task
 * entries than the on-disk file, or (b) snapshot has more addressed
 * parents. Cursor edits to generated files are silently overwritten.
 */
async function restoreLedgerIfCursorWipedIt(repoPath: string): Promise<{ restored: boolean; reason?: string }> {
  const fs = await import("node:fs/promises");
  const snapPath = snapshotPathFor(repoPath, "BUILD_SPEC_LEDGER.json");
  const livePath = join(repoPath, ".foundry", "BUILD_SPEC_LEDGER.json");
  let snapRaw = "";
  let liveRaw = "";
  try { snapRaw = await fs.readFile(snapPath, "utf8"); } catch { return { restored: false }; }
  try { liveRaw = await fs.readFile(livePath, "utf8"); } catch { liveRaw = ""; }

  type LedgerShape = { tasks?: Record<string, unknown>; addressedParents?: Record<string, unknown> };
  let snap: LedgerShape = {};
  let live: LedgerShape = {};
  try { snap = JSON.parse(snapRaw) as LedgerShape; } catch { return { restored: false }; }
  try { live = liveRaw ? (JSON.parse(liveRaw) as LedgerShape) : {}; } catch { live = {}; }

  const snapTasks = Object.keys(snap.tasks ?? {}).length;
  const liveTasks = Object.keys(live.tasks ?? {}).length;
  const snapParents = Object.keys(snap.addressedParents ?? {}).length;
  const liveParents = Object.keys(live.addressedParents ?? {}).length;

  if (liveTasks < snapTasks || liveParents < snapParents) {
    await fs.copyFile(snapPath, livePath);
    return {
      restored: true,
      reason: `tasks ${liveTasks}→${snapTasks}, addressedParents ${liveParents}→${snapParents}`,
    };
  }
  return { restored: false };
}

/**
 * Also restore the BUILD_SPEC if Cursor truncated/wiped it. The wizard's
 * generated spec must persist between passes so the same task IDs continue
 * to anchor `taskCompletedByEdits` lookups.
 */
async function restoreBuildSpecIfCursorWipedIt(repoPath: string): Promise<{ restored: boolean; reason?: string }> {
  const fs = await import("node:fs/promises");
  const snapPath = snapshotPathFor(repoPath, "BUILD_SPEC.json");
  const livePath = join(repoPath, ".foundry", "BUILD_SPEC.json");
  let snapRaw = "";
  let liveRaw = "";
  try { snapRaw = await fs.readFile(snapPath, "utf8"); } catch { return { restored: false }; }
  try { liveRaw = await fs.readFile(livePath, "utf8"); } catch { liveRaw = ""; }

  type SpecShape = { slices?: Array<{ tasks?: unknown[] }> };
  let snap: SpecShape = {};
  let live: SpecShape = {};
  try { snap = JSON.parse(snapRaw) as SpecShape; } catch { return { restored: false }; }
  try { live = liveRaw ? (JSON.parse(liveRaw) as SpecShape) : {}; } catch { live = {}; }

  const snapTasks = (snap.slices?.[0]?.tasks ?? []).length;
  const liveTasks = (live.slices?.[0]?.tasks ?? []).length;

  if (liveTasks < snapTasks) {
    await fs.copyFile(snapPath, livePath);
    return { restored: true, reason: `slice tasks ${liveTasks}→${snapTasks}` };
  }
  return { restored: false };
}

async function updateBuildSpecLedgerFromPass(
  repoPath: string,
  runId: string,
  builderRun: {
    changedFiles: string[];
    diffStats?: Array<{ file: string; added: number; removed: number }>;
  },
): Promise<void> {
  const restoredSpec = await restoreBuildSpecIfCursorWipedIt(repoPath);
  if (restoredSpec.restored) {
    console.log(chalk.yellow(`  BUILD_SPEC was truncated by Cursor — restored from pre-Cursor snapshot (${restoredSpec.reason}).`));
  }
  const restoredLedger = await restoreLedgerIfCursorWipedIt(repoPath);
  if (restoredLedger.restored) {
    console.log(chalk.yellow(`  BUILD_SPEC_LEDGER was wiped by Cursor — restored from pre-Cursor snapshot (${restoredLedger.reason}).`));
  }

  const spec = await readBuildSpecFromRepo(repoPath);
  if (!spec) return;
  const ledger = await readBuildSpecLedger(repoPath);
  const { ledger: nextLedger, newlyCompleted, newlyAddressedParents } = applyBuildSpecTaskCompletions(
    spec,
    ledger,
    builderRun.changedFiles,
    runId,
    builderRun.diffStats ?? [],
  );

  if (newlyCompleted.length > 0) {
    await writeBuildSpecLedger(repoPath, nextLedger);
    const slice = spec.slices[0];
    const totalDone = slice ? slice.tasks.filter((t) => t.id in nextLedger.tasks).length : newlyCompleted.length;
    const totalTasks = slice?.tasks.length ?? newlyCompleted.length;
    const totalAddressed = Object.keys(nextLedger.addressedParents ?? {}).length;
    console.log(
      chalk.green(
        `  BUILD_SPEC_LEDGER: closed ${newlyCompleted.length} task(s) this pass (${totalDone}/${totalTasks} cumulative). Closed: ${newlyCompleted.join(", ")}`,
      ),
    );
    if (newlyAddressedParents.length > 0) {
      console.log(
        chalk.green(
          `  BUILD_SPEC_LEDGER: ${newlyAddressedParents.length} parent directive(s) now ADDRESSED (won't re-emit). Cumulative: ${totalAddressed}.`,
        ),
      );
    }
  } else if (newlyAddressedParents.length > 0) {
    await writeBuildSpecLedger(repoPath, nextLedger);
    console.log(
      chalk.green(
        `  BUILD_SPEC_LEDGER: ${newlyAddressedParents.length} parent directive(s) now ADDRESSED (won't re-emit).`,
      ),
    );
  } else {
    const slice = spec.slices[0];
    if (slice?.tasks.some((t) => !(t.id in nextLedger.tasks))) {
      const remaining = slice.tasks.filter((t) => !(t.id in nextLedger.tasks)).map((t) => t.id);
      console.log(
        chalk.yellow(
          `  BUILD_SPEC_LEDGER: 0 task(s) fully closed by this pass (edits did not cover all files for any open task). Open: ${remaining.slice(0, 4).join(", ")}${remaining.length > 4 ? ` … +${remaining.length - 4}` : ""}`,
        ),
      );
    }
  }
}

async function buildWorkPacketForRun(params: {
  repoPath: string;
  foundryDir: string;
  runId: string;
  pipelineQa: PipelineIndependentQa | undefined;
  builder: BuilderLoopMeta | undefined;
  builderRemainingBlockers: string[];
  stabilize?: boolean;
}): Promise<WorkPacket> {
  const briefPath = join(params.foundryDir, "CURSOR_BRIEF.md");
  let briefOpenItems = await readOpenBriefItems(briefPath);
  if (params.stabilize) {
    briefOpenItems = filterBriefItemsForStabilizePhase(briefOpenItems, params.pipelineQa);
  }
  const buildSpec = await readBuildSpecFromRepo(params.repoPath);
  const ledger = await readBuildSpecLedger(params.repoPath);
  const primarySliceRaw = buildSpec ? primaryBuildSpecSlice(buildSpec) : undefined;
  // Only forward the slice to the work packet when (a) it has unclosed tasks
  // OR (b) the original spec had no tasks at all (heuristic-only acceptance).
  // When the original had tasks but ledger closed them all, we drop the slice
  // entirely so createWorkPacket does NOT replay acceptance criteria as new
  // "must ship" items.
  let primarySlice = undefined as ReturnType<typeof primaryBuildSpecSlice> | undefined;
  if (primarySliceRaw) {
    const filteredTasks = primarySliceRaw.tasks.filter((t) => !(t.id in ledger.tasks));
    const originalHadTasks = primarySliceRaw.tasks.length > 0;
    if (filteredTasks.length > 0) {
      primarySlice = { ...primarySliceRaw, tasks: filteredTasks };
    } else if (!originalHadTasks) {
      primarySlice = primarySliceRaw;
    }
    // else: every task is in the ledger -> no `must ship` from this spec.
  }
  const qaSeparated = separateManualAndCodeItems([
    ...(params.pipelineQa?.blockers ?? []),
    ...(params.pipelineQa?.manualTasks ?? []),
  ]);
  const builderSeparated = separateManualAndCodeItems([
    ...extractBuilderBlockers(params.builder),
    ...params.builderRemainingBlockers,
  ]);
  let projectBuilderDirectives: string[] | undefined;
  if (!primarySlice || primarySlice.tasks.length === 0) {
    const cfg = await loadFoundryConfig(params.repoPath);
    const anchored = (cfg.project.builder?.directives ?? [])
      .map((d) => {
        const desc = d.description?.trim();
        if (!desc) return "";
        const files = d.files?.length
          ? ` — files: ${d.files.map((f) => `\`${f}\``).join(", ")}`
          : "";
        // Removal directives are verified by absence: tell Cursor to strip the
        // surface AND add/keep a test asserting it no longer appears, so the
        // loop can subtract clutter rather than only accrete features.
        if (d.action === "remove") {
          return `[builder-directive][remove] Remove from user-facing screens: ${desc}. Done = the surface is deleted AND a test asserts its absence (text/testID no longer present).${files}`;
        }
        return `[builder-directive] ${desc}${files}`;
      })
      .filter((line) => line.length > 0);
    if (anchored.length > 0) projectBuilderDirectives = anchored;
  }
  return createWorkPacket({
    repoPath: params.repoPath,
    runId: params.runId,
    briefOpenItems,
    checkedBriefItems: await readCheckedBriefItems(briefPath),
    qaCodeBlockers: qaSeparated.code,
    builderCodeBlockers: builderSeparated.code,
    manualOnly: [...qaSeparated.manual, ...builderSeparated.manual],
    codeChanged: false,
    buildSpecPrimarySlice: primarySlice,
    freezeBriefToBuildSpec: !!buildSpec,
    projectBuilderDirectives,
  });
}

function parseCommittedChangesFromBuilder(builder: BuilderLoopMeta | undefined): number {
  if (!builder?.notes?.length) return 0;
  for (const note of builder.notes) {
    const m = /Committed\s+(\d+)\s+change\(s\)/i.exec(note);
    if (m?.[1]) return Number.parseInt(m[1], 10) || 0;
  }
  return 0;
}

function isTestLikePath(path: string): boolean {
  if (/^\.maestro\//i.test(path)) return true;
  /** QA harness scripts are “test-like” infrastructure. */
  if (/^scripts\/(qa-device|maestro-preflight)\.sh$/i.test(path)) return true;
  return /(^|\/)(test|tests|__tests__)\/|(\.|-)(test|spec)\.[a-z0-9]+$/i.test(path);
}

function isProductFeaturePath(path: string): boolean {
  if (path.startsWith(".foundry/")) return false;
  if (path.startsWith(".maestro-debug/")) return false;
  /** `.maestro/*.yaml` is E2E infra — counts as product for feature work, but `isTestLikePath` also true for QA-repair gates. */
  if (isTestLikePath(path) && !/^\.maestro\//i.test(path)) return false;
  if (/^(docs|scripts)\//i.test(path)) return false;
  /** Committed Maestro flows (not generated `.maestro-debug/`). Counts as product when QA is driven by E2E. */
  if (/^\.maestro\//i.test(path)) return true;
  // Monorepo apps
  if (/^apps\/[^/]+\/(src|app)\//i.test(path)) return true;
  /** Expo/native app configuration can be the product fix for release build failures. */
  if (/^apps\/[^/]+\/(app\.config\.[cm]?[jt]s|app\.json|eas\.json|package\.json)$/i.test(path)) return true;
  if (/^packages\/[^/]+\/src\//i.test(path)) return true;
  if (/^supabase\/(functions|migrations)\//i.test(path)) return true;
  // Expo / RN at repo root (mobileRoot ".") and common adjunct roots
  if (
    /^(app|src|components|hooks|lib|screens|services|constants|types|features|modules|navigation|utils|contexts|providers|theme|styles|shared|platform|config|plugins)\//i.test(
      path,
    )
  )
    return true;
  return false;
}

function isMonetizationLikePath(path: string): boolean {
  return /(paywall|pricing|price|subscription|purchase|billing|entitlement|revenuecat|analytics|usagegate)/i.test(path);
}

function parseAdaptiveDirectiveSignals(builder: BuilderLoopMeta | undefined): {
  loaded: number;
  active: number;
} {
  if (!builder?.notes?.length) return { loaded: 0, active: 0 };
  for (const note of builder.notes) {
    const m = /Adaptive resolver memory updated:\s*(\d+)\s+active\s+\((\d+)\s+loaded this run\)/i.exec(note);
    if (m) {
      return {
        active: Number.parseInt(m[1] ?? "0", 10) || 0,
        loaded: Number.parseInt(m[2] ?? "0", 10) || 0,
      };
    }
  }
  return { loaded: 0, active: 0 };
}

function buildIterationProgress(
  brief: BriefMetrics,
  builder: BuilderLoopMeta | undefined,
  qa: PipelineIndependentQa | undefined,
  release: ReleaseAgentBrief | undefined,
  investor: InvestorPanelBrief | undefined,
  packet: WorkPacket | undefined,
  /** Last Cursor agent pass may touch files without updating the codegen `builder` stage artifact — count those for convergence. */
  cursorAgentChangedFileCount?: number,
): IterationProgress {
  const fromBuilderStage =
    safeLen(builder?.changes?.filesCreated) + safeLen(builder?.changes?.filesModified);
  const fromCursor = cursorAgentChangedFileCount ?? 0;
  const filesChanged = Math.max(fromBuilderStage, fromCursor);
  const committedChanges = parseCommittedChangesFromBuilder(builder);
  const adaptive = parseAdaptiveDirectiveSignals(builder);
  return {
    packetOpen: workPacketOpenCount(packet),
    packetClosed: workPacketClosedCount(packet),
    packetReopened: workPacketReopenCount(packet),
    briefOpen: brief.open,
    briefChecked: brief.checked,
    briefTotal: brief.total,
    feedbackAddressed: safeLen(builder?.plan?.feedbackAddressed),
    gapsAddressed: safeLen(builder?.plan?.gapsAddressed),
    filesChanged,
    committedChanges,
    adaptiveDirectivesLoaded: adaptive.loaded,
    adaptiveDirectivesActiveTotal: adaptive.active,
    investorDirectives: safeLen(investor?.combinedRefinementDirectives),
    qaBlockers: safeLen(qa?.blockers),
    qaManualTasks: safeLen(qa?.manualTasks),
    blockedChecklist: blockedChecklistCount(release),
  };
}

function deltaLabel(curr: number, prev: number | undefined): string {
  if (prev === undefined) return "Δ n/a";
  const delta = curr - prev;
  const sign = delta > 0 ? "+" : "";
  return `Δ ${sign}${delta}`;
}

function logIterationProgress(
  progress: IterationProgress,
  prev: IterationProgress | undefined,
  builder: BuilderLoopMeta | undefined,
  qa: PipelineIndependentQa | undefined,
  release: ReleaseAgentBrief | undefined,
  investor: InvestorPanelBrief | undefined,
  stagnantStreak: number,
): void {
  const progressing: string[] = [];
  const notProgressing: string[] = [];
  if (prev) {
    if (progress.packetOpen < prev.packetOpen) progressing.push(`packet_open ${prev.packetOpen}→${progress.packetOpen}`);
    else notProgressing.push(`packet_open ${progress.packetOpen} (no decrease)`);
    if (progress.packetClosed > prev.packetClosed) progressing.push(`packet_closed ${prev.packetClosed}→${progress.packetClosed}`);
    if (progress.briefOpen < prev.briefOpen) progressing.push(`brief_open ${prev.briefOpen}→${progress.briefOpen}`);
    else notProgressing.push(`brief_open ${progress.briefOpen} (no decrease)`);
    if (progress.briefChecked > prev.briefChecked) progressing.push(`brief_checked ${prev.briefChecked}→${progress.briefChecked}`);
    else notProgressing.push(`brief_checked ${progress.briefChecked} (no increase)`);
    if (progress.qaBlockers < prev.qaBlockers) progressing.push(`qa_blockers ${prev.qaBlockers}→${progress.qaBlockers}`);
    if (progress.blockedChecklist < prev.blockedChecklist) progressing.push(`release_blocked ${prev.blockedChecklist}→${progress.blockedChecklist}`);
    if (progress.adaptiveDirectivesActiveTotal < prev.adaptiveDirectivesActiveTotal) {
      progressing.push(`adaptive_active ${prev.adaptiveDirectivesActiveTotal}→${progress.adaptiveDirectivesActiveTotal}`);
    }
  }

  const state =
    stagnantStreak >= 2
      ? chalk.red("STUCK")
      : progressing.length > 0
        ? chalk.green("PROGRESSING")
        : chalk.yellow("NOT PROGRESSING");

  console.log(chalk.bold.dim(`\n  ╭ Convergence board · ${state}`));
  console.log(
    chalk.gray(
      `  │ Addressed/coded: packet_closed=${progress.packetClosed} (${deltaLabel(progress.packetClosed, prev?.packetClosed)}) · files_changed=${progress.filesChanged} (${deltaLabel(progress.filesChanged, prev?.filesChanged)}) · committed_changes=${progress.committedChanges} (${deltaLabel(progress.committedChanges, prev?.committedChanges)}) · feedback_addressed=${progress.feedbackAddressed} (${deltaLabel(progress.feedbackAddressed, prev?.feedbackAddressed)}) · gaps_addressed=${progress.gapsAddressed} (${deltaLabel(progress.gapsAddressed, prev?.gapsAddressed)})`,
    ),
  );
  console.log(
    chalk.gray(
      `  │ Remaining: packet_open=${progress.packetOpen} (${deltaLabel(progress.packetOpen, prev?.packetOpen)}) · brief_open=${progress.briefOpen}/${progress.briefTotal} (${deltaLabel(progress.briefOpen, prev?.briefOpen)}) · brief_checked=${progress.briefChecked} (${deltaLabel(progress.briefChecked, prev?.briefChecked)}) · release_blocked_items=${progress.blockedChecklist} · qa_blockers=${progress.qaBlockers}`,
    ),
  );
  console.log(
    chalk.gray(
      `  │ Investor directives: current=${progress.investorDirectives} (${deltaLabel(progress.investorDirectives, prev?.investorDirectives)}) · adaptive_loaded=${progress.adaptiveDirectivesLoaded} · adaptive_active=${progress.adaptiveDirectivesActiveTotal} (${deltaLabel(progress.adaptiveDirectivesActiveTotal, prev?.adaptiveDirectivesActiveTotal)})`,
    ),
  );
  const qaLine =
    qa?.score !== undefined
      ? `recommendation=${qa.recommendation} · score=${qa.score} · blockers=${progress.qaBlockers} · manual_tasks=${progress.qaManualTasks}`
      : "missing";
  console.log(chalk.gray(`  │ QA: ${qaLine}`));
  if (investor) {
    const grades = (investor.investors ?? [])
      .map((i) => `${i.displayName ?? "investor"}=${i.grade ?? "?"}`)
      .join(", ");
    const directives = safeLen(investor.combinedRefinementDirectives);
    console.log(
      chalk.gray(
        `  │ Investor: round=${investor.refinementRound ?? 0} · worst=${investor.worstGrade ?? "?"} · meets_A-=${investor.meetsMinimumGradeA ? "yes" : "no"} · directives=${directives}${grades ? ` · ${grades}` : ""}`,
      ),
    );
  } else {
    console.log(chalk.gray("  │ Investor: missing"));
  }
  if (progress.briefOpen > 0) {
    console.log(
      chalk.gray(
        "  │ Why remaining can persist: the packet is frozen for this cycle, while the broader brief backlog may stay deferred until the next cycle.",
      ),
    );
  }
  if (progress.packetReopened > 0) {
    console.log(chalk.yellow(`  │ Reopened within packet: ${progress.packetReopened}`));
  }
  if (builder?.commit?.sha) {
    console.log(chalk.gray(`  │ Latest builder commit: ${builder.commit.sha.slice(0, 7)}`));
  }
  const blocked = (release?.releaseChecklist ?? [])
    .filter((item) => item.status === "blocked")
    .slice(0, 3);
  if (blocked.length > 0) {
    blocked.forEach((item, idx) => {
      console.log(chalk.gray(`  │ Blocked #${idx + 1}: ${truncateForDisplay(`${item.item} — ${item.notes ?? ""}`, 120)}`));
    });
  }
  if (progressing.length > 0) {
    console.log(chalk.green(`  │ Progressing: ${truncateForDisplay(progressing.join(" · "), 130)}`));
  }
  if (notProgressing.length > 0) {
    console.log(chalk.yellow(`  │ Not progressing: ${truncateForDisplay(notProgressing.join(" · "), 130)}`));
  }
  if (stagnantStreak >= 2) {
    console.log(chalk.red("  │ Stuck: no net closure across key metrics for multiple iterations."));
  }
  console.log(chalk.bold.dim("  ╯"));
}

function buildUnblockGuidance(
  repoPath: string,
  foundryDir: string,
  pipelineQa: PipelineIndependentQa | undefined,
  releaseOutput: ReleaseAgentBrief | undefined,
  builderOutput: BuilderLoopMeta | undefined,
  builderRemainingBlockers: string[],
): UnblockGuidance {
  const sources = [
    ...(pipelineQa?.blockers ?? []),
    ...(pipelineQa?.manualTasks ?? []),
    ...(pipelineQa?.warnings ?? []),
    ...extractBuilderBlockers(builderOutput),
    ...builderRemainingBlockers,
    ...(releaseOutput?.notes ?? []),
    ...((releaseOutput?.releaseChecklist ?? []).map((item) => `${item.item} ${item.notes ?? ""}`)),
  ].join("\n");
  const humanSteps: string[] = [];
  const automatableSteps: string[] = [];

  if (releaseOutput?.status === "awaiting_approval" && releaseOutput.approvalFile) {
    humanSteps.push(
      `Approve this release snapshot interactively: re-run \`foundry ship\` or \`foundry loop\` in a TTY and answer the approval prompt (or manually create ${join(repoPath, releaseOutput.approvalFile)}).`,
    );
  }

  if (/maestro cli .*not available|install maestro cli|manual tool setup: install maestro/i.test(sources)) {
    humanSteps.push('Install Maestro once: curl -Ls "https://get.maestro.mobile.dev" | bash');
    humanSteps.push('Persist PATH once: echo \'export PATH="$HOME/.maestro/bin:$PATH"\' >> ~/.bashrc && echo \'export PATH="$HOME/.maestro/bin:$PATH"\' >> ~/.zshrc');
    humanSteps.push('Activate now: export PATH="$HOME/.maestro/bin:$PATH" && hash -r && maestro --version');
  }

  if (/create or restore maestro flows|flow path .* does not exist/i.test(sources)) {
    humanSteps.push("Create/restore Maestro flows in `.maestro/` and run `maestro test '.maestro'`");
  }

  if (/no bundle url present|ipa .*without (an )?embedded js bundle|built without a js bundle/i.test(sources)) {
    humanSteps.push("Rebuild iOS artifact with embedded JS bundle: `eas build --profile preview --platform ios`");
    humanSteps.push("Re-run smoke on the new build artifact (not a dev client requiring Metro)");
  }

  if (/subscription backend|revenuecat|in-app purchase|iap/i.test(sources)) {
    humanSteps.push("Configure billing backend (RevenueCat/IAP): create products/entitlements and wire API keys in environment");
  }

  if (/notification|reminder|expo-notifications/i.test(sources)) {
    automatableSteps.push("Foundry can install/package code path for notifications; you still need push credentials provisioning");
    humanSteps.push("After code changes, configure push credentials for notifications in Apple/Expo");
  }

  if (/@react-native-community\/netinfo|netinfo/i.test(sources)) {
    automatableSteps.push("Install missing runtime dependency: `npx expo install @react-native-community/netinfo`");
  }

  const briefBlocked = (releaseOutput?.releaseChecklist ?? []).find(
    (item) => item.item.toLowerCase().includes("tracked cursor_brief items") && item.status === "blocked",
  );
  if (briefBlocked) {
    // The "rerun the loop" wording was misleading — `foundry run` is one shot.
    // The thing that actually iterates (Cursor closes brief items between
    // pipeline cycles, then re-runs QA + release + investor_panel) is
    // `foundry loop --cursor-auto --profile investor`.
    automatableSteps.push(
      `Run \`foundry loop --cursor-auto --profile investor\` from ${foundryDir.replace(/\.foundry$/, "")} — Cursor closes the open brief items between pipeline cycles, then re-pitches when the contract converges.`,
    );
    automatableSteps.push(`Tracked items live at ${join(foundryDir, "CURSOR_BRIEF.md")} (mirror: ${join(foundryDir, "OPEN_TRACKED_BRIEF.md")}).`);
    const lines = releaseOutput?.openTrackedBriefLines ?? [];
    if (lines.length > 0) {
      lines.slice(0, 8).forEach((L, i) => automatableSteps.push(`Open brief ${i + 1}: ${L}`));
    }
  }

  return {
    humanSteps: [...new Set(humanSteps)],
    automatableSteps: [...new Set(automatableSteps)],
  };
}

function printUnblockGuidance(g: UnblockGuidance): void {
  if (g.humanSteps.length === 0 && g.automatableSteps.length === 0) return;
  if (g.humanSteps.length > 0) {
    console.log(chalk.bold.yellow("\n  REQUIRES HUMAN ACTION (step-by-step)"));
  }
  g.humanSteps.forEach((step, i) => {
    console.log(chalk.yellow(`  ${i + 1}. ${truncateForDisplay(step, 140)}`));
  });
  if (g.automatableSteps.length > 0) {
    console.log(chalk.bold.cyan("\n  AUTOMATABLE BY FOUNDRY/CURSOR"));
    g.automatableSteps.forEach((step, i) => {
      console.log(chalk.cyan(`  ${i + 1}. ${truncateForDisplay(step, 140)}`));
    });
  }
  console.log("");
}

async function promoteReleaseBranchOrStop(
  repoPath: string,
  manifest: RunManifest,
  foundryConfig: Awaited<ReturnType<typeof loadFoundryConfig>>,
): Promise<boolean> {
  const builder = await readStageJson<BuilderReleaseMeta>(repoPath, manifest, "builder");
  const fallbackBuilder = builder?.branchName
    ? builder
    : { branchName: foundryConfig.project.foundry?.builder_branch };
  const promotion = await promoteApprovedBranch(repoPath, manifest, fallbackBuilder);
  if (promotion.status === "promoted") {
    console.log(chalk.green(`  Release branch promotion: ${promotion.detail}`));
    if (promotion.logPath) console.log(chalk.gray(`  Promotion log: ${promotion.logPath}`));
    return true;
  }
  if (promotion.status === "skipped") {
    console.log(chalk.yellow(`  Release branch promotion skipped: ${promotion.detail}`));
    if (promotion.logPath) console.log(chalk.gray(`  Promotion log: ${promotion.logPath}`));
    return true;
  }
  console.log(chalk.red(`  Release branch promotion failed: ${promotion.detail}`));
  if (promotion.logPath) console.log(chalk.red(`  Promotion log: ${promotion.logPath}`));
  return false;
}

function isYes(input: string): boolean {
  return /^(y|yes)$/i.test(input.trim());
}

function isEasReleaseEligible(foundryConfig: Awaited<ReturnType<typeof loadFoundryConfig>>): boolean {
  const repoType = foundryConfig.project.repo_type.toLowerCase();
  if (/^(web_data_platform|web_app|node|python|enterprise)/i.test(repoType)) return false;
  return true;
}

async function promptReleaseApproval(approvalPath: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(
      chalk.red(
        "\n  Release approval needs an interactive terminal (stdin/stdout TTY). Re-run without piping, or approve manually:",
      ),
    );
    console.log(chalk.gray(`  mkdir -p ${dirname(approvalPath)} && touch ${approvalPath}\n`));
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(chalk.cyan(`  Approve this release snapshot? [y/N]: `));
    if (!isYes(answer)) {
      console.log(chalk.yellow("\n  Release approval declined — stopping here.\n"));
      return false;
    }
    await mkdir(dirname(approvalPath), { recursive: true });
    await writeFile(approvalPath, `${new Date().toISOString()}\n`, "utf8");
    console.log(chalk.green(`\n  Approval recorded: ${approvalPath}\n`));
    return true;
  } finally {
    rl.close();
  }
}

async function promptReleaseActions(
  repoPath: string,
  easSettings: ReturnType<typeof resolveEasBuildSettings>,
  foundryConfig: Awaited<ReturnType<typeof loadFoundryConfig>>,
): Promise<{ buildEas: boolean; submitTestFlight: boolean }> {
  if (!isEasReleaseEligible(foundryConfig)) {
    console.log(chalk.gray("\n  EAS/TestFlight actions skipped: project repo_type is not mobile/Expo."));
    return { buildEas: false, submitTestFlight: false };
  }
  console.log(chalk.bold("\n  Release actions"));
  console.log(
    chalk.gray(
      `  Foundry will only spend an EAS build if you confirm here. Config default is build_on_approval=${String(easSettings.buildOnApproval)} (${easSettings.platform}/${easSettings.profile}).`,
    ),
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const buildAnswer = await rl.question(chalk.cyan("  Run an EAS build now? [y/N]: "));
    const buildEas = isYes(buildAnswer);
    let submitTestFlight = false;
    if (easSettings.platform !== "android") {
      const submitAnswer = await rl.question(
        chalk.cyan("  Submit an iOS build to TestFlight now? [y/N]: "),
      );
      submitTestFlight = isYes(submitAnswer);
    }
    if (!buildEas && !submitTestFlight) {
      console.log(chalk.gray("  No EAS/TestFlight action selected. Release branch promotion can still proceed."));
    }
    return { buildEas, submitTestFlight };
  } finally {
    rl.close();
  }
}

async function logPipelineSnapshot(
  repoPath: string,
  manifest: RunManifest,
  label: string,
  briefOpen?: number,
  cached?: { pipelineQa?: PipelineIndependentQa; release?: ReleaseAgentBrief },
): Promise<void> {
  const snap = await getPipelineSnapshotForConsole(repoPath, manifest, {
    maxBlockers: 25,
    blockerMaxLen: 105,
    briefOpenTotal: briefOpen,
  });
  console.log(chalk.bold.dim(`\n  ╭ ${label} · ${snap.runId}`));
  console.log(chalk.white(`  │ Build: ${snap.buildLine}`));
  if (snap.briefOpenTotal !== undefined) {
    console.log(chalk.gray(`  │ Brief: ${snap.briefOpenTotal} open checklist items (tracked sections)`));
    if (snap.briefOpenTotal > 0) {
      const blines = await sampleUncheckedBriefLines(join(repoPath, ".foundry", "CURSOR_BRIEF.md"), 12);
      blines.forEach((line, i) => {
        console.log(chalk.yellow(`  │   ${i + 1}. ${truncateForDisplay(line, 98)}`));
      });
      if (blines.length === 0 && snap.briefOpenTotal > 0) {
        console.log(chalk.gray("  │   (lines not listed — see .foundry/OPEN_TRACKED_BRIEF.md after release_agent)"));
      }
    }
  }
  if (snap.builderBranch?.startsWith("foundry/")) {
    console.log(
      chalk.yellow(`  │ Builder branch pending merge: ${snap.builderBranch} (fixes do not land on your main branch until merged)`),
    );
  }
  console.log(chalk.bold.dim("  ╯"));
  await logShipGateConsole(repoPath, manifest, cached);
}

function logInnerLoopTargets(
  inner: number,
  maxInner: number,
  openWorkItems: number,
  buildTargetLines: string[],
  pipelineQa: PipelineIndependentQa | undefined,
): void {
  console.log(chalk.bold.cyan(`\n  ▸ Cursor builder inner ${inner}/${maxInner} (then full pipeline + QA)`));
  console.log(chalk.gray(`  Open work-packet items: ${openWorkItems}`));
  const n = buildTargetLines.length;
  console.log(chalk.bold.white(`  Build targets (${n}):`));
  if (n === 0) {
    console.log(chalk.gray("    (none — driving QA blockers, feedback queue, or brief closure only)"));
  } else {
    buildTargetLines.forEach((line, i) => {
      console.log(chalk.white(`    ${i + 1}. ${truncateForDisplay(line, 118)}`));
    });
  }
  const rec = pipelineQa?.recommendation ?? "unknown";
  const score = pipelineQa?.score;
  const lastQa =
    score !== undefined ? `Last pipeline QA: ${rec} · score=${score}` : `Last pipeline QA: ${rec}`;
  console.log(chalk.gray(`  ${lastQa}`));
  console.log(chalk.gray(`  Next pipeline QA will run: ${summarizeCoreQaPlanForConsole(pipelineQa)}`));
  const blockers = pipelineQa?.blockers ?? [];
  if (blockers.length === 0) {
    console.log(chalk.green("  Pipeline QA blockers: none"));
    return;
  }
  console.log(chalk.yellow(`  Pipeline QA blockers (${blockers.length}) — drive these to 0 for ship:`));
  blockers.forEach((b, i) => {
    console.log(chalk.yellow(`    ${i + 1}. ${truncateForDisplay(b, 102)}`));
  });
}

const program = new Command();
const FOUNDRY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const STRICT_RESET_CONSOLIDATE_STAGES = [
  "repo_inventory",
  "current_state_audit",
  "baseline_app_shell",
  "market_gap_analysis",
  "first_principles",
  "flywheel_designer",
  "product_definition",
  "monetization_architect",
  "feedback_agent",
  "grand_wizard",
  "builder",
] as const;

/** `foundry loop --stabilize`: skip upstream scope stages; converge on tests + ship gates. */
const STABILIZE_PHASE1_STAGES = ["builder", "independent_qa", "release_agent"] as const;

program.name("foundry").description("Agentic orchestrator CLI").version("0.0.1");

type FeedbackLedgerItem = {
  id: string;
  type: "bug" | "feature_request" | "complaint" | "praise" | "crash";
  summary: string;
  priority: "high" | "medium" | "low";
  source: string;
  relatedGap?: string;
  relatedAC?: string;
  timestamp?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  status: "open" | "resolved" | "ignored";
  repoActionable: boolean;
  shouldImplement: boolean;
  submitterEmail?: string;
  implementationApproval?: FeedbackImplementationApproval;
  implementationNote?: string;
  presentInLatestCollection: boolean;
};

type FeedbackLedger = {
  updatedAt: string;
  items: FeedbackLedgerItem[];
};

type PipelineFeedbackBrief = {
  ledgerSummary?: {
    totalItems?: number;
    openItems?: number;
    implementNowItems?: number;
  };
  sources?: Array<{ name?: string; itemCount?: number; available?: boolean }>;
};

async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function resolveRepoPath(repo?: string): string {
  return resolve(repo ?? process.cwd());
}

const FOUNDRY_GITIGNORE_ENTRIES = [
  ".foundry/.pipeline-stage-cache.json",
  ".foundry/APPROVAL_REQUIRED.md",
  ".foundry/feedback-ledger.json",
  ".foundry/LATEST_INSTALL.md",
  ".foundry/CURSOR_BRIEF.md",
  ".foundry/BUILD_SPEC.json",
  ".foundry/BUILD_SPEC.md",
  ".foundry/BUILD_SPEC_LEDGER.json",
  ".foundry/INVESTOR_PANEL_STATE.json",
  // Legacy snapshot dir kept here so existing .gitignore files continue to
  // ignore it after we relocate snapshots under .foundry/automation/.
  ".foundry/.pre-cursor-snapshots/",
  ".foundry/CURSOR_BUILDER_REPORT.md",
  ".foundry/CURSOR_QA_REPORT.md",
  ".foundry/automation/",
  ".foundry/out/",
  ".foundry/releases/",
  ".foundry/approvals/",
  ".maestro-debug/",
];

async function ensureFoundryGitignore(repoPath: string): Promise<void> {
  const gitignorePath = join(repoPath, ".gitignore");
  let raw = "";
  try {
    raw = await readFile(gitignorePath, "utf8");
  } catch {
    raw = "";
  }
  const existing = new Set(raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = FOUNDRY_GITIGNORE_ENTRIES.filter((entry) => !existing.has(entry));
  if (missing.length === 0) return;

  const prefix = raw.trim().length > 0 ? `${raw.replace(/\s*$/, "")}\n\n` : "";
  const block = [
    "# Foundry generated files",
    ...missing,
    "",
  ].join("\n");
  await writeFile(gitignorePath, `${prefix}${block}`, "utf8");
}

async function readRepoEnv(repoPath: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const abs of [join(repoPath, ".env"), join(repoPath, ".env.local")]) {
    try {
      const raw = await readFile(abs, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const idx = trimmed.indexOf("=");
        if (idx <= 0) continue;
        const key = trimmed.slice(0, idx).trim();
        let value = trimmed.slice(idx + 1).trim();
        if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        out[key] = value;
      }
    } catch {
      /* ignore missing local env files */
    }
  }
  return out;
}

function feedbackLedgerPath(repoPath: string): string {
  return join(repoPath, ".foundry", "feedback-ledger.json");
}

async function readFeedbackLedger(repoPath: string): Promise<FeedbackLedger> {
  const abs = feedbackLedgerPath(repoPath);
  try {
    const raw = await readFile(abs, "utf8");
    const parsed = JSON.parse(raw) as Partial<FeedbackLedger>;
    if (!Array.isArray(parsed.items)) return { updatedAt: "", items: [] };
    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      items: parsed.items as FeedbackLedgerItem[],
    };
  } catch {
    return { updatedAt: "", items: [] };
  }
}

async function writeFeedbackLedger(repoPath: string, ledger: FeedbackLedger): Promise<void> {
  const abs = feedbackLedgerPath(repoPath);
  await mkdir(join(repoPath, ".foundry"), { recursive: true });
  await writeFile(abs, JSON.stringify(ledger, null, 2), "utf8");
}

function feedbackIdFromSummary(summary: string): string {
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "item";
  return `manual-${Date.now().toString(36)}-${slug}`;
}

function describeFeedbackItem(item: FeedbackLedgerItem): string {
  const approval =
    item.implementationApproval && item.implementationApproval !== "auto"
      ? `approval=${item.implementationApproval}`
      : null;
  return [
    `[${item.status}]`,
    item.shouldImplement ? "implement=yes" : "implement=no",
    approval,
    `${item.type}/${item.priority}`,
    item.id,
    "-",
    truncateForDisplay(item.summary, 110),
  ]
    .filter(Boolean)
    .join(" ");
}

/** Open `shouldImplement` feedback text that is environmental (disk, builder.log, maestro, simctl, eas …). */
function isEnvironmentalFeedbackItem(item: { summary?: string; type?: string }): boolean {
  return isEnvironmentalWorkItem(`${item.summary ?? ""} ${item.type ?? ""}`);
}

/**
 * Count open feedback items Cursor can productively implement. Environmental items
 * (e.g. "automation_log: builder.log — disk at 100% capacity", maestro/simctl/eas) are
 * surfaced to the human but excluded here so they never force a Cursor inner loop that
 * cannot fix them — that pattern just burns the premium builder and risks regressions.
 */
async function countImplementNowFeedback(repoPath: string): Promise<number> {
  const ledger = await readFeedbackLedger(repoPath);
  return ledger.items.filter(
    (item) => item.status === "open" && item.shouldImplement && !isEnvironmentalFeedbackItem(item),
  ).length;
}

async function promptPendingFeedbackApprovals(
  repoPath: string,
  opts: { noWait: boolean; ownerEmails: Set<string> },
): Promise<number> {
  const ledger = await readFeedbackLedger(repoPath);
  let changed = false;

  for (const item of ledger.items) {
    if (
      item.status === "open" &&
      item.source === "supabase" &&
      item.implementationApproval === "postponed"
    ) {
      item.implementationApproval = "pending";
      changed = true;
    }
  }

  const pending = ledger.items.filter(
    (item) =>
      item.status === "open" &&
      item.source === "supabase" &&
      item.implementationApproval === "pending" &&
      !item.shouldImplement,
  );

  if (pending.length === 0) {
    if (changed) {
      ledger.updatedAt = new Date().toISOString();
      await writeFeedbackLedger(repoPath, ledger);
    }
    return countImplementNowFeedback(repoPath);
  }

  const interactive = process.stdin.isTTY && process.stdout.isTTY && !opts.noWait;
  if (!interactive) {
    console.log(
      chalk.yellow(
        `  ${pending.length} external feedback item(s) need approval — non-interactive mode; postponing until a TTY loop run.`,
      ),
    );
    for (const item of pending) {
      if (item.implementationApproval !== "postponed") {
        item.implementationApproval = "postponed";
        changed = true;
      }
    }
    if (changed) {
      ledger.updatedAt = new Date().toISOString();
      await writeFeedbackLedger(repoPath, ledger);
    }
    return countImplementNowFeedback(repoPath);
  }

  console.log(chalk.bold(`\nFeedback approval (${pending.length} item(s) from other accounts)`));
  console.log(chalk.gray("Actions: [a] approve  [n] decline  [p] postpone  [q] quit review\n"));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (let index = 0; index < pending.length; index++) {
      const current = pending[index]!;
      console.log(chalk.bold(`${index + 1}/${pending.length} ${current.id}`));
      console.log(`  from: ${current.submitterEmail ?? "unknown"}`);
      console.log(`  ${current.type}/${current.priority}: ${truncateForDisplay(current.summary, 220)}`);
      const answer = (await rl.question(chalk.cyan("  Action [a/n/p/q]: "))).trim().toLowerCase();
      if (answer === "q") {
        console.log(chalk.yellow("\nStopped feedback approval early.\n"));
        break;
      }

      const idx = ledger.items.findIndex((item) => item.id === current.id);
      if (idx < 0) continue;

      const now = new Date().toISOString();
      if (answer === "a" || answer === "y") {
        ledger.items[idx] = {
          ...ledger.items[idx]!,
          shouldImplement: true,
          repoActionable: true,
          implementationApproval: "approved",
          lastSeenAt: now,
        };
        console.log(chalk.green("  Approved for implementation.\n"));
      } else if (answer === "n") {
        ledger.items[idx] = {
          ...ledger.items[idx]!,
          shouldImplement: false,
          implementationApproval: "declined",
          lastSeenAt: now,
        };
        console.log(chalk.gray("  Declined.\n"));
      } else {
        ledger.items[idx] = {
          ...ledger.items[idx]!,
          shouldImplement: false,
          implementationApproval: "postponed",
          lastSeenAt: now,
        };
        console.log(chalk.gray("  Postponed until next loop.\n"));
      }
      changed = true;
    }
  } finally {
    rl.close();
  }

  if (changed) {
    ledger.updatedAt = new Date().toISOString();
    await writeFeedbackLedger(repoPath, ledger);
  }
  return countImplementNowFeedback(repoPath);
}

async function updateFeedbackItem(
  repoPath: string,
  id: string,
  mutate: (item: FeedbackLedgerItem) => FeedbackLedgerItem,
): Promise<FeedbackLedgerItem | undefined> {
  const ledger = await readFeedbackLedger(repoPath);
  const idx = ledger.items.findIndex((item) => item.id === id);
  if (idx < 0) return undefined;
  ledger.items[idx] = mutate(ledger.items[idx]!);
  ledger.updatedAt = new Date().toISOString();
  await writeFeedbackLedger(repoPath, ledger);
  return ledger.items[idx];
}

async function deleteFeedbackItem(repoPath: string, id: string): Promise<boolean> {
  const ledger = await readFeedbackLedger(repoPath);
  const nextItems = ledger.items.filter((item) => item.id !== id);
  if (nextItems.length === ledger.items.length) return false;
  ledger.items = nextItems;
  ledger.updatedAt = new Date().toISOString();
  await writeFeedbackLedger(repoPath, ledger);
  return true;
}

async function reviewFeedbackLedger(repoPath: string, includeClosed = false): Promise<void> {
  const ledger = await readFeedbackLedger(repoPath);
  const items = ledger.items.filter((item) => {
    if (item.shouldImplement) return false;
    if (includeClosed) return true;
    return item.status === "open";
  });
  if (items.length === 0) {
    console.log(
      chalk.gray(
        includeClosed
          ? "No undecided feedback items to review."
          : "No open undecided feedback items to review.",
      ),
    );
    return;
  }

  console.log(chalk.bold(`Feedback review: ${feedbackLedgerPath(repoPath)}`));
  console.log(chalk.gray("Actions: [y] implement  [Enter]/[n] skip  [d] delete  [q] quit\n"));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let implemented = 0;
  let skipped = 0;
  let deleted = 0;

  try {
    for (let index = 0; index < items.length; index++) {
      const current = items[index]!;
      console.log(chalk.bold(`${index + 1}/${items.length} ${current.id}`));
      console.log(`  status: ${current.status} · implement=${current.shouldImplement ? "yes" : "no"} · ${current.type}/${current.priority}`);
      console.log(`  source: ${current.source}`);
      console.log(`  actionable: ${current.repoActionable ? "yes" : "no"} · latest=${current.presentInLatestCollection ? "yes" : "no"} · seen=${current.seenCount}`);
      console.log(`  summary: ${current.summary}`);
      if (current.implementationNote) console.log(chalk.gray(`  note: ${truncateForDisplay(current.implementationNote, 140)}`));

      const answer = (await rl.question(chalk.cyan("  Action [y/n/d/q]: "))).trim().toLowerCase();
      if (answer === "q") {
        console.log(chalk.yellow("\nStopped feedback review early."));
        break;
      }
      if (answer === "d") {
        const ok = await deleteFeedbackItem(repoPath, current.id);
        if (ok) {
          deleted++;
          console.log(chalk.red("  Deleted from ledger.\n"));
        } else {
          console.log(chalk.red("  Item was not found; skipping.\n"));
        }
        continue;
      }
      if (answer === "y") {
        await updateFeedbackItem(repoPath, current.id, (item) => ({
          ...item,
          status: "open",
          shouldImplement: true,
          repoActionable: true,
          implementationApproval: "approved",
          lastSeenAt: new Date().toISOString(),
        }));
        implemented++;
        console.log(chalk.green("  Marked for implementation.\n"));
        continue;
      }
      skipped++;
      console.log(chalk.gray("  Skipped.\n"));
    }
  } finally {
    rl.close();
  }

  console.log(
    chalk.bold(
      `Review complete: implement=${implemented} · skipped=${skipped} · deleted=${deleted}`,
    ),
  );
}

type FeedbackSyncSummary = {
  runId: string;
  collectedAt?: string;
  totalItems?: number;
  openItems?: number;
  implementNowItems?: number;
  sources?: Array<{ name?: string; itemCount?: number; available?: boolean }>;
};

async function syncFeedbackSources(repoPath: string): Promise<FeedbackSyncSummary> {
  const foundryDir = join(repoPath, ".foundry");
  if (!(await exists(foundryDir))) {
    console.error(chalk.red("Missing .foundry/ in target repo. Run `foundry init` first."));
    process.exit(1);
  }

  const spinner = ora("Syncing feedback sources (ledger + Supabase + logs)...").start();
  let manifest: RunManifest;
  try {
    manifest = await runPipeline({
      repoPath,
      pipelineName: "feedback-sync",
      foundryRoot: FOUNDRY_ROOT,
    });
    spinner.succeed("Feedback sync complete.");
  } catch (err) {
    spinner.fail(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const feedbackOutput = await readStageJson<{
    collectedAt?: string;
    ledgerSummary?: { totalItems?: number; openItems?: number; implementNowItems?: number };
    sources?: Array<{ name?: string; itemCount?: number; available?: boolean }>;
  }>(repoPath, manifest, "feedback_agent");

  const summary: FeedbackSyncSummary = {
    runId: manifest.runId,
    collectedAt: feedbackOutput?.collectedAt,
    totalItems: feedbackOutput?.ledgerSummary?.totalItems,
    openItems: feedbackOutput?.ledgerSummary?.openItems,
    implementNowItems: feedbackOutput?.ledgerSummary?.implementNowItems,
    sources: feedbackOutput?.sources,
  };

  console.log(chalk.gray(`  Run: ${summary.runId}`));
  if (summary.collectedAt) console.log(chalk.gray(`  Collected at: ${summary.collectedAt}`));
  if (summary.totalItems !== undefined) {
    console.log(
      chalk.gray(
        `  Feedback items: total=${summary.totalItems} · open=${summary.openItems ?? 0} · implement-now=${summary.implementNowItems ?? 0}`,
      ),
    );
  }
  if (summary.sources?.length) {
    console.log(chalk.gray("  Sources:"));
    for (const source of summary.sources) {
      console.log(
        chalk.gray(
          `    - ${source.name ?? "unknown"}: count=${source.itemCount ?? 0} · available=${String(source.available ?? false)}`,
        ),
      );
    }
  }
  const supabaseSource = summary.sources?.find((source) => source.name === "supabase");
  if (supabaseSource && !supabaseSource.available) {
    const repoEnv = await readRepoEnv(repoPath);
    const hasUrl = Boolean(
      process.env.SUPABASE_URL ||
      repoEnv.SUPABASE_URL ||
      process.env.EXPO_PUBLIC_SUPABASE_URL ||
      repoEnv.EXPO_PUBLIC_SUPABASE_URL,
    );
    const hasKey = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || repoEnv.SUPABASE_SERVICE_ROLE_KEY);
    if (!hasUrl || !hasKey) {
      const missing = [
        !hasUrl ? "SUPABASE_URL (or EXPO_PUBLIC_SUPABASE_URL)" : null,
        !hasKey ? "SUPABASE_SERVICE_ROLE_KEY" : null,
      ].filter(Boolean);
      console.log(chalk.yellow(`  Supabase feedback unavailable: missing ${missing.join(" and ")} in current env or repo .env/.env.local.`));
    } else {
      console.log(
        chalk.yellow(
          "  Supabase feedback unavailable even though credentials were found. Check service-role access, network, and that `feedback_events` or `feedback` exists.",
        ),
      );
    }
  }

  return summary;
}

async function runApprovedReleaseActions(
  repoPath: string,
  foundryConfig: Awaited<ReturnType<typeof loadFoundryConfig>>,
  manifest: RunManifest,
  releaseStatus: string | undefined,
  releaseActionChoices?: { buildEas: boolean; submitTestFlight: boolean },
): Promise<{ ok: boolean; retryLoop: boolean; failureKey?: string; failureLogPath?: string }> {
  if (!(await promoteReleaseBranchOrStop(repoPath, manifest, foundryConfig))) {
    return { ok: false, retryLoop: false };
  }
  const easSettings = resolveEasBuildSettings(foundryConfig);
  const choices =
    releaseActionChoices !== undefined
      ? releaseActionChoices
      : await promptReleaseActions(repoPath, easSettings, foundryConfig);

  if (choices.buildEas) {
    if (!isEasReleaseEligible(foundryConfig)) {
      console.log(chalk.yellow("  EAS build skipped: project repo_type is not mobile/Expo."));
      return { ok: true, retryLoop: false };
    }
    const easBuild = await maybeRunApprovedEasBuild(repoPath, foundryConfig, manifest, releaseStatus, { force: true });
    if (easBuild.status === "started" || easBuild.status === "already_started") {
      logEasQueuedToConsole(easBuild, false);
    } else if (easBuild.status === "failed") {
      console.log(chalk.red(`  EAS build not started: ${easBuild.detail}`));
      if (easBuild.logPath) console.log(chalk.red(`  Build log: ${easBuild.logPath}`));
      console.log(
        chalk.yellow(
          "  The EAS build log is kept under .foundry/releases/<timestamp>/. A subsequent full loop cycle can backfill Expo logs, ingest the failure into feedback_agent, and queue repo-fixable errors for Cursor automatically.",
        ),
      );
      return {
        ok: false,
        retryLoop: true,
        failureKey: `eas-build:${easBuild.detail}`,
        failureLogPath: easBuild.logPath,
      };
    }
  }

  if (choices.submitTestFlight) {
    const submit = await maybeSubmitLatestToTestFlight(repoPath, foundryConfig, manifest, releaseStatus);
    if (submit.status === "started" || submit.status === "already_started") {
      logTestFlightSubmitToConsole(submit, !choices.buildEas);
    } else if (submit.status === "failed") {
      console.log(chalk.red(`  TestFlight submit not started: ${submit.detail}`));
      if (submit.logPath) console.log(chalk.red(`  Submit log: ${submit.logPath}`));
      console.log(
        chalk.yellow(
          "  The submit log is kept under .foundry/releases/<timestamp>/; the next `foundry loop` will ingest it via feedback_agent and queue repo-fixable errors for Cursor.",
        ),
      );
      return {
        ok: false,
        retryLoop: false,
        failureKey: `testflight-submit:${submit.detail}`,
        failureLogPath: submit.logPath,
      };
    } else {
      console.log(chalk.yellow(`  TestFlight submit skipped: ${submit.detail}`));
    }
  }

  return { ok: true, retryLoop: false };
}

// ── init ────────────────────────────────────────────────────────────

program
  .command("init")
  .option("--repo <path>", "Path to target repo (defaults to current directory)")
  .description("Initialize .foundry config in a repo")
  .action(async ({ repo }: { repo?: string }) => {
    const repoPath = resolveRepoPath(repo);
    const foundryDir = join(repoPath, ".foundry");
    const projectYaml = join(foundryDir, "project.yaml");
    const metricsYaml = join(foundryDir, "metrics.yaml");
    const gatesYaml = join(foundryDir, "gates.yaml");

    await mkdir(foundryDir, { recursive: true });

    if (!(await exists(projectYaml))) {
      await writeFile(
        projectYaml,
        [
          "project_name: your-project",
          'repo_type: "web_app"',
          'north_star: "define a measurable outcome"',
          "constraints:",
          '  - "replace me"',
          "core_differentiators:",
          '  - "replace me"',
          "# Domain block (optional but strongly recommended) — first-class fields for what",
          "# this app actually does. Drives concrete Must Ship lines, brief items, investor pitch,",
          "# and growth experiments. Without it, downstream stages fall back to generic SaaS phrasing.",
          "# domain:",
          "#   name: \"e.g. ingredient-safety scanner\"",
          "#   primary_user_action: \"e.g. Point camera at a packaged food → see stomach-safe verdict in <2s\"",
          "#   key_user_actions:",
          "#     - \"e.g. Scan a barcode/package and get a verdict (safe / caution / avoid)\"",
          "#     - \"e.g. Save personal triggers (lactose, FODMAPs, etc.)\"",
          "#     - \"e.g. Browse history of past verdicts\"",
          "#   vocabulary:",
          "#     noun: \"scan\"        # subject (\"a scan\")",
          "#     verb: \"scan\"        # action (\"to scan a package\")",
          "#     outcome: \"verdict\"  # result (\"safe verdict\")",
          "#     actor: \"shopper\"    # who's using it",
          "#   personas:",
          "#     - \"IBS sufferer figuring out trigger foods on the go\"",
          "#     - \"Lactose-intolerant traveler scanning unfamiliar packages\"",
          "#   success_examples:",
          "#     - \"Greek yogurt → 'Caution: high FODMAP for IBS' in 1.4s\"",
          "#     - \"Almond crackers → 'Safe — no listed triggers' in <2s\"",
          "#   non_goals:",
          "#     - \"Restaurant menu OCR\"",
          "#     - \"Calorie/macro tracking\"",
          "#   primary_metric: \"scan-to-verdict latency p95 < 2s\"",
          "foundry:",
          "  # Unattended loop: optional — relax investor_panel gates and defer ship/EAS prompts until grades hit target.",
          "  # autonomous_investor_convergence:",
          "  #   enabled: true",
          "  #   min_average_grade: \"B+\"",
          "  #   relaxed_investor_gates: true",
          "  #   defer_release_prompt_until_investor_target: true",
          "  # Optional: one git branch for all builder cycles until you merge the release to main.",
          "  # builder_branch: foundry/release",
          "  # Optional: skip investor_panel until QA ships, no blockers, brief complete, work packet closed.",
          "  # investor_panel_when_release_ready: true",
          "cursor_automation:",
          "  enabled: true",
          '  builder_model: "claude-opus-4-8-thinking-high"',
          '  builder_fast_model: "composer-2.5-fast"',
          '  builder_economy_model: "composer-2.5-fast"',
          '  grand_wizard_model: "gpt-5.3-codex"',
          '  grand_wizard_strict_model: "claude-opus-4-8-thinking-high"',
          '  investor_panel_model: "claude-opus-4-8-thinking-high"',
          "  max_inner_loops: 12",
          "  timeout_minutes: 45",
          "qa_automation:",
          "  maestro:",
          "    enabled: false",
          "    required: false",
          '    pipeline_command: "npm run maestro:smoke -w @your/mobile --"',
          '    command: "npm run maestro:smoke -w @your/mobile --"',
          '    flow_path: ".maestro"',
          "    install_if_missing: true",
          "release_automation:",
          "  eas:",
          "    build_on_approval: false",
          '    command: "eas"',
          '    profile: "preview"',
          '    platform: "ios"',
          "    non_interactive: true",
          "",
        ].join("\n"),
        "utf8",
      );
    }

    if (!(await exists(metricsYaml))) {
      await writeFile(
        metricsYaml,
        [
          "metrics:",
          "  - key: d1_retention",
          "    target: 0.25",
          "  - key: scan_success_rate",
          "    target: 0.9",
          "",
        ].join("\n"),
        "utf8",
      );
    }

    if (!(await exists(gatesYaml))) {
      await writeFile(
        gatesYaml,
        [
          "require_human_approval:",
          "  - release_agent.submit_testflight",
          "  - supabase.apply_migrations_prod",
          "  - growth_operator.deploy_paid_ads",
          "",
        ].join("\n"),
        "utf8",
      );
    }

    await ensureFoundryGitignore(repoPath);

    console.log(chalk.green("Initialized .foundry/ in: ") + chalk.cyan(foundryDir));
    console.log(chalk.gray("Next: edit .foundry/project.yaml to match the app."));
  });

// ── stages ──────────────────────────────────────────────────────────

program
  .command("stages")
  .description("List all registered stages")
  .action(() => {
    const names = listRegisteredStageNames();
    console.log(chalk.bold(`Registered stages (${names.length}):\n`));
    for (const name of names) {
      console.log("  " + chalk.cyan(name));
    }
  });

// ── status ──────────────────────────────────────────────────────────

program
  .command("status")
  .option("--repo <path>", "Path to target repo (defaults to current directory)")
  .description("Print work packet, brief counts, and latest pipeline QA/release/investor snapshot (no pipeline run)")
  .action(async ({ repo }: { repo?: string }) => {
    const repoPath = resolveRepoPath(repo);
    const foundryDir = join(repoPath, ".foundry");
    if (!(await exists(foundryDir))) {
      console.error(chalk.red("Missing .foundry/ in target repo. Run `foundry init --repo <path>` first."));
      process.exit(1);
    }
    await printFoundryStatusDashboard(repoPath);
  });

// ── run ─────────────────────────────────────────────────────────────

program
  .command("run")
  .option("--repo <path>", "Path to target repo (defaults to current directory)")
  .option("--pipeline <name>", "Pipeline name (default.yaml)", "default")
  .option("--quiet", "Suppress per-stage log lines; print a compact stage summary + ship gate after the run")
  .option(
    "--investor-refinement",
    "Enable YAML investor_refinement loop (re-run stages up to max_rounds until investor_panel meets A- bar)",
  )
  .description("Run a pipeline against a repo")
  .action(
    async ({
      repo,
      pipeline,
      investorRefinement,
      quiet,
    }: {
      repo?: string;
      pipeline: string;
      investorRefinement?: boolean;
      quiet?: boolean;
    }) => {
      const repoPath = resolveRepoPath(repo);
      const foundryDir = join(repoPath, ".foundry");

      if (!(await exists(foundryDir))) {
        console.error(chalk.red("Missing .foundry/ in target repo. Run `foundry init --repo <path>` first."));
        process.exit(1);
      }

      const foundryRoot = FOUNDRY_ROOT;
      const spinner = ora(quiet ? "Running pipeline (quiet)..." : "Running pipeline...").start();

      let manifest: RunManifest;
      try {
        manifest = await runPipeline({
          repoPath,
          pipelineName: pipeline,
          foundryRoot,
          allowInvestorRefinement: Boolean(investorRefinement),
          quiet: Boolean(quiet),
        });
        spinner.succeed("Pipeline finished.");
      } catch (err) {
        spinner.fail(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      const passed = manifest.stages.filter((s) => s.status === "passed").length;
      const failed = manifest.stages.filter((s) => s.status === "failed").length;
      const skipped = manifest.stages.filter((s) => s.status === "skipped").length;
      const totalMs = manifest.stages.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);

      console.log("");
      console.log(chalk.bold(`Pipeline: ${pipeline}  |  Run: ${manifest.runId}\n`));
      if (quiet) {
        const stageWidth = 25;
        for (const s of manifest.stages) {
          const icon =
            s.status === "passed" ? chalk.green("✓") : s.status === "failed" ? chalk.red("✗") : chalk.gray("○");
          const dur = s.durationMs !== undefined ? chalk.gray(` ${s.durationMs}ms`) : "";
          console.log(`  ${icon} ${s.stage.padEnd(stageWidth)}${dur}`);
        }
        console.log("");
      }
      if (manifest.status === "passed") {
        console.log(chalk.green.bold(`Pipeline passed`) + chalk.gray(` — ${passed} stages in ${totalMs}ms`));
      } else {
        console.log(
          chalk.red.bold(`Pipeline failed`) +
            chalk.gray(` — ${passed} passed, ${failed} failed, ${skipped} skipped`),
        );
      }
      console.log(chalk.gray(`Artifacts: ${join(foundryDir, "out", manifest.runId)}`));

      if (quiet) {
        const pipelineQa = await readStageJson<PipelineIndependentQa>(repoPath, manifest, "independent_qa");
        const releaseOutput = await readStageJson<ReleaseAgentBrief>(repoPath, manifest, "release_agent");
        const builderOutput = await readStageJson<BuilderLoopMeta>(repoPath, manifest, "builder");
        const builderRemainingBlockers = await readBuilderRemainingBlockers(repoPath);
        await logShipGateConsole(repoPath, manifest, { pipelineQa, release: releaseOutput });
        printUnblockGuidance(
          buildUnblockGuidance(repoPath, foundryDir, pipelineQa, releaseOutput, builderOutput, builderRemainingBlockers),
        );
        logReleaseCandidateLine(pipelineQa, releaseOutput);
      }
    },
  );

// ── ship (one-shot release path) ───────────────────────────────────

program
  .command("ship")
  .option("--repo <path>", "Path to target repo (defaults to current directory)")
  .option("--pipeline <name>", "Pipeline name (default.yaml)", "default")
  .option(
    "--no-wait",
    "Non-interactive convenience flag: when stdin/stdout is not a TTY, skip interactive EAS/TestFlight + release approval prompts and exit after printing next steps. In a TTY, prompts still run.",
  )
  .option(
    "--investor-refinement",
    "Enable YAML investor_refinement loop (same as `foundry run --investor-refinement`)",
  )
  .description(
    "Run the full pipeline once, require clean QA (ship + zero blockers), print manual release steps, then prompt interactively for EAS build / TestFlight submit and release approval (when ready)",
  )
  .action(
    async ({
      repo,
      pipeline,
      noWait,
      investorRefinement,
    }: {
      repo?: string;
      pipeline: string;
      noWait?: boolean;
      investorRefinement?: boolean;
    }) => {
      const repoPath = resolveRepoPath(repo);
      const foundryDir = join(repoPath, ".foundry");

      if (!(await exists(foundryDir))) {
        console.error(chalk.red("Missing .foundry/ in target repo. Run `foundry init --repo <path>` first."));
        process.exit(1);
      }

      const foundryRoot = FOUNDRY_ROOT;
      const foundryConfig = await loadFoundryConfig(repoPath);
      const easSettings = resolveEasBuildSettings(foundryConfig);

      console.log(chalk.bold.cyan("\n  Foundry ship (one-shot)"));
      console.log(chalk.gray(`  Repo: ${repoPath}`));
      console.log(chalk.gray(`  Pipeline: ${pipeline}`));
      console.log(chalk.gray(`  No-wait: ${noWait ? "on (no approval poll / no EAS prompts)" : "off"}`));
      console.log(chalk.gray(`  EAS defaults: ${easSettings.platform}/${easSettings.profile} · build_on_approval=${String(easSettings.buildOnApproval)}\n`));

      const spinner = ora("Running full pipeline (includes independent_qa + release_agent)...").start();
      let manifest: RunManifest;
      try {
        manifest = await runPipeline({
          repoPath,
          pipelineName: pipeline,
          foundryRoot,
          allowInvestorRefinement: Boolean(investorRefinement),
        });
        spinner.succeed("Pipeline finished.");
      } catch (err) {
        spinner.fail(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      const pipelineQa = await readStageJson<PipelineIndependentQa>(repoPath, manifest, "independent_qa");
      let releaseOutput = await readStageJson<ReleaseAgentBrief>(repoPath, manifest, "release_agent");
      const builderOutput = await readStageJson<BuilderLoopMeta>(repoPath, manifest, "builder");
      const builderRemainingBlockers = await readBuilderRemainingBlockers(repoPath);

      // Grand Wizard regenerates BUILD_SPEC tasks with fresh IDs every run, but the
      // ledger records completions under the prior run's IDs. Without reconciling,
      // already-shipped work shows up as perpetually "open" tracked brief items and
      // blocks the release gate forever (release_agent => blocked_pre_release). The
      // loop path already does this; ship must too, or `foundry ship` can never clear
      // a brief whose code is committed under different task IDs. Reconcile by matching
      // committed product files in recent git history to the new tasks' anchor files.
      const shipLedgerReconcile = await reconcileBuildSpecLedgerFromGitHistory(repoPath, manifest.runId);
      if (shipLedgerReconcile.newlyCompleted.length > 0) {
        console.log(
          chalk.green(
            `  BUILD_SPEC_LEDGER: reconciled ${shipLedgerReconcile.newlyCompleted.length} task(s) from git history — ${shipLedgerReconcile.newlyCompleted.join(", ")}`,
          ),
        );
        try {
          const rescan = await runPipeline({
            repoPath,
            pipelineName: pipeline,
            foundryRoot,
            quiet: true,
            stagesOverride: ["release_agent"],
            disableStageReuse: true,
          });
          const rescanned = await readStageJson<ReleaseAgentBrief>(repoPath, rescan, "release_agent");
          if (rescanned) {
            releaseOutput = rescanned;
            console.log(chalk.gray("  release_agent: re-scanned ship gate after ledger reconcile."));
          }
        } catch (err) {
          console.log(
            chalk.yellow(
              `  release_agent re-scan after ledger reconcile failed (${err instanceof Error ? err.message : String(err)}); using pre-reconcile ship gate.`,
            ),
          );
        }
      }

      await logShipGateConsole(repoPath, manifest, { pipelineQa, release: releaseOutput });
      printUnblockGuidance(
        buildUnblockGuidance(repoPath, foundryDir, pipelineQa, releaseOutput, builderOutput, builderRemainingBlockers),
      );

      const qaRec = pipelineQa?.recommendation ?? "missing";
      const qaBlockers = pipelineQa?.blockers ?? [];
      if (qaRec !== "ship" || qaBlockers.length > 0) {
        console.log(chalk.red.bold("\n  Ship aborted: pipeline QA is not clean."));
        console.log(
          chalk.red(
            `  independent_qa recommendation=${qaRec}, blockers=${qaBlockers.length}. Fix tests, lint, typecheck, and Maestro (if enabled), then re-run \`foundry ship\`.`,
          ),
        );
        console.log(chalk.gray(`  Artifacts: ${join(foundryDir, "out", manifest.runId)}\n`));
        process.exit(1);
      }

      logReleaseCandidateLine(pipelineQa, releaseOutput);

      const rel = releaseOutput?.status ?? "missing";
      if (rel === "blocked_by_qa" || rel === "blocked_pre_release") {
        console.log(chalk.red.bold("\n  Ship aborted: release_agent pre-release gates are not clear."));
        console.log(
          chalk.red(
            `  release_agent.status=${rel}. Complete the blocked checklist rows (brief, builder branch, etc.) shown above, then re-run \`foundry ship\`.`,
          ),
        );
        console.log(chalk.gray(`  Review: ${join(foundryDir, "APPROVAL_REQUIRED.md")}`));
        console.log(chalk.gray(`  Artifacts: ${join(foundryDir, "out", manifest.runId)}\n`));
        process.exit(1);
      }

      if (rel === "awaiting_approval" && releaseOutput?.approvalFile) {
        const approvalPath = join(repoPath, releaseOutput.approvalFile);
        const easSettings = resolveEasBuildSettings(foundryConfig);
        console.log(chalk.yellow.bold("\n  RELEASE READY — APPROVAL REQUIRED"));
        console.log(chalk.yellow(`  Review: ${join(foundryDir, "APPROVAL_REQUIRED.md")}`));
        let presolvedReleaseChoices: { buildEas: boolean; submitTestFlight: boolean } | undefined;
        if (noWait && (!process.stdin.isTTY || !process.stdout.isTTY)) {
          console.log(
            chalk.gray(
              "\n  --no-wait: skipping interactive approval/EAS prompts (no TTY). Re-run `foundry ship` in an interactive terminal to approve, or run EAS yourself.\n",
            ),
          );
          console.log(chalk.gray(`  Artifacts: ${join(foundryDir, "out", manifest.runId)}\n`));
          process.exit(0);
        }
        if (isEasReleaseEligible(foundryConfig)) {
          console.log(chalk.bold.cyan("\n  Release actions (interactive)"));
          console.log(
            chalk.gray(
              "  Choose EAS/TestFlight now; Foundry runs your choices after you approve below and the builder branch is merged.",
            ),
          );
        }
        presolvedReleaseChoices = await promptReleaseActions(repoPath, easSettings, foundryConfig);
        const approved = await promptReleaseApproval(approvalPath);
        if (!approved) {
          console.log(chalk.gray(`  Artifacts: ${join(foundryDir, "out", manifest.runId)}\n`));
          process.exit(1);
        }
        const result = await runApprovedReleaseActions(
          repoPath,
          foundryConfig,
          manifest,
          "approved",
          presolvedReleaseChoices,
        );
        console.log(chalk.gray(`\n  Artifacts: ${join(foundryDir, "out", manifest.runId)}`));
        process.exit(result.ok ? 0 : 1);
      }

      if (rel === "approved" || rel === "auto_approved") {
        console.log(chalk.green.bold("\n  Release already approved — running promotion / optional EAS actions"));
        const result = await runApprovedReleaseActions(repoPath, foundryConfig, manifest, rel);
        console.log(chalk.gray(`\n  Artifacts: ${join(foundryDir, "out", manifest.runId)}`));
        process.exit(result.ok ? 0 : 1);
      }

      console.log(chalk.yellow(`\n  Release status is '${rel}' — no approval wait or EAS prompt for this state.`));
      console.log(chalk.gray(`  Artifacts: ${join(foundryDir, "out", manifest.runId)}\n`));
      process.exit(0);
    },
  );

// ── feedback ────────────────────────────────────────────────────────

const feedbackProgram = new Command("feedback").description("Manage the durable feedback ledger");

feedbackProgram
  .command("list")
  .option("--repo <path>", "Path to target repo (defaults to current directory)")
  .option("--all", "Show resolved and ignored items too")
  .description("List feedback ledger items")
  .action(async (opts: { repo?: string; all?: boolean }) => {
    const repoPath = resolveRepoPath(opts.repo);
    const ledger = await readFeedbackLedger(repoPath);
    const items = opts.all ? ledger.items : ledger.items.filter((item) => item.status === "open");
    console.log(chalk.bold(`Feedback ledger: ${feedbackLedgerPath(repoPath)}\n`));
    if (items.length === 0) {
      console.log(chalk.gray(opts.all ? "No ledger items." : "No open ledger items."));
      return;
    }
    for (const item of items) {
      const color =
        item.status === "resolved" ? chalk.green : item.status === "ignored" ? chalk.gray : chalk.yellow;
      console.log(color(`  ${describeFeedbackItem(item)}`));
      if (item.implementationNote) console.log(chalk.gray(`    note: ${truncateForDisplay(item.implementationNote, 110)}`));
    }
  });

feedbackProgram
  .command("add")
  .description("Add a feedback item to the durable ledger")
  .option("--repo <path>", "Path to target repo (defaults to current directory)")
  .option("--summary <text>", "Optional short summary (defaults to the positional feedback text)")
  .option("--type <type>", "Feedback type", "feature_request")
  .option("--priority <priority>", "Priority", "medium")
  .option("--implement", "Mark this new item shouldImplement=true")
  .option("--note <text>", "Optional implementation note")
  .argument("[text]", "Feedback text (stored as summary when --summary is omitted)")
  .action(
    async (
      text: string | undefined,
      opts: {
        repo?: string;
        summary?: string;
        type?: string;
        priority?: string;
        implement?: boolean;
        note?: string;
      },
    ) => {
      const repoPath = resolveRepoPath(opts.repo);
      const summary = (opts.summary?.trim() || text?.trim() || "").trim();
      if (!summary) {
        console.error(
          chalk.red("Missing feedback text: pass a quoted message (e.g. `foundry feedback add \"…\"`) or use --summary."),
        );
        process.exit(1);
      }
      const type = opts.type as FeedbackLedgerItem["type"];
      const priority = opts.priority as FeedbackLedgerItem["priority"];
      if (!["bug", "feature_request", "complaint", "praise", "crash"].includes(type)) {
        console.error(chalk.red(`Unsupported feedback type: ${opts.type}`));
        process.exit(1);
      }
      if (!["high", "medium", "low"].includes(priority)) {
        console.error(chalk.red(`Unsupported priority: ${opts.priority}`));
        process.exit(1);
      }

      const ledger = await readFeedbackLedger(repoPath);
      const now = new Date().toISOString();
      const item: FeedbackLedgerItem = {
        id: feedbackIdFromSummary(summary),
        type,
        summary,
        priority,
        source: "manual:cli",
        timestamp: now,
        firstSeenAt: now,
        lastSeenAt: now,
        seenCount: 1,
        status: "open",
        repoActionable: type !== "praise",
        shouldImplement: type !== "praise",
        implementationApproval: "auto",
        implementationNote: opts.note ?? "CLI/manual feedback — auto-approved for implementation.",
        presentInLatestCollection: true,
      };
      ledger.items.unshift(item);
      ledger.updatedAt = now;
      await writeFeedbackLedger(repoPath, ledger);
      console.log(chalk.green(`Added: ${describeFeedbackItem(item)}`));
    },
  );

feedbackProgram
  .command("review")
  .option("--repo <path>", "Path to target repo (defaults to current directory)")
  .option("--all", "Include resolved and ignored items too")
  .option("--no-sync", "Skip refreshing from feedback sources before review")
  .description("Interactively review feedback items and choose what to implement")
  .action(async (opts: { repo?: string; all?: boolean; sync?: boolean }) => {
    const repoPath = resolveRepoPath(opts.repo);
    if (opts.sync !== false) await syncFeedbackSources(repoPath);
    await reviewFeedbackLedger(repoPath, Boolean(opts.all));
  });

feedbackProgram
  .command("sync")
  .option("--repo <path>", "Path to target repo (defaults to current directory)")
  .description("Refresh feedback from Supabase, logs, and other sources into the ledger")
  .action(async (opts: { repo?: string }) => {
    const repoPath = resolveRepoPath(opts.repo);
    await syncFeedbackSources(repoPath);
  });

feedbackProgram
  .command("implement")
  .option("--repo <path>", "Path to target repo (defaults to current directory)")
  .argument("<id>", "Ledger item id")
  .option("--note <text>", "Optional implementation note")
  .description("Mark an open feedback item for implementation")
  .action(async (id: string, opts: { repo?: string; note?: string }) => {
    const repoPath = resolveRepoPath(opts.repo);
    const updated = await updateFeedbackItem(repoPath, id, (item) => ({
      ...item,
      status: item.status === "ignored" ? "open" : item.status,
      shouldImplement: true,
      repoActionable: true,
      implementationApproval: "approved",
      implementationNote: opts.note ?? item.implementationNote,
      lastSeenAt: new Date().toISOString(),
    }));
    if (!updated) {
      console.error(chalk.red(`Feedback item not found: ${id}`));
      process.exit(1);
    }
    console.log(chalk.green(`Updated: ${describeFeedbackItem(updated)}`));
  });

feedbackProgram
  .command("resolve")
  .option("--repo <path>", "Path to target repo (defaults to current directory)")
  .argument("<id>", "Ledger item id")
  .option("--note <text>", "Optional resolution note")
  .description("Mark a feedback item resolved")
  .action(async (id: string, opts: { repo?: string; note?: string }) => {
    const repoPath = resolveRepoPath(opts.repo);
    const updated = await updateFeedbackItem(repoPath, id, (item) => ({
      ...item,
      status: "resolved",
      shouldImplement: false,
      implementationNote: opts.note ?? item.implementationNote,
      lastSeenAt: new Date().toISOString(),
    }));
    if (!updated) {
      console.error(chalk.red(`Feedback item not found: ${id}`));
      process.exit(1);
    }
    console.log(chalk.green(`Resolved: ${describeFeedbackItem(updated)}`));
  });

feedbackProgram
  .command("ignore")
  .option("--repo <path>", "Path to target repo (defaults to current directory)")
  .argument("<id>", "Ledger item id")
  .option("--note <text>", "Optional ignore note")
  .description("Ignore a feedback item")
  .action(async (id: string, opts: { repo?: string; note?: string }) => {
    const repoPath = resolveRepoPath(opts.repo);
    const updated = await updateFeedbackItem(repoPath, id, (item) => ({
      ...item,
      status: "ignored",
      shouldImplement: false,
      implementationNote: opts.note ?? item.implementationNote,
      lastSeenAt: new Date().toISOString(),
    }));
    if (!updated) {
      console.error(chalk.red(`Feedback item not found: ${id}`));
      process.exit(1);
    }
    console.log(chalk.green(`Ignored: ${describeFeedbackItem(updated)}`));
  });

feedbackProgram
  .command("reopen")
  .option("--repo <path>", "Path to target repo (defaults to current directory)")
  .argument("<id>", "Ledger item id")
  .option("--implement", "Also mark shouldImplement=true")
  .option("--note <text>", "Optional note")
  .description("Reopen a resolved/ignored feedback item")
  .action(async (id: string, opts: { repo?: string; implement?: boolean; note?: string }) => {
    const repoPath = resolveRepoPath(opts.repo);
    const updated = await updateFeedbackItem(repoPath, id, (item) => ({
      ...item,
      status: "open",
      shouldImplement: opts.implement ? true : item.shouldImplement,
      implementationNote: opts.note ?? item.implementationNote,
      lastSeenAt: new Date().toISOString(),
    }));
    if (!updated) {
      console.error(chalk.red(`Feedback item not found: ${id}`));
      process.exit(1);
    }
    console.log(chalk.green(`Reopened: ${describeFeedbackItem(updated)}`));
  });

program.addCommand(feedbackProgram);

// ── ledger / convergence ────────────────────────────────────────────
//
// `foundry ledger` inspects/mutates the durable product ledger
// (`.foundry/product-ledger.json`) maintained by the `convergence_contract` stage.
// `foundry convergence` shows the latest contract + open investor objections so
// the user can see at a glance whether the MVP is converged before re-running.

type ProductLedgerStatus =
  | "core_mvp"
  | "evidence_needed"
  | "later_expansion"
  | "do_not_build_yet"
  | "rejected";

type ProductLedgerCliItem = {
  id: string;
  name: string;
  source: string;
  status: ProductLedgerStatus;
  reason: string;
  reentryCondition?: string;
  linkedLoop?: string;
  linkedObjections?: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  refinementRound?: number;
};

type ProductLedgerCliFile = {
  version: number;
  updatedAt: string;
  items: ProductLedgerCliItem[];
};

const PRODUCT_LEDGER_STATUSES: ProductLedgerStatus[] = [
  "core_mvp",
  "evidence_needed",
  "later_expansion",
  "do_not_build_yet",
  "rejected",
];

function productLedgerPath(repoPath: string): string {
  return join(repoPath, ".foundry", "product-ledger.json");
}

async function readProductLedgerCli(repoPath: string): Promise<ProductLedgerCliFile> {
  try {
    const raw = await readFile(productLedgerPath(repoPath), "utf8");
    const parsed = JSON.parse(raw) as ProductLedgerCliFile;
    if (parsed && Array.isArray(parsed.items)) return parsed;
  } catch {
    /* fall through */
  }
  return { version: 1, updatedAt: "", items: [] };
}

async function writeProductLedgerCli(repoPath: string, file: ProductLedgerCliFile): Promise<void> {
  await mkdir(join(repoPath, ".foundry"), { recursive: true });
  await writeFile(productLedgerPath(repoPath), JSON.stringify(file, null, 2), "utf8");
}

// ── Manual convergence resolutions (CLI-side helpers) ─────────────────
// `foundry convergence resolve` writes here; the convergence_contract stage
// reads it on the next run and marks the matching objection `resolved`.

type ManualResolutionsCliFile = {
  version: 1;
  updatedAt: string;
  resolutions: Array<{
    objectionId: string;
    evidence: string;
    resolvedAt: string;
    resolvedBy?: string;
  }>;
};

function manualResolutionsCliPath(repoPath: string): string {
  return join(repoPath, ".foundry", "convergence-resolutions.json");
}

async function readManualResolutionsCli(repoPath: string): Promise<ManualResolutionsCliFile> {
  try {
    const raw = await readFile(manualResolutionsCliPath(repoPath), "utf8");
    const parsed = JSON.parse(raw) as ManualResolutionsCliFile;
    if (parsed && Array.isArray(parsed.resolutions)) return parsed;
  } catch {
    /* fall through */
  }
  return { version: 1, updatedAt: "", resolutions: [] };
}

async function writeManualResolutionsCli(
  repoPath: string,
  file: ManualResolutionsCliFile,
): Promise<void> {
  await mkdir(join(repoPath, ".foundry"), { recursive: true });
  await writeFile(manualResolutionsCliPath(repoPath), `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

function ledgerStatusColor(status: ProductLedgerStatus) {
  switch (status) {
    case "core_mvp":
      return chalk.green;
    case "evidence_needed":
      return chalk.cyan;
    case "later_expansion":
      return chalk.blue;
    case "do_not_build_yet":
      return chalk.yellow;
    case "rejected":
      return chalk.gray;
  }
}

function describeLedgerItem(item: ProductLedgerCliItem): string {
  return `${item.id.padEnd(40)} [${item.status}] ${truncateForDisplay(item.name, 80)}`;
}

const ledgerProgram = new Command("ledger").description(
  "Inspect and update `.foundry/product-ledger.json` (parked features, evidence-gated unlocks)",
);

ledgerProgram
  .command("list")
  .option("--repo <path>", "Path to target repo (defaults to current directory)")
  .option("--status <status>", "Filter by status (core_mvp|evidence_needed|later_expansion|do_not_build_yet|rejected)")
  .description("List product ledger items grouped by status")
  .action(async (opts: { repo?: string; status?: string }) => {
    const repoPath = resolveRepoPath(opts.repo);
    const ledger = await readProductLedgerCli(repoPath);
    if (ledger.items.length === 0) {
      console.log(chalk.gray("Product ledger is empty. Run `foundry run` to populate it."));
      return;
    }
    console.log(chalk.bold(`Product ledger: ${productLedgerPath(repoPath)}`));
    console.log(chalk.gray(`Updated: ${ledger.updatedAt || "—"}\n`));
    const filter = opts.status as ProductLedgerStatus | undefined;
    if (filter && !PRODUCT_LEDGER_STATUSES.includes(filter)) {
      console.error(chalk.red(`Unknown status: ${filter}. Use one of: ${PRODUCT_LEDGER_STATUSES.join(", ")}`));
      process.exit(1);
    }
    for (const status of PRODUCT_LEDGER_STATUSES) {
      if (filter && status !== filter) continue;
      const items = ledger.items.filter((i) => i.status === status);
      if (items.length === 0) continue;
      const color = ledgerStatusColor(status);
      console.log(color.bold(`  ${status} (${items.length})`));
      for (const item of items) {
        console.log(color(`    ${describeLedgerItem(item)}`));
        if (item.reason) console.log(chalk.gray(`      reason: ${truncateForDisplay(item.reason, 110)}`));
        if (item.reentryCondition) {
          console.log(chalk.gray(`      reentry: ${truncateForDisplay(item.reentryCondition, 110)}`));
        }
      }
      console.log("");
    }
  });

ledgerProgram
  .command("park")
  .option("--repo <path>", "Path to target repo (defaults to current directory)")
  .requiredOption("--name <text>", "Feature name to park")
  .option("--reason <text>", "Why this is being parked (default: 'manual park')")
  .option(
    "--status <status>",
    "Park status: do_not_build_yet (default) | later_expansion | evidence_needed | rejected",
    "do_not_build_yet",
  )
  .option("--reentry <text>", "Re-entry condition (when this feature can be revisited)")
  .option("--linked-loop <text>", "Singular loop this is parked relative to")
  .description("Park (do not delete) a feature into the product ledger")
  .action(
    async (opts: {
      repo?: string;
      name: string;
      reason?: string;
      status?: string;
      reentry?: string;
      linkedLoop?: string;
    }) => {
      const repoPath = resolveRepoPath(opts.repo);
      const status = (opts.status ?? "do_not_build_yet") as ProductLedgerStatus;
      if (!PRODUCT_LEDGER_STATUSES.includes(status) || status === "core_mvp") {
        console.error(
          chalk.red(
            `--status must be one of: do_not_build_yet | later_expansion | evidence_needed | rejected (got ${opts.status}).`,
          ),
        );
        process.exit(1);
      }
      const ledger = await readProductLedgerCli(repoPath);
      const id =
        opts.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 80) || "item";
      const now = new Date().toISOString();
      const existing = ledger.items.find((i) => i.id === id);
      const next: ProductLedgerCliItem = existing
        ? {
            ...existing,
            name: opts.name,
            status,
            reason: opts.reason ?? existing.reason,
            reentryCondition: opts.reentry ?? existing.reentryCondition,
            linkedLoop: opts.linkedLoop ?? existing.linkedLoop,
            lastSeenAt: now,
          }
        : {
            id,
            name: opts.name,
            source: "manual",
            status,
            reason: opts.reason ?? "Manually parked via `foundry ledger park`.",
            reentryCondition: opts.reentry,
            linkedLoop: opts.linkedLoop,
            linkedObjections: [],
            firstSeenAt: now,
            lastSeenAt: now,
            refinementRound: 0,
          };
      const items = [next, ...ledger.items.filter((i) => i.id !== id)];
      await writeProductLedgerCli(repoPath, { version: 1, updatedAt: now, items });
      const color = ledgerStatusColor(status);
      console.log(color(`Parked: ${describeLedgerItem(next)}`));
    },
  );

ledgerProgram
  .command("promote")
  .option("--repo <path>", "Path to target repo (defaults to current directory)")
  .argument("<id>", "Ledger item id (slug)")
  .option(
    "--status <status>",
    "Promote to: core_mvp | evidence_needed | later_expansion | do_not_build_yet | rejected",
    "core_mvp",
  )
  .option("--note <text>", "Optional reason for the promotion (replaces existing reason)")
  .description("Move a ledger item to a different status (e.g. promote to `core_mvp` once an evidence gate is met)")
  .action(async (id: string, opts: { repo?: string; status?: string; note?: string }) => {
    const repoPath = resolveRepoPath(opts.repo);
    const status = (opts.status ?? "core_mvp") as ProductLedgerStatus;
    if (!PRODUCT_LEDGER_STATUSES.includes(status)) {
      console.error(chalk.red(`--status must be one of: ${PRODUCT_LEDGER_STATUSES.join(", ")}`));
      process.exit(1);
    }
    const ledger = await readProductLedgerCli(repoPath);
    const existing = ledger.items.find((i) => i.id === id);
    if (!existing) {
      console.error(chalk.red(`Ledger item not found: ${id}`));
      process.exit(1);
    }
    const now = new Date().toISOString();
    const updated: ProductLedgerCliItem = {
      ...existing,
      status,
      reason: opts.note ?? existing.reason,
      lastSeenAt: now,
    };
    const items = [updated, ...ledger.items.filter((i) => i.id !== id)];
    await writeProductLedgerCli(repoPath, { version: 1, updatedAt: now, items });
    const color = ledgerStatusColor(status);
    console.log(color(`Promoted ${id} → ${status}`));
  });

program.addCommand(ledgerProgram);

const convergenceProgram = new Command("convergence").description(
  "Inspect convergence_contract state (singular loop, MVP boundary, open investor objections)",
);

convergenceProgram
  .command("status")
  .option("--repo <path>", "Path to target repo (defaults to current directory)")
  .description("Print the latest convergence_contract status and open objections")
  .action(async (opts: { repo?: string }) => {
    const repoPath = resolveRepoPath(opts.repo);
    const outRoot = join(repoPath, ".foundry", "out");
    let runDirs: string[];
    try {
      runDirs = await readdir(outRoot);
    } catch {
      console.error(chalk.red("No `.foundry/out` runs yet. Run `foundry run` first."));
      process.exit(1);
    }
    runDirs.sort((a, b) => b.localeCompare(a));
    let contract:
      | {
          productThesis: string;
          targetUser: string;
          singularLoop: { name: string; northStarMetric: { key: string; target: string } };
          mvpBoundary: { mustShip: string[]; mustNotShipYet: string[] };
          evidenceGates: Array<{ id: string; claim: string; threshold: string }>;
          openObjections: Array<{
            id: string;
            objection: string;
            status: string;
            firstSeenRound: number;
            lastSeenRound: number;
            requiredEvidence: string;
          }>;
          convergenceWarnings: string[];
          isConverged: boolean;
          refinementRound: number;
          panelFingerprint?: string;
          autoResolvedEvidence?: Array<{ objectionId: string; evidence: string }>;
        }
      | undefined;
    let foundIn: string | undefined;
    for (const runId of runDirs) {
      const candidates = [
        join(outRoot, runId, "convergence_contract", "output.json"),
      ];
      try {
        const entries = await readdir(join(outRoot, runId));
        for (const e of entries) {
          if (e.endsWith("_convergence_contract")) candidates.push(join(outRoot, runId, e, "output.json"));
        }
      } catch {
        /* no entries */
      }
      for (const candidate of candidates) {
        try {
          const raw = await readFile(candidate, "utf8");
          contract = JSON.parse(raw);
          foundIn = candidate;
          break;
        } catch {
          /* try next */
        }
      }
      if (contract) break;
    }
    if (!contract) {
      console.error(
        chalk.red("No convergence_contract output found. Run a pipeline that includes `convergence_contract`."),
      );
      process.exit(1);
    }
    console.log(chalk.bold(`Convergence contract: ${foundIn}`));
    console.log("");
    console.log(chalk.bold(`  Thesis: ${contract.productThesis}`));
    console.log(chalk.gray(`  Target: ${contract.targetUser}`));
    console.log(chalk.gray(`  Loop: ${contract.singularLoop.name}`));
    console.log(
      chalk.gray(
        `  North-star: ${contract.singularLoop.northStarMetric.key} (target: ${contract.singularLoop.northStarMetric.target})`,
      ),
    );
    console.log("");
    console.log(
      contract.isConverged
        ? chalk.green.bold(`  CONVERGED (round ${contract.refinementRound})`)
        : chalk.yellow.bold(`  NOT YET CONVERGED (round ${contract.refinementRound})`),
    );
    if (contract.convergenceWarnings.length > 0) {
      console.log(chalk.yellow("\n  Convergence warnings:"));
      for (const w of contract.convergenceWarnings) {
        console.log(chalk.yellow(`    - ${w}`));
      }
    }
    console.log(chalk.bold("\n  Must ship (Phase 1):"));
    for (const item of contract.mvpBoundary.mustShip) {
      console.log(`    - ${item}`);
    }
    if (contract.mvpBoundary.mustNotShipYet.length > 0) {
      console.log(chalk.gray("\n  Parked (do_not_build_yet — see `foundry ledger list`):"));
      for (const item of contract.mvpBoundary.mustNotShipYet.slice(0, 8)) {
        console.log(chalk.gray(`    - ${item}`));
      }
      if (contract.mvpBoundary.mustNotShipYet.length > 8) {
        console.log(chalk.gray(`    … +${contract.mvpBoundary.mustNotShipYet.length - 8} more`));
      }
    }
    console.log(chalk.bold("\n  Open investor objections:"));
    if (contract.openObjections.length === 0) {
      console.log(chalk.green("    (none tracked)"));
    } else {
      const unresolved = contract.openObjections.filter(
        (o) => o.status === "open" || o.status === "regressed",
      );
      for (const o of contract.openObjections) {
        const color =
          o.status === "resolved"
            ? chalk.green
            : o.status === "reduced"
              ? chalk.cyan
              : o.status === "regressed"
                ? chalk.red
                : chalk.yellow;
        console.log(color(`    [${o.status}] ${o.id} (r${o.firstSeenRound}→r${o.lastSeenRound})`));
        console.log(chalk.gray(`      ${truncateForDisplay(o.objection, 110)}`));
        console.log(chalk.gray(`      need: ${truncateForDisplay(o.requiredEvidence, 110)}`));
      }
      if (unresolved.length > 0) {
        console.log(
          chalk.gray(
            `\n    To mark a real-evidence objection as resolved (e.g. you shipped a Yuka benchmark):`,
          ),
        );
        console.log(
          chalk.gray(
            `      foundry convergence resolve ${unresolved[0]?.id} --evidence "<url|doc|metric>"`,
          ),
        );
      }
    }
    if (contract.autoResolvedEvidence && contract.autoResolvedEvidence.length > 0) {
      console.log(chalk.bold("\n  Auto-resolved this run:"));
      for (const e of contract.autoResolvedEvidence) {
        console.log(chalk.green(`    ${e.objectionId}`));
        console.log(chalk.gray(`      ${truncateForDisplay(e.evidence, 110)}`));
      }
    }
    if (contract.panelFingerprint !== undefined) {
      console.log(
        chalk.gray(
          `\n  Panel fingerprint: ${contract.panelFingerprint || "(none — no panel ingested yet)"}`,
        ),
      );
    }
    console.log(chalk.bold("\n  Evidence gates:"));
    for (const g of contract.evidenceGates) {
      console.log(`    ${chalk.bold(g.id)}: ${g.claim}`);
      console.log(chalk.gray(`      threshold: ${g.threshold}`));
    }

    // Pending manual resolutions (written by `foundry convergence resolve` since
    // the last pipeline run; will be applied on next `foundry run`).
    const pending = await readManualResolutionsCli(repoPath);
    if (pending.resolutions.length > 0) {
      console.log(chalk.bold("\n  Pending manual resolutions (apply on next `foundry run`):"));
      for (const r of pending.resolutions) {
        console.log(chalk.cyan(`    ${r.objectionId}${r.resolvedBy ? ` (by ${r.resolvedBy})` : ""}`));
        console.log(chalk.gray(`      ${truncateForDisplay(r.evidence, 110)}`));
      }
    }
    console.log("");
  });

convergenceProgram
  .command("resolve <objectionId>")
  .option("--repo <path>", "Path to target repo (defaults to current directory)")
  .option("--evidence <text>", "Concrete evidence proving the objection is addressed (URL, doc, metric)")
  .option("--by <name>", "Who resolved this objection (for audit)")
  .description(
    "Manually mark an investor objection as resolved with evidence. Use for objections the contract cannot prove on its own (benchmarks, retention numbers, etc.). Run `foundry convergence status` to find IDs.",
  )
  .action(
    async (
      objectionId: string,
      opts: { repo?: string; evidence?: string; by?: string },
    ) => {
      const repoPath = resolveRepoPath(opts.repo);
      if (!opts.evidence || opts.evidence.trim().length < 8) {
        console.error(
          chalk.red(
            "Refusing to resolve without concrete evidence. Pass --evidence with a URL, doc, or metric (≥8 chars).",
          ),
        );
        process.exit(1);
      }
      const file = await readManualResolutionsCli(repoPath);
      const now = new Date().toISOString();
      const idx = file.resolutions.findIndex((r) => r.objectionId === objectionId);
      const entry = {
        objectionId,
        evidence: opts.evidence.trim(),
        resolvedAt: now,
        ...(opts.by ? { resolvedBy: opts.by } : {}),
      };
      if (idx >= 0) file.resolutions[idx] = entry;
      else file.resolutions.push(entry);
      file.updatedAt = now;
      await writeManualResolutionsCli(repoPath, file);
      console.log(
        chalk.green(
          `✔ Marked ${objectionId} as resolved. Re-run \`foundry run\` to recompute convergence.`,
        ),
      );
      console.log(chalk.gray(`  evidence: ${entry.evidence}`));
      if (opts.by) console.log(chalk.gray(`  by: ${opts.by}`));
      console.log(
        chalk.gray(
          `  stored at: ${join(repoPath, ".foundry", "convergence-resolutions.json")} (commit this file)`,
        ),
      );
    },
  );

convergenceProgram
  .command("unresolve <objectionId>")
  .option("--repo <path>", "Path to target repo (defaults to current directory)")
  .description("Remove a manual resolution. The objection will be re-evaluated against contract state on next run.")
  .action(async (objectionId: string, opts: { repo?: string }) => {
    const repoPath = resolveRepoPath(opts.repo);
    const file = await readManualResolutionsCli(repoPath);
    const before = file.resolutions.length;
    file.resolutions = file.resolutions.filter((r) => r.objectionId !== objectionId);
    if (file.resolutions.length === before) {
      console.error(chalk.yellow(`No manual resolution found for ${objectionId}.`));
      process.exit(1);
    }
    file.updatedAt = new Date().toISOString();
    await writeManualResolutionsCli(repoPath, file);
    console.log(chalk.green(`✔ Removed manual resolution for ${objectionId}.`));
  });

program.addCommand(convergenceProgram);

// ── loop ────────────────────────────────────────────────────────────

program
  .command("loop")
  .option("--repo <path>", "Path to target repo (defaults to current directory)")
  .option("--pipeline <name>", "Pipeline name (default.yaml)", "default")
  .option("--feedback-interval <minutes>", "Minutes between feedback cycles", "15")
  .option("--max-cycles <n>", "Maximum number of loop cycles (0=unlimited)", "0")
  .option("--cursor-auto", "Run Cursor builder between pipeline cycles (QA is pipeline independent_qa only)")
  .option("--builder-model <name>", "Override Cursor primary builder model")
  .option("--cursor-command <cmd>", "Override Cursor agent CLI command")
  .option("--max-inner-loops <n>", "Max builder inner iterations per cycle (each ends with a full pipeline re-run)")
  .option(
    "--profile <name>",
    "release = optimize for shippable RC (QA + release gates); investor = same + re-run growth_operator & investor_panel after each Cursor pass, and enable investor_refinement on phase-1 full runs",
    "release",
  )
  .option(
    "--no-wait",
    "Skip sleeps: no delay between outer cycles, no delay on failed phase-1 retry; release approval is interactive in a TTY (no touch-file polling), otherwise skipped without a TTY",
  )
  .option(
    "--quick-phase1",
    "Legacy: phase 1 only runs consolidate-through-builder (no QA/release/investor until after Cursor). Default is a full pipeline phase 1.",
  )
  .option(
    "--stabilize",
    "Freeze scope: each outer cycle runs only builder → independent_qa → release_agent (no market/gap/product/monetization/feedback regen). Cursor focuses on QA green (tests/lint/typecheck/Maestro) first; brief backlog in the packet is narrowed until ship+0 blockers. Ignores feedback-queue churn for loop continuation.",
  )
  .option(
    "--reset-spec",
    "Delete .foundry/BUILD_SPEC.{json,md} and .foundry/CURSOR_BRIEF.md before this cycle so Grand Wizard regenerates from scratch with the latest investor directives.",
  )
  .description(
    "Autonomous loop: full pipeline (default) → optional Cursor inner iterations → post-Cursor QA/release (and investor stages in investor profile). Prints RELEASE_CANDIDATE: YES/NO each cycle.",
  )
  .action(async (opts: {
    repo?: string;
    pipeline: string;
    feedbackInterval: string;
    maxCycles: string;
    cursorAuto?: boolean;
    builderModel?: string;
    cursorCommand?: string;
    maxInnerLoops?: string;
    profile?: string;
    /** Commander maps `--no-wait` to `wait: false` (default `wait: true`). */
    wait?: boolean;
    quickPhase1?: boolean;
    stabilize?: boolean;
    resetSpec?: boolean;
  }) => {
    const repoPath = resolveRepoPath(opts.repo);
    const foundryDir = join(repoPath, ".foundry");
    const feedbackIntervalMs = parseInt(opts.feedbackInterval, 10) * 60 * 1000;
    const maxCycles = parseInt(opts.maxCycles, 10);
    const profileRaw = (opts.profile ?? "release").toLowerCase();
    if (profileRaw !== "release" && profileRaw !== "investor") {
      console.error(chalk.red(`Unknown --profile "${opts.profile}" (use release or investor).`));
      process.exit(1);
    }
    if (opts.stabilize && opts.quickPhase1) {
      console.error(chalk.red("Use either --stabilize or --quick-phase1, not both."));
      process.exit(1);
    }
    const stabilize = Boolean(opts.stabilize);
    const loopProfile: LoopProfile = stabilize ? "release" : profileRaw === "investor" ? "investor" : "release";
    const noWait = opts.wait === false;

    if (!(await exists(foundryDir))) {
      console.error(chalk.red("Missing .foundry/ in target repo. Run `foundry init --repo <path>` first."));
      process.exit(1);
    }

    if (opts.resetSpec) {
      const wiped: string[] = [];
      for (const rel of [
        "BUILD_SPEC.json",
        "BUILD_SPEC.md",
        "BUILD_SPEC_LEDGER.json",
        "CURSOR_BRIEF.md",
        "INVESTOR_PANEL_STATE.json",
      ]) {
        const abs = join(foundryDir, rel);
        try {
          await access(abs);
          await import("node:fs/promises").then((m) => m.unlink(abs));
          wiped.push(rel);
        } catch {
          /* ignore missing file */
        }
      }
      if (wiped.length > 0) {
        console.log(chalk.yellow(`  Reset spec: removed ${wiped.join(", ")} — Grand Wizard will regenerate from scratch.`));
        console.log(
          chalk.gray(
            "  BUILD_SPEC_LEDGER will be reconciled from recent git history on main/HEAD after the pipeline runs.",
          ),
        );
      } else {
        console.log(chalk.gray("  Reset spec: nothing to remove."));
      }
    }

    const foundryRoot = FOUNDRY_ROOT;
    const foundryConfig = await loadFoundryConfig(repoPath);
    const foundryBlock = foundryConfig.project.foundry;
    const autonomousInv = resolveAutonomousInvestorConvergenceForRun(foundryBlock, {
      investorLoopDefaults: loopProfile === "investor",
    });
    if (autonomousInv.enabled) {
      console.log(
        chalk.gray(
          `  Autonomous investor convergence: on — mean grade ≥ ${autonomousInv.minAverageGrade}; relaxed investor gates=${String(autonomousInv.relaxedInvestorGates)}; defer release/EAS until investor target AND convergence_contract are clear (${String(autonomousInv.deferReleaseUntilInvestorTarget)})`,
        ),
      );
    }
    if (loopProfile === "investor" && !hasAutonomousInvestorConvergenceKey(foundryBlock) && autonomousInv.enabled) {
      console.log(
        chalk.gray(
          "  No `foundry.autonomous_investor_convergence` in project.yaml — investor profile applies overnight defaults (add the block to customize, or `enabled: false` to disable).",
        ),
      );
    }
    const easSettings = resolveEasBuildSettings(foundryConfig);
    const cursorSettings = resolveCursorAutomationSettings(foundryConfig, {
      enabled: opts.cursorAuto ? true : undefined,
      builderModel: opts.builderModel,
      command: opts.cursorCommand,
      maxInnerLoops: opts.maxInnerLoops ? parseInt(opts.maxInnerLoops, 10) : undefined,
    });
    let cycle = 0;

    console.log(chalk.bold.cyan("\n🔄 Foundry Autonomous Loop"));
    console.log(chalk.gray(`  Repo: ${repoPath}`));
    console.log(chalk.gray(`  Pipeline: ${opts.pipeline}`));
    console.log(chalk.gray(`  Profile: ${loopProfile} (release = RC gates; investor = + investor_panel after Cursor + refinement on phase 1)`));
    if (stabilize) {
      console.log(
        chalk.cyan(
          `  Stabilize: on — phase 1 = ${STABILIZE_PHASE1_STAGES.join(" → ")} only; brief packet narrowed until QA ship + 0 blockers; feedback queue ignored for loop continuation`,
        ),
      );
      if (profileRaw === "investor") {
        console.log(chalk.yellow("  Note: --stabilize overrides investor post-Cursor stages (no investor_panel each inner pass)."));
      }
    }
    console.log(
      chalk.gray(
        `  Phase 1: ${stabilize ? "stabilize (builder → QA → release_agent)" : opts.quickPhase1 ? "quick (builder brief only)" : "full pipeline (default)"}`,
      ),
    );
    console.log(chalk.gray(`  No-wait mode: ${noWait ? "on (no sleeps / no approval polling)" : "off"}`));
    console.log(chalk.gray(`  Feedback interval: ${opts.feedbackInterval}m (ignored when --no-wait)`));
    console.log(chalk.gray(`  Max cycles: ${maxCycles || "unlimited"}\n`));
    const alwaysPromoteToMainBanner =
      foundryConfig.project.foundry?.always_promote_to_main !== false;
    logFoundryLoopDiagram(alwaysPromoteToMainBanner);
    if (cursorSettings.enabled) {
      // Warn early about a known footgun: FOUNDRY_CURSOR_AGENT_CMD pinned to
      // a versioned `cursor-agent` binary that does NOT match the PATH one.
      // The user typically runs `cursor-agent login` (PATH-resolved); a stale
      // env var silently makes Foundry use a different version that may need
      // its own login and produces confusing "not authenticated" errors.
      const envPinnedCursor = process.env.FOUNDRY_CURSOR_AGENT_CMD?.trim();
      if (envPinnedCursor && /\/cursor-agent\/versions\//.test(envPinnedCursor)) {
        try {
          const fs = await import("node:fs/promises");
          await fs.access(envPinnedCursor);
          const cp = await import("node:child_process");
          const which = await new Promise<string>((res) => {
            const child = cp.spawn("bash", ["-lc", "command -v cursor-agent || true"], {
              env: process.env,
              stdio: ["ignore", "pipe", "ignore"],
            });
            let out = "";
            child.stdout.on("data", (b) => { out += b.toString(); });
            child.on("close", () => res(out.trim()));
            child.on("error", () => res(""));
          });
          if (which && which !== envPinnedCursor) {
            console.log(
              chalk.yellow(
                `  WARNING: FOUNDRY_CURSOR_AGENT_CMD is pinned to a versioned binary:\n` +
                  `    ${envPinnedCursor}\n` +
                  `  but \`cursor-agent\` on PATH resolves to a different binary:\n` +
                  `    ${which}\n` +
                  `  If you ran \`cursor-agent login\`, it authenticated the PATH binary, not the pinned one.\n` +
                  `  Recommend: \`unset FOUNDRY_CURSOR_AGENT_CMD\` so Foundry uses the same cursor-agent you logged in to.`,
              ),
            );
          }
        } catch {
          console.log(
            chalk.yellow(
              `  WARNING: FOUNDRY_CURSOR_AGENT_CMD points to a missing binary:\n` +
                `    ${envPinnedCursor}\n` +
                `  Foundry is using \`${cursorSettings.command}\` instead. Remove the stale env var:\n` +
                `    unset FOUNDRY_CURSOR_AGENT_CMD`,
            ),
          );
        }
      }
      const preflight = await preflightCursorCommand(cursorSettings.command, repoPath);
      if (!preflight.ok) {
        console.error(chalk.red(preflight.detail));
        process.exit(1);
      }
      const modelPreflight = await preflightCursorModels(cursorSettings.command, repoPath, [
        cursorSettings.builderModel,
        cursorSettings.builderFastModel,
        cursorSettings.builderEconomyModel,
        cursorSettings.grandWizardModel,
        cursorSettings.grandWizardStrictModel,
        cursorSettings.investorPanelModel,
      ]);
      if (!modelPreflight.ok) {
        console.error(chalk.red(modelPreflight.detail));
        process.exit(1);
      }
      console.log(chalk.gray(`  Cursor builder model (primary): ${cursorSettings.builderModel}`));
      console.log(chalk.gray(`  Cursor builder model (fast): ${cursorSettings.builderFastModel}`));
      console.log(chalk.gray(`  Cursor builder model (economy): ${cursorSettings.builderEconomyModel}`));
      console.log(chalk.gray(`  Grand Wizard model: ${cursorSettings.grandWizardModel} (strict retry: ${cursorSettings.grandWizardStrictModel})`));
      console.log(chalk.gray(`  Investor panel model: ${cursorSettings.investorPanelModel}`));
      console.log(
        chalk.gray(
          cursorSettings.useBuilderEconomyNearRelease
            ? `  Near-release economy: on — uses \`${cursorSettings.builderEconomyModel}\` when QA ship + no code blockers + release is awaiting_approval only (not while brief is still open — set FOUNDRY_USE_BUILDER_ECONOMY=0 to disable)`
            : "  Near-release economy: off (FOUNDRY_USE_BUILDER_ECONOMY=0 or project.yaml use_builder_economy_near_release: false)",
        ),
      );
      console.log(
        chalk.gray(
          "  Pipeline `builder` + `independent_qa` run codegen/shell (no LLM). Only the Cursor builder step uses models.",
        ),
      );
      console.log(
        chalk.gray(
          `  Inner pass 1 = primary (or economy near-release); passes 2+ = fast unless stalled or economy applies.`,
        ),
      );
      console.log(chalk.gray(`  Cursor max inner loops: ${cursorSettings.maxInnerLoops}\n`));
    }
    if (easSettings.buildOnApproval) {
      console.log(chalk.gray(`  EAS build after approval: ${easSettings.platform}/${easSettings.profile}\n`));
    }

    let lastReleaseFailureKey = "";
    let repeatedReleaseFailureCount = 0;
    /**
     * Counts outer cycles in a row whose Cursor builder agent failed with what
     * looks like a network/transport stall (`Connection lost, reconnecting…`).
     * The per-pass watchdog inside `runCursorAgent` already SIGTERMs the agent
     * after `FOUNDRY_CURSOR_TRANSPORT_GRACE_MS` of reconnect-only output, but a
     * single cycle's worth of retries can still burn meaningful quota. After
     * `MAX_CONSECUTIVE_TRANSPORT_FAILURES` cycles in a row die that way, abort
     * the entire `foundry loop` so the user can address connectivity instead
     * of bleeding more credits.
     */
    let consecutiveTransportFailures = 0;
    const MAX_CONSECUTIVE_TRANSPORT_FAILURES = 2;
    /**
     * Count of consecutive outer cycles whose inner loop aborted (no real
     * code changes, only metadata, monetization-only, etc.). Used to break
     * the outer loop after persistent no-progress; previously a single
     * abort would kill autonomous runs even though the user explicitly
     * passed `--no-wait` expecting continued convergence.
     */
    let consecutiveAbortCycles = 0;
    /**
     * Count of consecutive outer cycles that produced no real progress — no
     * Cursor product/QA-artifact files, no feedback addressed, and an identical
     * work-packet / QA signature. Once the build is green but investor
     * convergence is unreachable (e.g. a fixed panel grade keeps the mean below
     * target and there is no new work to raise it), the loop otherwise re-runs
     * the full pipeline forever — burning the ~140s independent_qa stage every
     * cycle for nothing. After `MAX_CONSECUTIVE_NO_PROGRESS_CYCLES` we stop and
     * tell the operator how to give the loop new work.
     */
    let consecutiveNoProgressCycles = 0;
    let lastNoProgressSignature: string | undefined;
    const MAX_CONSECUTIVE_NO_PROGRESS_CYCLES = Number.parseInt(
      process.env.FOUNDRY_MAX_NOPROGRESS_CYCLES ?? "3",
      10,
    );
    /**
     * Signature of the last state actually promoted to main. Used to skip
     * re-promoting an identical green state on a cycle that produced no product
     * progress — otherwise the loop re-merges Foundry artifact churn into main
     * every cycle (the "promote same build 40→43 times" waste) even though
     * nothing about the product changed.
     */
    let lastPromotedSignature: string | undefined;

    while (true) {
      cycle++;
      let abortLoop = false;
      let outerCycleHadTransportFailure = false;
      // Set when cursor-agent rejected the configured model at runtime.
      // No retrying inside the loop will help — the operator must edit
      // project.yaml or set builder_model: "auto" before another run.
      let modelLookupRejected = false;
      let cursorUsageLimitHit = false;
      // Tracks whether *any* inner pass in this outer cycle reached QA-ship.
      // We use this to force `investor_panel` at end-of-cycle (with QA gate
      // bypassed) when a later inner pass regressed QA — otherwise convergence
      // runs go several outer cycles without ever generating investor grades.
      let cycleHadShipState = false;
      // Tracks whether an investor_panel actually ran (not skipped) this cycle.
      let cycleProducedInvestorPanel = false;
      let outerPipelineQa: PipelineIndependentQa | undefined;
      let cycleInnerPasses = 0;
      let cycleCursorProductFileCount = 0;
      let cycleCursorQaArtifactFileCount = 0;
      let endQaReused = false;
      /** Post-Cursor `independent_qa` ran fresh (no cache) and returned ship this cycle. */
      if (maxCycles > 0 && cycle > maxCycles) {
        console.log(chalk.yellow(`\nReached max cycles (${maxCycles}). Stopping.`));
        break;
      }

      console.log(chalk.bold(`\n${"═".repeat(60)}`));
      console.log(chalk.bold.cyan(`  CYCLE ${cycle}`) + chalk.gray(` — ${new Date().toLocaleTimeString()}`));
      console.log(chalk.bold(`${"═".repeat(60)}\n`));

      await backfillExpoBuildViews(repoPath, foundryConfig);

      const phase1Label = stabilize
        ? `Phase 1: Stabilize (${STABILIZE_PHASE1_STAGES.join(" → ")})...`
        : opts.quickPhase1
          ? "Phase 1: Consolidating features and refreshing CURSOR_BRIEF..."
          : loopProfile === "investor"
            ? "Phase 1: Full pipeline (investor refinement enabled)..."
            : "Phase 1: Full pipeline (release candidate path)...";
      const pipelineSpinner = ora(phase1Label).start();

      let manifest: RunManifest;
      try {
        manifest = await runPipeline({
          repoPath,
          pipelineName: opts.pipeline,
          foundryRoot,
          quiet: true,
          allowInvestorRefinement: stabilize ? false : loopProfile === "investor",
          investorLoopAutonomousDefaults: loopProfile === "investor",
          stagesOverride: stabilize
            ? [...STABILIZE_PHASE1_STAGES]
            : opts.quickPhase1
              ? [...STRICT_RESET_CONSOLIDATE_STAGES]
              : undefined,
        });
        pipelineSpinner.succeed("Pipeline complete.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pipelineSpinner.fail(msg);
        if (/ENOSPC|no space left on device/i.test(msg)) {
          console.log(chalk.red.bold("\n  DISK FULL (ENOSPC)"));
          console.log(chalk.red("  Foundry could not write `.foundry/out/*` artifacts for this run."));
          console.log(chalk.red("  Free disk space (or delete old `.foundry/out/*` runs), then re-run the loop.\n"));
          break;
        }
        if (!noWait) {
          console.log(chalk.yellow("Waiting before retry..."));
          await sleep(feedbackIntervalMs);
        }
        continue;
      }

      const printManifest = (m: typeof manifest) => {
        const stages = m.stages;
        const stageWidth = 25;
        for (const s of stages) {
          const icon = s.status === "passed" ? chalk.green("✓")
            : s.status === "failed" ? chalk.red("✗")
            : s.status === "skipped" ? chalk.gray("○")
            : chalk.yellow("…");
          const name = s.stage.padEnd(stageWidth);
          const reuse = s.reused ? chalk.gray(" reused") : "";
          const duration =
            s.durationMs !== undefined ? chalk.gray(`${s.durationMs}ms`) : "";
          console.log(`  ${icon} ${name} ${duration}${reuse}`);
        }
      };

      printManifest(manifest);

      const briefPath = join(foundryDir, "CURSOR_BRIEF.md");
      let releaseOutput = await readStageJson<ReleaseAgentBrief>(repoPath, manifest, "release_agent");
      let builderOutput = await readStageJson<BuilderLoopMeta>(repoPath, manifest, "builder");
      let investorOutput = await readStageJson<InvestorPanelBrief>(repoPath, manifest, "investor_panel");
      let briefCounts = await countCriticalBriefItems(briefPath);
      const ledgerReconcile = await reconcileBuildSpecLedgerFromGitHistory(repoPath, manifest.runId);
      if (ledgerReconcile.newlyCompleted.length > 0) {
        console.log(
          chalk.green(
            `  BUILD_SPEC_LEDGER: reconciled ${ledgerReconcile.newlyCompleted.length} task(s) from git history — ${ledgerReconcile.newlyCompleted.join(", ")}`,
          ),
        );
        briefCounts = await countCriticalBriefItems(briefPath);
        // Re-run release_agent against the reconciled ledger so the ship gate / release checklist
        // reflects the just-closed tasks instead of stale "N open" items from the pre-reconcile scan.
        try {
          const rescan = await runPipeline({
            repoPath,
            pipelineName: opts.pipeline,
            foundryRoot,
            quiet: true,
            stagesOverride: ["release_agent"],
            disableStageReuse: true,
          });
          const rescanned = await readStageJson<ReleaseAgentBrief>(repoPath, rescan, "release_agent");
          if (rescanned) {
            releaseOutput = rescanned;
            console.log(
              chalk.gray("  release_agent: re-scanned ship gate after ledger reconcile."),
            );
          }
        } catch (err) {
          console.log(
            chalk.yellow(
              `  release_agent re-scan after reconcile failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
      }
      let briefMetrics = await readBriefMetrics(briefPath);
      let pipelineQa = await readStageJson<PipelineIndependentQa>(repoPath, manifest, "independent_qa");
      outerPipelineQa = pipelineQa;
      let feedbackOutput = await readStageJson<PipelineFeedbackBrief>(repoPath, manifest, "feedback_agent");
      const feedbackOwnerEmails = resolveFeedbackOwnerEmails(foundryConfig.project.foundry);
      let implementNowFeedbackCount = await promptPendingFeedbackApprovals(repoPath, {
        noWait,
        ownerEmails: feedbackOwnerEmails,
      });
      if (implementNowFeedbackCount > 0) {
        console.log(
          chalk.cyan(
            `  Feedback queue: ${implementNowFeedbackCount} open item(s) approved for implementation (CLI + owner auto-approved).`,
          ),
        );
      }
      const deferredEnvFeedback = (await readFeedbackLedger(repoPath)).items.filter(
        (item) => item.status === "open" && item.shouldImplement && isEnvironmentalFeedbackItem(item),
      );
      if (deferredEnvFeedback.length > 0) {
        console.log(
          chalk.gray(
            `  Feedback queue: ${deferredEnvFeedback.length} environmental item(s) deferred (not Cursor-fixable, e.g. disk/simulator/CI) — surfaced for the human, not driving the builder.`,
          ),
        );
      }
      let builderRemainingBlockers = await readBuilderRemainingBlockers(repoPath);
      let workPacket = await buildWorkPacketForRun({
        repoPath,
        foundryDir,
        runId: manifest.runId,
        pipelineQa,
        builder: builderOutput,
        builderRemainingBlockers,
        stabilize,
      });
      let previousProgress: IterationProgress | undefined;
      let stagnantStreak = 0;

      await logPipelineSnapshot(repoPath, manifest, "After pipeline", briefCounts.total, {
        pipelineQa,
        release: releaseOutput,
      });
      if (builderOutput?.status === "blocked" || builderOutput?.status === "failed") {
        const blockers = extractBuilderBlockers(builderOutput);
        if (blockers.length > 0) {
          console.log(chalk.red(`  Builder blockers (${blockers.length}):`));
          blockers.forEach((b, i) => {
            console.log(chalk.red(`    ${i + 1}. ${truncateForDisplay(b, 120)}`));
          });
        }
      }
      printUnblockGuidance(
        buildUnblockGuidance(repoPath, foundryDir, pipelineQa, releaseOutput, builderOutput, builderRemainingBlockers),
      );
      const buildSpec = await readBuildSpecFromRepo(repoPath);
      if (buildSpec) {
        const slice = buildSpec.slices[0];
        const ledger = await readBuildSpecLedger(repoPath);
        const totalTasks = slice?.tasks.length ?? 0;
        const doneTasks = (slice?.tasks ?? []).filter((t) => t.id in ledger.tasks).length;
        const tasksWithFiles = (slice?.tasks ?? []).filter((t) => t.files.length > 0).length;
        const parents = buildSpec.parentDirectives.length;
        const parentsCovered = buildSpec.parentDirectives.filter((p) => p.childTaskIds.length > 0).length;
        const undecomposed = buildSpec.diagnostics.directivesWithoutTasks.length;
        const stuckCycles = ledger.stuckCycles;
        const droppedParentsCount = Object.keys(ledger.droppedParents ?? {}).length;
        const tone = undecomposed > 0 || tasksWithFiles < totalTasks || stuckCycles > 1 ? chalk.yellow : chalk.gray;
        console.log(
          tone(
            `  Grand Wizard: ${doneTasks}/${totalTasks} task(s) done · ${tasksWithFiles}/${totalTasks} have file refs · parents ${parentsCovered}/${parents} decomposed · stuck=${stuckCycles} · dropped=${droppedParentsCount} · source=${buildSpec.source}`,
          ),
        );
        if (droppedParentsCount > 0) {
          const sampleDropped = Object.values(ledger.droppedParents ?? {})
            .slice(0, 2)
            .map((d) => `"${d.text.slice(0, 60)}${d.text.length > 60 ? "…" : ""}"`)
            .join("; ");
          console.log(
            chalk.gray(
              `  ↳ Parents dropped after ${2}+ undecomposed cycles (use --reset-spec to revive): ${sampleDropped}${droppedParentsCount > 2 ? ` (+${droppedParentsCount - 2} more)` : ""}`,
            ),
          );
        }
        if (undecomposed > 0) {
          console.log(
            chalk.yellow(
              `  ↳ Undecomposed: ${buildSpec.diagnostics.directivesWithoutTasks.slice(0, 3).map((d) => `"${d.slice(0, 70)}"`).join("; ")}`,
            ),
          );
          console.log(
            chalk.gray(
              "    Tip: rerun with `--reset-spec` after refining upstream stages, or add `builder.directives` in project.yaml to anchor.",
            ),
          );
        }
        if (stuckCycles >= 2 && totalTasks > 0 && doneTasks < totalTasks) {
          console.log(
            chalk.red(
              `  ↳ WIZARD STUCK: same upstream fingerprint for ${stuckCycles} cycle(s) with open tasks. Edits aren't covering task.files — Cursor may be editing adjacent files.`,
            ),
          );
        }
      }
      console.log(chalk.gray(`  Work packet: ${workPacketSummaryLine(workPacket)}`));
      const initialProgress = buildIterationProgress(
        briefMetrics,
        builderOutput,
        pipelineQa,
        releaseOutput,
        investorOutput,
        workPacket,
      );
      logIterationProgress(
        initialProgress,
        previousProgress,
        builderOutput,
        pipelineQa,
        releaseOutput,
        investorOutput,
        stagnantStreak,
      );
      previousProgress = initialProgress;

      if (cursorSettings.enabled) {
        let activePacketCounts = packetBriefCounts(workPacket);
        if (pipelineQa?.recommendation === "ship" && implementNowFeedbackCount === 0 && activePacketCounts.total === 0) {
          const parts = [
            "Skipping Cursor builder inner loop: pipeline `independent_qa` recommends ship and no active work-packet or feedback items remain.",
          ];
          console.log(chalk.cyan(`  ${parts.join(" ")}`));
        } else if (implementNowFeedbackCount > 0 && !stabilize) {
          const qaLabel = isQaShipClean(pipelineQa) ? "QA is ship-clean" : `QA is ${pipelineQa?.recommendation ?? "?"}`;
          console.log(
            chalk.cyan(
              `  ${implementNowFeedbackCount} feedback item(s) queued for implementation; continuing Cursor builder (${qaLabel}).`,
            ),
          );
        } else if (pipelineQa?.recommendation === "ship" && activePacketCounts.total > 0) {
          console.log(
            chalk.cyan(
              `  QA is green, but ${activePacketCounts.total} active work-packet item(s) remain open; continuing Cursor builder before release approval.`,
            ),
          );
        }
        if (qaNeedsPremiumCursorBuilder(pipelineQa)) {
          const em = resolveEffectiveInnerLoopMax(cursorSettings.maxInnerLoops, pipelineQa);
          console.log(
            chalk.gray(
              `  QA repair mode: up to ${em} inner pass(es) with primary builder until ship + tests green (FOUNDRY_QA_FIX_MAX_INNER_LOOPS / FOUNDRY_QA_FIX_MAX_INNER_CAP).`,
            ),
          );
        }
        let inner = 0;
        let previousSignature = "";
        let repeatedNoProgressCount = 0;
        const contractGate = await readContractConvergenceGate(repoPath);
        while (
          shouldRunCursorAutomation(
            releaseOutput?.status,
            activePacketCounts,
            pipelineQa?.recommendation,
            implementNowFeedbackCount,
            {
              stabilize,
              autonomousDeferRelease: autonomousInv.deferReleaseUntilInvestorTarget,
              investorTargetMet: investorPanelMetTarget(investorOutput, foundryConfig.project.foundry, loopProfile),
              contractConvergenceMet: contractGate.ok,
            },
          )
        ) {
          if (releaseOutput?.status === "awaiting_approval" && pipelineQa?.recommendation === "ship" && (pipelineQa?.blockers?.length ?? 0) === 0) {
            const invMet = investorPanelMetTarget(investorOutput, foundryConfig.project.foundry, loopProfile);
            const feedbackQueued = implementNowFeedbackCount > 0;
            const actionableOpen = actionableWorkPacketOpenCount(workPacket);
            const stayForConvergence =
              autonomousInv.deferReleaseUntilInvestorTarget &&
              actionableOpen > 0 &&
              (!invMet || feedbackQueued || !contractGate.ok);
            if (stayForConvergence) {
              const why = feedbackQueued
                ? "feedback queued for implementation"
                : !invMet
                  ? "investor mean grade below configured target"
                  : `contract not ready (${contractGate.detail})`;
              console.log(
                chalk.cyan(
                  `\n  Release is awaiting_approval with QA ship + 0 blockers — continuing Cursor (${why}).`,
                ),
              );
            } else {
              if (loopProfile === "investor" && !cycleProducedInvestorPanel && isQaShipClean(pipelineQa)) {
                const ip = await runInvestorPanelForLoop({
                  repoPath,
                  pipelineName: opts.pipeline,
                  foundryRoot,
                  manifest,
                  loopProfile,
                  spinnerLabel: "Running investor_panel (QA ship — product work queue empty)...",
                });
                manifest = ip.manifest;
                investorOutput = ip.investorOutput;
                if (ip.ran) cycleProducedInvestorPanel = true;
              }
              console.log(
                chalk.cyan(
                  actionableOpen === 0
                    ? "\n  QA ship with no actionable product work — skipping Cursor and running investor/convergence steps."
                    : "\n  Release is awaiting_approval with QA ship + 0 blockers — skipping further Cursor passes and going to the approval prompt.",
                ),
              );
              break;
            }
          }
          const effectiveMaxInner = resolveEffectiveInnerLoopMax(cursorSettings.maxInnerLoops, pipelineQa);
          if (inner >= effectiveMaxInner) {
            console.log(
              chalk.yellow(
                `\n  Inner loop cap reached (${effectiveMaxInner} pass(es)) — ${
                  qaNeedsPremiumCursorBuilder(pipelineQa)
                    ? stabilize
                      ? "QA/tests still need work; next outer cycle re-runs builder → independent_qa → release_agent."
                      : "QA/tests still need work; next outer cycle will re-run the full pipeline."
                    : "continuing outer loop on next cycle."
                }`,
              ),
            );
            break;
          }
          // Re-derive activePacketCounts from disk before deciding whether to
          // invoke another Cursor pass. Without this, the value carries over
          // from before the previous pipeline rerun and can lie about open
          // items (e.g. a prior iteration closed all real tasks but we still
          // see counts.total > 0 from stale memory), letting Cursor get
          // dispatched to do "filler" work that breaks QA.
          {
            const freshOpen = stabilize
              ? filterBriefItemsForStabilizePhase(await readOpenBriefItems(briefPath), pipelineQa)
              : await readOpenBriefItems(briefPath);
            const freshChecked = await readCheckedBriefItems(briefPath);
            workPacket = await refreshWorkPacket(repoPath, workPacket, {
              briefOpenItems: freshOpen,
              checkedBriefItems: freshChecked,
              qaCodeBlockers: separateManualAndCodeItems([
                ...(pipelineQa?.blockers ?? []),
                ...(pipelineQa?.manualTasks ?? []),
              ]).code,
              builderCodeBlockers: separateManualAndCodeItems([
                ...extractBuilderBlockers(builderOutput),
                ...builderRemainingBlockers,
              ]).code,
              manualOnly: [
                ...separateManualAndCodeItems([
                  ...(pipelineQa?.blockers ?? []),
                  ...(pipelineQa?.manualTasks ?? []),
                  ...extractBuilderBlockers(builderOutput),
                  ...builderRemainingBlockers,
                ]).manual,
              ],
              codeChanged: false,
            });
            workPacket = await syncBuilderDirectivePacketClosure(repoPath, workPacket);
            activePacketCounts = packetBriefCounts(workPacket);
          }
          // Guard: don't invoke Cursor when there is literally nothing to do.
          // Without this, the inner loop fires off a Cursor pass with
          // "Build targets (0): (none ...)", and Cursor either invents
          // make-work that breaks QA, crashes with exit 1, or trips the
          // abort-on-no-product-changes guard and kills the outer loop.
          // Instead, force a one-off investor_panel run from the current
          // (good) QA-ship state and break out.
          if (
            loopProfile === "investor" &&
            activePacketCounts.total === 0 &&
            implementNowFeedbackCount === 0 &&
            pipelineQa?.recommendation === "ship" &&
            (pipelineQa?.blockers?.length ?? 0) === 0
          ) {
            console.log(
              chalk.cyan(
                "\n  No open work-packet items, no queued feedback, QA is ship — skipping further Cursor passes this cycle and running investor_panel from this state.",
              ),
            );
            const ip = await runInvestorPanelForLoop({
              repoPath,
              pipelineName: opts.pipeline,
              foundryRoot,
              manifest,
              loopProfile,
              spinnerLabel: "Running investor_panel (no Cursor pass needed)...",
            });
            manifest = ip.manifest;
            investorOutput = ip.investorOutput;
            if (ip.ran) cycleProducedInvestorPanel = true;
            break;
          }
          inner++;
          cycleInnerPasses = inner;
          const prePacketOpen = workPacketOpenCount(workPacket);
          const preQaBlockers = pipelineQa?.blockers?.length ?? 0;
          const briefSamples = sampleOpenPacketItems(workPacket, 14);
          logInnerLoopTargets(
            inner,
            effectiveMaxInner,
            activePacketCounts.total,
            briefSamples,
            pipelineQa,
          );
          console.log(
            chalk.gray(
              `  Packet mix: must=${activePacketCounts.mustShip} · should=${activePacketCounts.shouldShip} · gaps=${activePacketCounts.unresolvedGaps} · monetization=${activePacketCounts.monetization} · edge=${activePacketCounts.edgeFunctions} · backlog=${briefCounts.total}`,
            ),
          );
          const focusAbs = join(
            repoPath,
            ".foundry",
            "automation",
            manifest.runId,
            `iteration-${inner}-focus.md`,
          );
          await mkdir(dirname(focusAbs), { recursive: true });
          await writeFile(
            focusAbs,
            formatIterationFocusMarkdown({
              inner,
              maxInner: effectiveMaxInner,
              briefCounts: activePacketCounts,
              briefSamples,
              pipelineQa,
              builderRemainingBlockers,
              stabilize,
              openTrackedBriefSample: await sampleUncheckedBriefLines(briefPath, 14),
            }),
            "utf8",
          );
          console.log(chalk.gray(`  Longer context: ${focusAbs}`));

          const qaCodeBlockerCount = separateManualAndCodeItems(pipelineQa?.blockers ?? []).code.length;
          const builderChoice = chooseBuilderModel(
            cursorSettings,
            activePacketCounts,
            pipelineQa,
            repeatedNoProgressCount,
            inner,
            stabilize ? 0 : implementNowFeedbackCount,
            releaseOutput?.status,
            !investorPanelMetTarget(investorOutput, foundryConfig.project.foundry, loopProfile),
          );
          const builderSpinner = ora(`Cursor builder agent (${builderChoice.model})`).start();
          console.log(chalk.gray(`  Builder model reason: ${builderChoice.reason}`));
          console.log(chalk.gray(`  Live builder log: ${join(repoPath, ".foundry", "automation", manifest.runId, "builder.log")}`));
          await snapshotBuildSpecArtifactsBeforeCursor(repoPath);
          const builderRun = await runBuilderAgent(repoPath, manifest, cursorSettings, builderChoice.model, {
            innerLoopIndex: inner,
          });
          if (builderRun.ok) {
            builderSpinner.succeed("Cursor builder agent completed.");
            console.log(chalk.gray(`  Builder log: ${builderRun.logPath}`));
            const crs = await summarizeCursorBuilderReportMd(repoPath);
            console.log(chalk.cyan(`  Cursor builder report: ${crs}`));
            if (!builderRun.hadCodeChanges) {
              console.log(chalk.red.bold("\n  ABORTING: NO REAL CODE CHANGES"));
              console.log(chalk.red("  Cursor completed but did not modify any non-generated app/backend files."));
              if (builderRun.implementationRetryUsed) {
                console.log(chalk.gray("  (An automatic implementation retry with the primary builder model already ran.)"));
              }
              if (builderRun.statusHint) {
                console.log(chalk.gray(`  Git: ${builderRun.statusHint}`));
              }
              console.log(chalk.red("  Packet items cannot be closed without code. Stopping Foundry to avoid token burn.\n"));
              abortLoop = true;
              break;
            }
            const qaHasMaestroBlocker =
              (pipelineQa?.blockers ?? []).some((b) => /maestro smoke flows failed/i.test(b)) ||
              (pipelineQa?.manualTasks ?? []).some((t) => /\bmaestro\b/i.test(t));
            const qaRepairRelaxFileRules = stabilize || qaNeedsPremiumCursorBuilder(pipelineQa) || qaHasMaestroBlocker;
            const changedProductFiles = builderRun.changedFiles.filter(isProductFeaturePath);
            cycleCursorProductFileCount += changedProductFiles.length;
            cycleCursorQaArtifactFileCount += builderRun.qaArtifactFiles?.length ?? 0;
            if (changedProductFiles.length === 0) {
              const hasTestTouch = builderRun.changedFiles.some(isTestLikePath);
              if (inner >= 2 && hasTestTouch) {
                console.log(
                  chalk.yellow(
                    "\n  Inner refinement: no non-test product-path edits; test-only changes kept (pass 2+ allows QA/test hardening without new feature files).",
                  ),
                );
              } else if (inner === 1 && qaRepairRelaxFileRules && hasTestTouch) {
                console.log(
                  chalk.yellow(
                    "\n  QA repair / stabilize: test-only changes on pass 1 — allowed (e.g. `.maestro/` flows, snapshots, mocks).",
                  ),
                );
              } else if (
                inner === 1 &&
                qaRepairRelaxFileRules &&
                builderRun.changedFiles.length > 0 &&
                builderRun.changedFiles.every(
                  (p) => p.startsWith(".foundry/") && !p.startsWith(".foundry/out/"),
                )
              ) {
                console.log(
                  chalk.yellow(
                    "\n  QA repair / stabilize pass 1: only `.foundry/` files changed (e.g. project.yaml). Continuing once — next pass should change app code, Jest tests under __tests__/*.test.*, or `.maestro/` flows so independent_qa can improve.",
                  ),
                );
              } else {
                console.log(chalk.red.bold("\n  ABORTING: NO PRODUCT FEATURE CHANGES"));
                console.log(
                  chalk.red(
                    "  Cursor changed files, but none counted as product feature paths (app/src code under apps/, packages/, supabase/, or common repo roots like src/, app/, screens/, etc).",
                  ),
                );
                console.log(
                  chalk.red(
                    inner < 2 && !qaRepairRelaxFileRules
                      ? "  Stopping Foundry so the first pass targets real feature work, not metadata-only churn."
                      : "  Stopping Foundry — add product-path changes or test updates under recognized test paths.",
                  ),
                );
                console.log("");
                abortLoop = true;
                break;
              }
            }
            const nonMonetizationFeatureFiles = changedProductFiles.filter((path) => !isMonetizationLikePath(path));
            const nonMonetizationOpenPacketTargets =
              activePacketCounts.mustShip +
              activePacketCounts.shouldShip +
              activePacketCounts.unresolvedGaps +
              activePacketCounts.edgeFunctions +
              activePacketCounts.runtime;
            const monetizationOnlyProductChange =
              changedProductFiles.length > 0 && nonMonetizationFeatureFiles.length === 0;
            if (nonMonetizationOpenPacketTargets > 0 && monetizationOnlyProductChange) {
              console.log(chalk.red.bold("\n  ABORTING: MONETIZATION-ONLY CHANGES"));
              console.log(
                chalk.red(
                  `  Open work packet still lists ${nonMonetizationOpenPacketTargets} non-monetization target(s) (must/QA, should, gaps/builder, edge, runtime), but Cursor only changed monetization/analytics-oriented product files.`,
                ),
              );
              console.log(
                chalk.red(
                  "  Scope should match the packet: touch at least one non-monetization product path while those rows stay open, or close/descope them explicitly.",
                ),
              );
              console.log(
                chalk.gray(
                  "  (When the only open packet rows are monetization, monetization-only edits are allowed — one Cursor pass may still not clear every row; the outer loop can run again.)",
                ),
              );
              console.log("");
              abortLoop = true;
              break;
            }
            const changedTestFiles = builderRun.changedFiles.filter(isTestLikePath);
            if (changedTestFiles.length === 0) {
              if (qaRepairRelaxFileRules) {
                console.log(
                  chalk.gray(
                    "\n  QA repair / stabilize: no test-path edits in this commit — continuing (product, Maestro, or config fixes often clear failing tests without touching __tests__).",
                  ),
                );
              } else if (inner >= 2 && changedProductFiles.length > 0) {
                console.log(
                  chalk.yellow(
                    "\n  Inner refinement: commit has no test-path edits — continuing (pass 2+; product paths already changed this commit).",
                  ),
                );
              } else {
                console.log(chalk.red.bold("\n  ABORTING: NO TEST CHANGES"));
                console.log(
                  chalk.red(
                    "  First inner pass (or no product-path edits this commit): include test updates under __tests__ or *.test.* when you change behavior.",
                  ),
                );
                console.log(
                  chalk.red(
                    "  Pass 2+ skips this rule if non-test product files changed — use pass 1 for test + feature together.\n",
                  ),
                );
                abortLoop = true;
                break;
              }
            }
            const changedForLog = builderRun.changedFiles.filter(
              (p) =>
                !p.startsWith(".maestro-debug/") &&
                !p.startsWith(".foundry/.pre-cursor-snapshots/"),
            );
            console.log(
              chalk.gray(
                `  Code files changed: ${changedForLog.length ? changedForLog.slice(0, 8).join(", ") : "(none)"}`,
              ),
            );
            if (builderRun.diffStats && builderRun.diffStats.length > 0) {
              const productStats = builderRun.diffStats.filter(
                (s) => !s.file.startsWith(".foundry/") && !s.file.startsWith(".maestro-debug/"),
              );
              const totalAdded = productStats.reduce((s, x) => s + x.added, 0);
              const totalRemoved = productStats.reduce((s, x) => s + x.removed, 0);
              const top = [...productStats]
                .sort((a, b) => b.added + b.removed - (a.added + a.removed))
                .slice(0, 4)
                .map((s) => `${s.file} (+${s.added}/-${s.removed})`)
                .join(", ");
              console.log(
                chalk.gray(
                  `  Diff: ${productStats.length} product file(s), +${totalAdded}/-${totalRemoved} LOC${top ? ` · Top: ${top}` : ""}`,
                ),
              );
              await updateBuildSpecLedgerFromPass(repoPath, manifest.runId, builderRun);
            }
            if (builderRun.pushWarning) {
              console.log(
                chalk.yellow(
                  `  Push: committed locally but could not push to origin — ${builderRun.pushWarning.replace(/\n/g, "\n  ")}`,
                ),
              );
            }
          } else {
            builderSpinner.fail(`Cursor builder agent failed (exit ${builderRun.exitCode}).`);
            console.log(chalk.red(`  Builder log: ${builderRun.logPath}`));
            if (builderRun.stderr?.trim()) {
              console.log(chalk.red(`  ${builderRun.stderr.trim().replace(/\n/g, "\n  ")}`));
            }
            const agentBlob = `${builderRun.stderr}\n${builderRun.stdout}`;
            if (/Cannot find module '@anysphere\/file-service/i.test(agentBlob)) {
              console.log(
                chalk.yellow(
                  "\n  Cursor `agent` failed to load a native dependency. Reinstall/update Cursor (CLI bundled with the app), verify CPU arch matches the binary, or set `cursor_automation.command` / FOUNDRY_CURSOR_AGENT_CMD to a working agent path.",
                ),
              );
            }
            // Model-not-found: the runtime API call rejected the configured
            // model even though `agent models` may still list it. Two common
            // causes: (1) cursor-agent stripped a verbosity suffix and looked
            // for a base name that doesn't exist (e.g. `claude-opus-4-7-high`
            // → `claude-opus-4-7`), or (2) the model was deprecated server-
            // side. Print actionable guidance with the actual valid model
            // list and abort cleanly — retrying in another cycle won't help.
            const modelNotFoundMatch = agentBlob.match(/Model name is not valid: "?([^"\n]+)"?/i)
              ?? agentBlob.match(/AI Model Not Found[^\n]*"([^"\n]+)"/i);
            if (modelNotFoundMatch) {
              const rejectedModel = modelNotFoundMatch[1].trim();
              const configuredModel = builderChoice.model;
              console.log(
                chalk.red.bold(
                  `\n  CURSOR REJECTED MODEL: '${rejectedModel}'${rejectedModel !== configuredModel ? ` (resolved from configured '${configuredModel}')` : ""}.`,
                ),
              );
              console.log(
                chalk.yellow(
                  `  Edit .foundry/project.yaml \`cursor_automation\` and set \`builder_model\` / \`builder_fast_model\` to a currently valid model name.\n` +
                    `  Get the live list with:  ${cursorSettings.command} models\n` +
                    `  Common Claude Opus 4.7 aliases: claude-opus-4-7-thinking-high, claude-opus-4-7-thinking-xhigh, claude-opus-4-7-high.\n` +
                    `  Common GPT-5.5 aliases:        gpt-5.5-medium, gpt-5.5-medium-fast, gpt-5.5-high, gpt-5.5-high-fast.\n` +
                    `  Or set builder_model: "auto" to let Cursor pick its current default (recommended fallback).`,
                ),
              );
              // Mark the whole foundry loop as needing operator action — no
              // amount of retrying will change which models cursor-agent
              // accepts. Exit the OUTER loop, not just the inner.
              modelLookupRejected = true;
            }
            // Free / Hobby plan: named `--model` ids are rejected; only Auto works.
            if (isCursorFreePlanAutoOnlyError(agentBlob)) {
              console.log(
                chalk.red.bold(
                  "\n  CURSOR FREE PLAN: named models unavailable — only Auto works on your current plan.",
                ),
              );
              console.log(
                chalk.yellow(
                  "  Set `.foundry/project.yaml` → `cursor_automation.builder_model: \"auto\"` (and fast/economy/qa to \"auto\").\n" +
                    "  Foundry passes `--model auto` explicitly for auto/default; named models retry once with `--model auto` on Free plan.",
                ),
              );
            }
            // Cursor Ultra / plan quota: Opus (or other premium) monthly cap.
            // Retrying with the same model will fail until the billing cycle
            // resets. Point at `auto` so the operator can keep the loop moving.
            if (/hit your usage limit|usage limits will reset/i.test(agentBlob)) {
              const limitModelMatch = agentBlob.match(/usage limit for (\w+)/i);
              const limitModel = limitModelMatch?.[1] ?? "premium";
              cursorUsageLimitHit = true;
              console.log(
                chalk.red.bold(
                  `\n  CURSOR USAGE LIMIT: ${limitModel} quota exhausted for this billing cycle.`,
                ),
              );
              console.log(
                chalk.yellow(
                  "  If API / on-demand usage is exhausted but Auto still has headroom (see Cursor Usage),\n" +
                    "  set `.foundry/project.yaml` → `cursor_automation.builder_model: \"auto\"` (and fast/economy: \"auto\").\n" +
                    "  Foundry passes `--model auto` explicitly so cursor-agent uses Auto instead of named opus/gpt-5.4-* models.\n" +
                    "  Or one run: FOUNDRY_BUILDER_MODEL=auto FOUNDRY_BUILDER_FAST_MODEL=auto foundry loop ...\n" +
                    "  Avoid opus-* and gpt-5.4-* ids until the billing cycle resets (~check Usage page).",
                ),
              );
            }
            // Cross-cycle transport-stall watchdog: if Cursor died because of
            // network / reconnect-only output, the next outer cycle is unlikely
            // to fare better in the short term and just burns credits. We tag
            // the cycle as a transport failure so the outer driver can break
            // the loop after a couple in a row.
            if (isLikelyCursorTransportFailure(agentBlob)) {
              outerCycleHadTransportFailure = true;
              console.log(
                chalk.yellow(
                  "\n  Cursor agent died from transport/network errors (\"Connection lost, reconnecting…\"). " +
                    "If this happens again next cycle, Foundry will exit so you can check Cursor connectivity instead of burning more agent quota.",
                ),
              );
            }
            abortLoop = true;
            break;
          }

          const isLastInnerPass = inner >= effectiveMaxInner;
          const postStages = postCursorStagesForLoop(loopProfile, stabilize, isLastInnerPass);
          const rerunSpinner = ora(
            `Re-running after Cursor: ${postStages.join(" → ")}${
              loopProfile === "investor" && !isLastInnerPass ? " (investor_panel batched to last inner pass)" : ""
            }...`,
          ).start();
          try {
            manifest = await runPipeline({
              repoPath,
              pipelineName: opts.pipeline,
              foundryRoot,
              quiet: true,
              allowInvestorRefinement: false,
              investorLoopAutonomousDefaults: loopProfile === "investor",
              stagesOverride: postStages,
              disableStageReuse: true,
            });
            rerunSpinner.succeed("Post-Cursor pipeline re-run complete.");
            printManifest(manifest);
            endQaReused =
              manifest.stages.find((s) => s.stage === "independent_qa")?.reused === true;
          } catch (err) {
            rerunSpinner.fail(err instanceof Error ? err.message : String(err));
            break;
          }

          pipelineQa = await readStageJson<PipelineIndependentQa>(repoPath, manifest, "independent_qa");

          releaseOutput = await readStageJson<ReleaseAgentBrief>(repoPath, manifest, "release_agent");
          const rerunBuilderOutput = await readStageJson<BuilderLoopMeta>(repoPath, manifest, "builder");
          if (rerunBuilderOutput) {
            builderOutput = rerunBuilderOutput;
          }
          investorOutput = await readStageJson<InvestorPanelBrief>(repoPath, manifest, "investor_panel");
          briefCounts = await countCriticalBriefItems(briefPath);
          briefMetrics = await readBriefMetrics(briefPath);
          // Track cycle-level "ever ship" and "investor panel ran" signals
          // so we can backfill an investor pitch at end-of-cycle even if a
          // later inner pass regressed QA.
          const durableCtx: DurableShipContext = {
            outerQa: outerPipelineQa,
            endQa: pipelineQa,
            endQaReused,
            cursorProductFileCount: cycleCursorProductFileCount,
            cursorQaArtifactFileCount: cycleCursorQaArtifactFileCount,
          };
          if (isDurableLoopShip(durableCtx)) {
            cycleHadShipState = true;
          }
          if (investorOutput && manifestStageRan(manifest, "investor_panel")) {
            cycleProducedInvestorPanel = true;
          }
          feedbackOutput = await readStageJson<PipelineFeedbackBrief>(repoPath, manifest, "feedback_agent");
          implementNowFeedbackCount = await countImplementNowFeedback(repoPath);
          builderRemainingBlockers = await readBuilderRemainingBlockers(repoPath);
          workPacket = await refreshWorkPacket(repoPath, workPacket, {
            briefOpenItems: stabilize
              ? filterBriefItemsForStabilizePhase(await readOpenBriefItems(briefPath), pipelineQa)
              : await readOpenBriefItems(briefPath),
            checkedBriefItems: await readCheckedBriefItems(briefPath),
            qaCodeBlockers: separateManualAndCodeItems([
              ...(pipelineQa?.blockers ?? []),
              ...(pipelineQa?.manualTasks ?? []),
            ]).code,
            builderCodeBlockers: separateManualAndCodeItems([
              ...extractBuilderBlockers(builderOutput),
              ...builderRemainingBlockers,
            ]).code,
            manualOnly: [
              ...separateManualAndCodeItems([
                ...(pipelineQa?.blockers ?? []),
                ...(pipelineQa?.manualTasks ?? []),
                ...extractBuilderBlockers(builderOutput),
                ...builderRemainingBlockers,
              ]).manual,
            ],
            codeChanged: builderRun.hadCodeChanges,
          });
          workPacket = await syncBuilderDirectivePacketClosure(repoPath, workPacket);
          activePacketCounts = packetBriefCounts(workPacket);

          // Stop only on durable ship — post-Cursor green without commits does not count.
          if (
            loopProfile === "investor" &&
            actionableWorkPacketOpenCount(workPacket) === 0 &&
            implementNowFeedbackCount === 0 &&
            isDurableLoopShip(durableCtx)
          ) {
            console.log(
              chalk.cyan(
                "\n  Durable QA ship with no actionable work-packet items — stopping inner loop.",
              ),
            );
            if (!cycleProducedInvestorPanel) {
              const ip = await runInvestorPanelForLoop({
                repoPath,
                pipelineName: opts.pipeline,
                foundryRoot,
                manifest,
                loopProfile,
                spinnerLabel: "Running investor_panel (durable QA ship)...",
              });
              manifest = ip.manifest;
              investorOutput = ip.investorOutput;
              if (ip.ran) cycleProducedInvestorPanel = true;
            }
            break;
          }
          if (
            isQaShipClean(pipelineQa) &&
            !endQaReused &&
            !isDurableLoopShip(durableCtx)
          ) {
            console.log(
              chalk.yellow(
                "\n  Post-Cursor QA is ship but not durable (outer pipeline was red and nothing committed) — continuing inner loop if passes remain.",
              ),
            );
          }

          const postQaBlockers = pipelineQa?.blockers?.length ?? 0;
          await logPipelineSnapshot(repoPath, manifest, "After pipeline (post-Cursor)", briefCounts.total, {
            pipelineQa,
            release: releaseOutput,
          });
          printUnblockGuidance(
            buildUnblockGuidance(repoPath, foundryDir, pipelineQa, releaseOutput, builderOutput, builderRemainingBlockers),
          );
          console.log(chalk.gray(`  Work packet: ${workPacketSummaryLine(workPacket)}`));
          const currentProgress = buildIterationProgress(
            briefMetrics,
            builderOutput,
            pipelineQa,
            releaseOutput,
            investorOutput,
            workPacket,
            builderRun.changedFiles.length,
          );
          if (
            previousProgress &&
            currentProgress.packetOpen >= previousProgress.packetOpen &&
            currentProgress.packetClosed <= previousProgress.packetClosed &&
            currentProgress.qaBlockers >= previousProgress.qaBlockers &&
            currentProgress.blockedChecklist >= previousProgress.blockedChecklist
          ) {
            if (!qaMaestroSmokeOnlyShipGreen(pipelineQa)) {
              stagnantStreak++;
            }
          } else {
            stagnantStreak = 0;
          }
          logIterationProgress(
            currentProgress,
            previousProgress,
            builderOutput,
            pipelineQa,
            releaseOutput,
            investorOutput,
            stagnantStreak,
          );
          previousProgress = currentProgress;
          if (stagnantStreak >= 3) {
            console.log(chalk.red.bold("\n  CONVERGENCE STALLED"));
            console.log(chalk.red("  No net closure across packet/release/QA metrics for multiple iterations."));
            console.log(chalk.red(`  Review unresolved items in: ${join(foundryDir, "WORK_PACKET.md")}`));
            console.log(chalk.red("  Stopping inner loop to avoid churn; the next outer cycle will build a fresh packet.\n"));
            break;
          }
          console.log(
            chalk.gray(
              `  Δ vs start of inner iter: packet ${prePacketOpen}→${workPacketOpenCount(workPacket)} · QA blockers ${preQaBlockers}→${postQaBlockers} · ${pipelineQa?.recommendation ?? "?"}`,
            ),
          );
          const packetClosedThisPass = Math.max(0, prePacketOpen - workPacketOpenCount(workPacket));
          if (inner === 1 && prePacketOpen >= 8 && packetClosedThisPass === 0) {
            console.log(chalk.yellow.bold("\n  WARNING: NO PACKET ITEMS CLOSED ON FIRST PASS"));
            console.log(
              chalk.yellow(
                `  ${packetClosedThisPass}/${prePacketOpen} packet items closed — consider tightening the Cursor prompt or packet scope; continuing inner loop.`,
              ),
            );
          }

          const combinedItems = [
            ...(pipelineQa?.blockers ?? []),
            ...(pipelineQa?.manualTasks ?? []),
            ...(pipelineQa?.warnings ?? []),
            ...builderRemainingBlockers,
          ];
          const separated = separateManualAndCodeItems(combinedItems);
          if (separated.manual.length > 0) {
            console.log(chalk.yellow.bold("\n  MANUAL TASKS DETECTED"));
            for (const item of separated.manual.slice(0, 8)) {
              console.log(chalk.yellow(`  - ${item}`));
            }
            if (separated.code.length === 0 && workPacketOpenCount(workPacket) === 0) {
              console.log(chalk.yellow("  Only manual external tasks remain. Stopping automation to avoid burning more Cursor quota.\n"));
              break;
            }
            if (separated.code.length > 0) {
              console.log(chalk.yellow("  Continuing because repo-fixable code blockers still remain.\n"));
            } else {
              console.log(
                chalk.yellow(
                  "  Manual-only warnings noted; no pipeline QA code blockers — inner loop driven by brief / recommendation state.\n",
                ),
              );
            }
          }

          const signature = JSON.stringify({
            packetOpen: workPacketOpenCount(workPacket),
            pipelineQaRecommendation: pipelineQa?.recommendation ?? "missing",
            qaBlockers: separated.code,
            builderRemainingBlockers: separateManualAndCodeItems(builderRemainingBlockers).code,
          });
          const pipelineQaShip = pipelineQa?.recommendation === "ship";
          if (signature === previousSignature) {
            repeatedNoProgressCount++;
          } else {
            repeatedNoProgressCount = 0;
          }
          previousSignature = signature;
          if (!pipelineQaShip && repeatedNoProgressCount >= 2) {
            console.log(chalk.yellow.bold("\n  AUTOMATION STALLED"));
            console.log(chalk.yellow("  The loop produced the same blocker state three times in a row."));
            console.log(chalk.yellow("  Stopping now to avoid burning more Cursor quota."));
            console.log(chalk.yellow(`  Builder report: ${join(foundryDir, "CURSOR_BUILDER_REPORT.md")}`));
            console.log(
              chalk.yellow(`  Pipeline QA: ${join(foundryDir, "out", manifest.runId)}/*/independent_qa/README.md\n`),
            );
            break;
          }

          if (workPacketOpenCount(workPacket) === 0 && briefCounts.total > 0 && inner < cursorSettings.maxInnerLoops) {
            workPacket = await buildWorkPacketForRun({
              repoPath,
              foundryDir,
              runId: manifest.runId,
              pipelineQa,
              builder: builderOutput,
              builderRemainingBlockers,
              stabilize,
            });
            activePacketCounts = packetBriefCounts(workPacket);
            console.log(chalk.cyan(`  Next packet loaded: ${workPacketSummaryLine(workPacket)}`));
          }
        }
      }
      // Cross-cycle transport-stall guard: track whether this outer cycle was
      // killed by Cursor network errors. After two such cycles in a row we
      // exit the entire loop (regardless of release status) since further
      // attempts only burn quota until connectivity recovers.
      if (outerCycleHadTransportFailure) {
        consecutiveTransportFailures += 1;
        if (consecutiveTransportFailures >= MAX_CONSECUTIVE_TRANSPORT_FAILURES) {
          console.log(
            chalk.red.bold(
              `\n  Aborting foundry loop: ${consecutiveTransportFailures} consecutive cycles ended in Cursor transport failures.`,
            ),
          );
          console.log(
            chalk.yellow(
              "  Check Cursor app/network status, then re-run `foundry loop`. " +
                "Set FOUNDRY_CURSOR_TRANSPORT_GRACE_MS=0 to disable the per-pass watchdog if you'd rather wait it out.",
            ),
          );
          break;
        }
      } else {
        consecutiveTransportFailures = 0;
      }
      // If cursor-agent rejected the configured model, no amount of further
      // cycling can recover — the operator must edit `cursor_automation.builder_model`
      // in project.yaml (or set it to "auto"). Exit immediately so we don't
      // burn another full pipeline run that will fail the same way.
      if (cursorUsageLimitHit) {
        console.log(
          chalk.red.bold(
            "\n  Aborting foundry loop: Cursor usage limit hit (see guidance above).",
          ),
        );
        break;
      }
      if (modelLookupRejected) {
        console.log(
          chalk.red.bold(
            "\n  Aborting foundry loop: cursor-agent rejected the configured builder model.",
          ),
        );
        console.log(
          chalk.yellow(
            "  Update .foundry/project.yaml \`cursor_automation.builder_model\` (and \`builder_fast_model\`) — see model error above.",
          ),
        );
        break;
      }

      // Inner loop abort tracking: the inner loop sets `abortLoop = true` when
      // Cursor commits no real code, only metadata, monetization-only changes,
      // or trips test-change rules. Previously this would break the OUTER
      // loop whenever the release wasn't approved, killing autonomous runs
      // (the user got "Loop finished." after cycle 3 even though they wanted
      // continued investor convergence). Now we only break the outer loop
      // after 3 consecutive abort cycles — that's the real "Cursor is
      // hopelessly stuck" signal. Otherwise we move on to the next cycle so
      // a fresh pipeline run can produce different work.
      if (abortLoop) {
        consecutiveAbortCycles += 1;
      } else {
        consecutiveAbortCycles = 0;
      }
      if (
        abortLoop &&
        consecutiveAbortCycles >= 3 &&
        releaseOutput?.status !== "awaiting_approval" &&
        releaseOutput?.status !== "approved" &&
        releaseOutput?.status !== "auto_approved"
      ) {
        console.log(
          chalk.red.bold(
            `\n  Aborting foundry loop: ${consecutiveAbortCycles} consecutive cycles ended without product code changes.`,
          ),
        );
        console.log(
          chalk.yellow(
            "  Inspect .foundry/CURSOR_BUILDER_REPORT.md and project.yaml — Cursor is repeatedly making no useful changes.",
          ),
        );
        break;
      }
      if (abortLoop) {
        if (releaseOutput?.status === "awaiting_approval" ||
            releaseOutput?.status === "approved" ||
            releaseOutput?.status === "auto_approved") {
          console.log(
            chalk.yellow(
              "\n  Inner loop aborted, but release is ready — continuing to approval prompt.\n",
            ),
          );
        } else {
          console.log(
            chalk.yellow(
              `\n  Inner loop aborted (consecutive=${consecutiveAbortCycles}/3) — continuing to next outer cycle so a fresh pipeline run can produce new work.\n`,
            ),
          );
        }
      }

      // End-of-cycle investor backfill: when QA reached `ship` somewhere
      // inside this outer cycle but the LAST inner pass left QA red (Cursor
      // tends to invent low-value follow-ons that regress tests), we'd
      // normally never produce investor grades — the panel gate refuses to
      // pitch with red QA. Force a one-off investor_panel that bypasses the
      // QA gate so convergence runs actually move. All other gates (builder
      // status, convergence, directives-unaddressed) still apply, so this
      // never re-pitches stale feedback.
      const endCycleCtx: DurableShipContext = {
        outerQa: outerPipelineQa,
        endQa: pipelineQa,
        endQaReused,
        cursorProductFileCount: cycleCursorProductFileCount,
        cursorQaArtifactFileCount: cycleCursorQaArtifactFileCount,
      };
      const cycleDurableShip = isDurableLoopShip(endCycleCtx);

      if (
        loopProfile === "investor" &&
        !cycleProducedInvestorPanel &&
        cycleDurableShip &&
        isQaShipClean(pipelineQa)
      ) {
        const ip = await runInvestorPanelForLoop({
          repoPath,
          pipelineName: opts.pipeline,
          foundryRoot,
          manifest,
          loopProfile,
          forceBypassQa: !isQaShipClean(outerPipelineQa),
          spinnerLabel: isQaShipClean(outerPipelineQa)
            ? "Running investor_panel (durable QA ship at end of cycle)..."
            : "Backfilling investor_panel (inner QA ship — outer pipeline was red)...",
        });
        manifest = ip.manifest;
        investorOutput = ip.investorOutput;
        if (ip.ran) cycleProducedInvestorPanel = true;
      }

      logReleaseCandidateLine(pipelineQa, releaseOutput, {
        durableShip: cycleDurableShip,
        qaReused: endQaReused,
      });
      if (loopProfile === "investor") {
        logInvestorScoreLine(investorOutput);
      }

      // Auto-promote builder branch → main → origin (default on; disable via foundry.always_promote_to_main: false).
      const alwaysPromoteToMain = foundryConfig.project.foundry?.always_promote_to_main !== false;
      let promoteDecision = evaluateAutoPromoteToMain(endCycleCtx);
      let promotedThisCycle = false;

      // Don't re-promote an identical green state on a cycle that produced no
      // product progress. Re-merging Foundry artifact churn into main every
      // cycle is the "promote the same build N times" waste. The first time a
      // state goes green it still promotes (no prior signature to match).
      const cycleHadProductProgress =
        cycleCursorProductFileCount > 0 || cycleCursorQaArtifactFileCount > 0;
      const promoteSignature = [
        pipelineQa?.score ?? -1,
        pipelineQa?.blockers?.length ?? 0,
        workPacketOpenCount(workPacket),
        workPacketClosedCount(workPacket),
      ].join("|");
      if (promoteDecision.ok && !cycleHadProductProgress && promoteSignature === lastPromotedSignature) {
        promoteDecision = {
          ok: false,
          reason:
            "no product progress since the last promotion and the green state is unchanged — skipping redundant re-merge of Foundry artifacts into main",
        };
      }

      if (
        alwaysPromoteToMain &&
        builderOutput?.branchName?.startsWith("foundry/") &&
        shouldRunPrePromotePipelineVerify(endCycleCtx)
      ) {
        const verifySpinner = ora(
          "Pre-promote verify (builder + independent_qa on branch HEAD — simulates next outer cycle)...",
        ).start();
        try {
          await syncCursorBuilderReportFromRecentCommits(repoPath);
          await commitQaGatingFoundryArtifacts(repoPath, manifest.runId);
          const verifyManifest = await runPipeline({
            repoPath,
            pipelineName: opts.pipeline,
            foundryRoot,
            quiet: true,
            allowInvestorRefinement: false,
            stagesOverride: ["builder", "independent_qa"],
            disableStageReuse: true,
          });
          const verifyQa = await readStageJson<PipelineIndependentQa>(
            repoPath,
            verifyManifest,
            "independent_qa",
          );
          if (!isQaShipClean(verifyQa)) {
            const blocker = verifyQa?.blockers?.[0];
            promoteDecision = {
              ok: false,
              reason: `pre-promote builder+QA verify failed — merge would regress on next outer cycle${blocker ? `: ${truncateForDisplay(blocker, 120)}` : ""}`,
            };
            verifySpinner.warn("Pre-promote builder+QA verify failed — skipping merge to main.");
          } else {
            promoteDecision = {
              ok: true,
              reason: "pre-promote builder+QA verify passed (outer was red at cycle start)",
            };
            verifySpinner.succeed("Pre-promote builder+QA verify passed.");
          }
        } catch (err) {
          promoteDecision = {
            ok: false,
            reason: err instanceof Error ? err.message : String(err),
          };
          verifySpinner.fail("Pre-promote builder+QA verify errored.");
        }
      } else if (
        alwaysPromoteToMain &&
        builderOutput?.branchName?.startsWith("foundry/") &&
        promoteDecision.ok &&
        isQaShipClean(outerPipelineQa)
      ) {
        const syncSpinner = ora("Pre-promote: syncing CURSOR_BUILDER_REPORT from branch commits...").start();
        try {
          await syncCursorBuilderReportFromRecentCommits(repoPath);
          await commitQaGatingFoundryArtifacts(repoPath, manifest.runId);
          syncSpinner.succeed("Pre-promote: builder report + QA artifacts synced for merge.");
        } catch (err) {
          promoteDecision = {
            ok: false,
            reason: err instanceof Error ? err.message : String(err),
          };
          syncSpinner.fail("Pre-promote artifact sync failed.");
        }
      }

      if (alwaysPromoteToMain && builderOutput?.branchName?.startsWith("foundry/") && promoteDecision.ok) {
        const promoSpinner = ora("Promoting builder branch to main...").start();
        const promotion = await promoteApprovedBranch(repoPath, manifest, builderOutput);
        if (promotion.status === "promoted") {
          promotedThisCycle = true;
          lastPromotedSignature = promoteSignature;
          promoSpinner.succeed(`Release branch promotion: ${promotion.detail}`);
        } else if (promotion.status === "skipped") {
          promoSpinner.warn(`Release branch promotion skipped: ${promotion.detail}`);
        } else {
          promoSpinner.fail(`Release branch promotion failed: ${promotion.detail}`);
        }
        if (promotion.logPath) console.log(chalk.gray(`  Promotion log: ${promotion.logPath}`));
      } else if (alwaysPromoteToMain && builderOutput?.branchName?.startsWith("foundry/")) {
        console.log(chalk.gray(`  Skipping auto-promote: ${promoteDecision.reason}.`));
      }

      logCycleQaSummary({
        outerQa: outerPipelineQa,
        endQa: pipelineQa,
        endQaReused,
        innerPasses: cycleInnerPasses,
        cursorProductFileCount: cycleCursorProductFileCount,
        cursorQaArtifactFileCount: cycleCursorQaArtifactFileCount,
        durableShip: cycleDurableShip,
        promoted: promotedThisCycle,
        promoteReason: promoteDecision.reason,
        builderBranch: builderOutput?.branchName,
      });

      investorOutput = await readStageJson<InvestorPanelBrief>(repoPath, manifest, "investor_panel");
      const contractAtRelease = await readContractConvergenceGate(repoPath);

      // Track whether this cycle moved anything real. A cycle that wrote no
      // Cursor product/QA-artifact files, addressed no feedback, and left the
      // work-packet / QA signature unchanged is pure spin: nothing fed the
      // downstream stages (incl. investor_panel) anything new to grade.
      const cycleNoProductProgress =
        cycleCursorProductFileCount === 0 &&
        cycleCursorQaArtifactFileCount === 0 &&
        implementNowFeedbackCount === 0;
      const progressSignature = [
        workPacketOpenCount(workPacket),
        workPacketClosedCount(workPacket),
        pipelineQa?.score ?? -1,
        pipelineQa?.blockers?.length ?? 0,
      ].join("|");
      if (!cycleNoProductProgress) {
        consecutiveNoProgressCycles = 0;
      } else if (progressSignature === lastNoProgressSignature) {
        consecutiveNoProgressCycles++;
      } else {
        consecutiveNoProgressCycles = 1;
      }
      lastNoProgressSignature = progressSignature;

      if (releaseOutput?.status === "awaiting_approval") {
        const invMetPost = investorPanelMetTarget(investorOutput, foundryConfig.project.foundry, loopProfile);
        if (autonomousInv.deferReleaseUntilInvestorTarget && (!invMetPost || !contractAtRelease.ok)) {
          const reasons: string[] = [];
          if (!invMetPost) reasons.push(`investor mean < ${autonomousInv.minAverageGrade} (or panel missing/skipped)`);
          if (!contractAtRelease.ok) reasons.push(contractAtRelease.detail);
          console.log(
            chalk.cyan(
              `\n  Autonomous investor convergence: skipping release approval and EAS prompts (${reasons.join("; ")}).`,
            ),
          );
          if (consecutiveNoProgressCycles >= MAX_CONSECUTIVE_NO_PROGRESS_CYCLES) {
            console.log(chalk.red.bold("\n  LOOP STALLED — STOPPING TO SAVE COMPUTE"));
            console.log(
              chalk.red(
                `  ${consecutiveNoProgressCycles} consecutive cycles produced no new product code, no packet movement, and no QA change, yet investor convergence is still unmet (${reasons.join("; ")}).`,
              ),
            );
            console.log(
              chalk.red(
                "  The pipeline cannot raise investor grades without new work, so re-running it just burns the independent_qa stage each cycle.",
              ),
            );
            console.log(chalk.yellow("\n  To make progress, pick one:"));
            console.log(
              chalk.yellow(
                "  • Approve/ship the current green build: re-run `foundry ship` (or `foundry loop` without --no-wait) in a TTY and approve.",
              ),
            );
            console.log(
              chalk.yellow(
                "  • Give the loop new work: add/refine `builder.directives` in .foundry/project.yaml, or re-run with `--reset-spec` to revive dropped directives.",
              ),
            );
            console.log(
              chalk.yellow(
                "  • Lower the bar in .foundry/project.yaml under `foundry.autonomous_investor_convergence`: set `min_average_grade` (or `defer_release_prompt_until_investor_target: false`, or `enabled: false`) if B+ is unreachable for this scope.\n",
              ),
            );
            break;
          }
          console.log(
            chalk.gray(
              "  Continuing the outer loop: next cycle runs the full pipeline (including feedback_agent) so Supabase + ledger feedback stay merged before Cursor.\n",
            ),
          );
          continue;
        }
        console.log(chalk.yellow.bold("\n  RELEASE READY — APPROVAL REQUIRED"));
        console.log(chalk.yellow(`  Review: ${repoPath}/.foundry/APPROVAL_REQUIRED.md`));
        console.log(
          chalk.yellow(
            `  Pipeline QA certified (independent_qa recommends ship, score=${pipelineQa?.score ?? "?"}).\n`,
          ),
        );
        if (releaseOutput.approvalFile) {
          const approvalPath = join(repoPath, releaseOutput.approvalFile);
          if (noWait && (!process.stdin.isTTY || !process.stdout.isTTY)) {
            console.log(
              chalk.gray(
                "  --no-wait: skipping interactive approval (no TTY). Re-run without --no-wait in an interactive terminal to approve, or create the approval file manually.",
              ),
            );
            console.log(chalk.gray("  Stopping now to avoid starting another cycle while a release is already awaiting approval.\n"));
            break;
          }
          const easSettings = resolveEasBuildSettings(foundryConfig);
          if (isEasReleaseEligible(foundryConfig)) {
            console.log(chalk.bold.cyan("\n  Release actions (interactive)"));
            console.log(
              chalk.gray(
                "  Choose EAS/TestFlight now; Foundry runs your choices after you approve below and the builder branch is merged.",
              ),
            );
          }
          const presolvedReleaseChoices = await promptReleaseActions(repoPath, easSettings, foundryConfig);
          const approved = await promptReleaseApproval(approvalPath);
          if (!approved) {
            console.log(chalk.gray("  Stopping: release approval was not granted.\n"));
            break;
          }
          const releaseResult = await runApprovedReleaseActions(
            repoPath,
            foundryConfig,
            manifest,
            "approved",
            presolvedReleaseChoices,
          );
          if (!releaseResult.ok) {
            if (releaseResult.retryLoop) {
              const key = releaseResult.failureKey ?? "release-action-failed";
              repeatedReleaseFailureCount = key === lastReleaseFailureKey ? repeatedReleaseFailureCount + 1 : 1;
              lastReleaseFailureKey = key;
              if (repeatedReleaseFailureCount >= 2) {
                console.log(chalk.red.bold("\n  RELEASE ACTION FAILURE REPEATED"));
                console.log(
                  chalk.red(
                    "  The same release action failed again after a feedback/build cycle. Stopping to avoid an infinite loop.",
                  ),
                );
                if (releaseResult.failureLogPath) console.log(chalk.red(`  Latest log: ${releaseResult.failureLogPath}`));
                break;
              }
              console.log(
                chalk.yellow(
                  "\n  Release actions produced a fresh failure artifact. Continuing immediately into the next full loop cycle so Expo build logs can be ingested and repo-fixable errors can be queued for Cursor.\n",
                ),
              );
              continue;
            }
            break;
          }
          break;
        }
      } else if (releaseOutput?.status === "approved" || releaseOutput?.status === "auto_approved") {
        console.log(chalk.green.bold("\n  Release approved — shipping"));
      } else if (releaseOutput?.status === "blocked_pre_release") {
        console.log(chalk.cyan("\n  Release not ready yet (pre-release gates): QA recommends ship."));
        console.log(
          chalk.cyan(
            `  independent_qa recommendation=${pipelineQa?.recommendation ?? "?"}, score=${pipelineQa?.score ?? "?"} — finish tracked CURSOR_BRIEF items, builder readiness, and checklist rows before approval.`,
          ),
        );
        console.log(chalk.cyan(`  Builder report: ${join(foundryDir, "CURSOR_BUILDER_REPORT.md")}\n`));
      } else if (releaseOutput?.status === "blocked_by_qa") {
        const qaRecommendation = pipelineQa?.recommendation ?? "unknown";
        if (qaRecommendation !== "ship") {
          console.log(chalk.cyan("\n  Release blocked: pipeline `independent_qa` did not recommend ship."));
          console.log(
            chalk.cyan(
              `  recommendation=${qaRecommendation}, score=${pipelineQa?.score ?? "?"}. See this run's independent_qa README under .foundry/out/${manifest.runId}/`,
            ),
          );
          console.log(
            chalk.cyan(
              "  Fix tests, lint, typecheck, or Maestro (if required), then re-run. Cursor agents only help implement fixes — they are not a second QA gate.\n",
            ),
          );
        } else {
          console.log(chalk.cyan("\n  Release blocked: QA is green, but non-QA gates are still blocked."));
          console.log(
            chalk.cyan(
              `  independent_qa recommendation=${qaRecommendation}, score=${pipelineQa?.score ?? "?"}; builder status=${builderOutput?.status ?? "unknown"}.`,
            ),
          );
          const blockers = extractBuilderBlockers(builderOutput);
          if (blockers.length > 0) {
            console.log(chalk.cyan("  Active builder blockers:"));
            blockers.forEach((b, i) => {
              console.log(chalk.cyan(`    ${i + 1}. ${truncateForDisplay(b, 120)}`));
            });
          }
          console.log(chalk.cyan(`  Builder report: ${join(foundryDir, "CURSOR_BUILDER_REPORT.md")}\n`));
        }
      }

      const feedbackStage = manifest.stages.find((s) => s.stage === "feedback_agent");
      if (feedbackStage?.status === "passed") {
        console.log(
          chalk.gray(
            noWait
              ? "\n  Feedback collected. Next cycle immediately (--no-wait)."
              : `\n  Feedback collected. Next cycle in ${opts.feedbackInterval} minutes.`,
          ),
        );
      }

      // Summary
      console.log(chalk.gray(`\n  Run: ${manifest.runId}`));
      console.log(chalk.gray(`  Artifacts: ${join(foundryDir, "out", manifest.runId)}`));
      console.log(chalk.gray(`  CURSOR_BRIEF: ${join(foundryDir, "CURSOR_BRIEF.md")}`));
      console.log(chalk.gray(`  CURSOR_BUILDER_REPORT: ${join(foundryDir, "CURSOR_BUILDER_REPORT.md")}`));
      console.log(
        chalk.gray(
          `  PIPELINE_QA: recommendation=${pipelineQa?.recommendation ?? "missing"}, score=${pipelineQa?.score ?? "—"}`,
        ),
      );
      console.log(chalk.gray(`  Legacy optional notes (ignored for ship): ${join(foundryDir, "CURSOR_QA_REPORT.md")}`));

      if (releaseOutput?.status === "approved" || releaseOutput?.status === "auto_approved") {
        const releaseResult = await runApprovedReleaseActions(repoPath, foundryConfig, manifest, releaseOutput?.status);
        if (!releaseResult.ok) {
          if (releaseResult.retryLoop) {
            const key = releaseResult.failureKey ?? "release-action-failed";
            repeatedReleaseFailureCount = key === lastReleaseFailureKey ? repeatedReleaseFailureCount + 1 : 1;
            lastReleaseFailureKey = key;
            if (repeatedReleaseFailureCount >= 2) {
              console.log(chalk.red.bold("\n  RELEASE ACTION FAILURE REPEATED"));
              console.log(
                chalk.red(
                  "  The same release action failed again after a feedback/build cycle. Stopping to avoid an infinite loop.",
                ),
              );
              if (releaseResult.failureLogPath) console.log(chalk.red(`  Latest log: ${releaseResult.failureLogPath}`));
              break;
            }
            console.log(
              chalk.yellow(
                "\n  Release actions produced a fresh failure artifact. Continuing immediately into the next full loop cycle so Expo build logs can be ingested and repo-fixable errors can be queued for Cursor.\n",
              ),
            );
            continue;
          }
          break;
        }
        break;
      }

      if (maxCycles > 0 && cycle >= maxCycles) break;

      if (noWait) {
        console.log(chalk.gray("\n  --no-wait: starting next cycle immediately (Ctrl+C to stop).\n"));
      } else {
        console.log(chalk.gray(`\n  Sleeping ${opts.feedbackInterval} minutes until next cycle...`));
        console.log(chalk.gray(`  Press Ctrl+C to stop.\n`));
        await sleep(feedbackIntervalMs);
      }
    }

    console.log(chalk.bold.cyan("\nLoop finished."));
  });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const normalizedArgv = process.argv.filter((arg, index) => !(index >= 2 && arg === "--"));
program.parseAsync(normalizedArgv);
