import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { writeStageMarkdown } from "@foundry/core/artifacts";
import { readBuildSpecFromRepo, readBuildSpecLedger } from "@foundry/core/buildSpec";
import { resolveFoundryCursorModel } from "@foundry/core/cursorModels";
import {
  buildHeuristicRemovalDirectives,
  buildPersonaMemoryPromptSection,
  buildSurfaceInventoryLines,
  directiveMatchesAddressedParent,
  filterGenericDirectives,
  filterStaleDirectives,
  mergeInvestorDirectives,
  normalizeRemovalDirective,
  parseInvestorPanelSettings,
  reconcilePersonaMemories,
  type InvestorPanelStateV2,
  type PersonaId,
} from "./investorPanelMemory.js";

const execFileAsync = promisify(execFile);

const INVESTOR_PANEL_STATE_REL = ".foundry/INVESTOR_PANEL_STATE.json";

type InvestorPanelState = InvestorPanelStateV2;

async function readInvestorPanelState(repoPath: string): Promise<InvestorPanelState | undefined> {
  try {
    const raw = await readFile(join(repoPath, INVESTOR_PANEL_STATE_REL), "utf8");
    return JSON.parse(raw) as InvestorPanelState;
  } catch {
    return undefined;
  }
}

async function writeInvestorPanelState(repoPath: string, state: InvestorPanelState): Promise<void> {
  await writeFile(join(repoPath, INVESTOR_PANEL_STATE_REL), JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function gitHeadSha(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function gitDiffStatSinceSha(repoPath: string, sinceSha: string): Promise<{
  filesChanged: number;
  insertions: number;
  deletions: number;
  topFiles: string[];
  commitCount: number;
}> {
  if (!sinceSha) return { filesChanged: 0, insertions: 0, deletions: 0, topFiles: [], commitCount: 0 };
  try {
    const [{ stdout: shortstat }, { stdout: numstat }, { stdout: log }] = await Promise.all([
      execFileAsync("git", ["-C", repoPath, "diff", "--shortstat", `${sinceSha}..HEAD`], { encoding: "utf8" }),
      execFileAsync("git", ["-C", repoPath, "diff", "--numstat", `${sinceSha}..HEAD`], { encoding: "utf8" }),
      execFileAsync("git", ["-C", repoPath, "log", "--oneline", `${sinceSha}..HEAD`], { encoding: "utf8" }),
    ]);
    const m = /(\d+)\s+files? changed(?:,\s*(\d+)\s+insertions?\(\+\))?(?:,\s*(\d+)\s+deletions?\(-\))?/.exec(shortstat);
    const filesChanged = m?.[1] ? Number.parseInt(m[1], 10) : 0;
    const insertions = m?.[2] ? Number.parseInt(m[2], 10) : 0;
    const deletions = m?.[3] ? Number.parseInt(m[3], 10) : 0;
    const topFiles = numstat
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[0-9-]+\s+[0-9-]+\s+/.test(line))
      .map((line) => {
        const [a, d, ...f] = line.split(/\s+/);
        return {
          file: f.join(" "),
          churn: (Number.parseInt(a ?? "0", 10) || 0) + (Number.parseInt(d ?? "0", 10) || 0),
        };
      })
      .filter((x) => !x.file.startsWith(".foundry/") && !x.file.startsWith(".maestro-debug/"))
      .sort((a, b) => b.churn - a.churn)
      .slice(0, 6)
      .map((x) => x.file);
    const commitCount = log.split("\n").filter((l) => l.trim().length > 0).length;
    return { filesChanged, insertions, deletions, topFiles, commitCount };
  } catch {
    return { filesChanged: 0, insertions: 0, deletions: 0, topFiles: [], commitCount: 0 };
  }
}

async function buildSinceLastPitchSection(repoPath: string): Promise<string> {
  const state = await readInvestorPanelState(repoPath);
  const head = await gitHeadSha(repoPath);
  const spec = await readBuildSpecFromRepo(repoPath);
  const ledger = await readBuildSpecLedger(repoPath);

  const completedTaskIds = Object.keys(ledger.tasks);
  const newlyCompleted = state?.lastCompletedTaskIds
    ? completedTaskIds.filter((id) => !state.lastCompletedTaskIds.includes(id))
    : completedTaskIds;

  const lines: string[] = ["", "**SHIPPED SINCE LAST PITCH (grade the delta, not just the elevator):**"];
  if (!state) {
    lines.push("- First pitch this run — no prior baseline to diff against.");
  } else {
    const diff = await gitDiffStatSinceSha(repoPath, state.lastHeadSha);
    lines.push(
      `- Commits: ${diff.commitCount}, files: ${diff.filesChanged}, +${diff.insertions}/-${diff.deletions} LOC since previous pitch (last pitched ${state.lastPitchAt}).`,
    );
    if (diff.topFiles.length > 0) {
      lines.push(`- Largest product edits: ${diff.topFiles.map((f) => `\`${f}\``).join(", ")}.`);
    }
    if (state.lastGrades) {
      const prev = Object.entries(state.lastGrades).map(([k, v]) => `${k}=${v}`).join(", ");
      lines.push(`- Previous grades: ${prev}. Grades should move when shipped work addresses prior directives.`);
    }
  }

  if (newlyCompleted.length > 0) {
    // Product-phrased only — never leak internal task IDs / ledger mechanics into
    // the pitch, or the panel critiques our bookkeeping instead of the product.
    const descriptions: string[] = [];
    for (const id of newlyCompleted) {
      const task = spec?.slices[0]?.tasks.find((t) => t.id === id);
      if (task) descriptions.push(task.task);
    }
    if (descriptions.length > 0) {
      lines.push("- Product work shipped since last pitch:");
      for (const desc of descriptions.slice(0, 8)) lines.push(`  - ${desc}`);
    } else {
      lines.push(`- ${newlyCompleted.length} product task(s) completed since last pitch (see git diff above).`);
    }
  }

  // Grade-up signal: product goals fully delivered in shipped code. We surface the
  // human-readable directive text (not task IDs) so the panel rewards real
  // progress. We deliberately do NOT list "still open" internal task counts —
  // the panel grades the product a user sees, not our open-item bookkeeping.
  if (spec && spec.parentDirectives.length > 0) {
    const addressedParents = spec.parentDirectives.filter(
      (p) => p.childTaskIds.length > 0 && p.childTaskIds.every((cid) => cid in ledger.tasks),
    );
    if (addressedParents.length > 0) {
      lines.push(
        `- Product goals now delivered in shipped code (grade these up): ${addressedParents
          .map((p) => `"${p.text.slice(0, 80)}"`)
          .join("; ")}.`,
      );
    }
  }

  if (head) {
    lines.push(`- Current HEAD: \`${head.slice(0, 8)}\`.`);
  }

  return lines.join("\n");
}

export async function recordInvestorPanelPitched(
  repoPath: string,
  grades: Record<string, string>,
  directives: ReadonlyArray<string>,
  averageRank: number,
  personas?: InvestorPanelState["personas"],
): Promise<void> {
  const head = await gitHeadSha(repoPath);
  const ledger = await readBuildSpecLedger(repoPath);
  const prior = await readInvestorPanelState(repoPath);
  await writeInvestorPanelState(repoPath, {
    lastPitchAt: new Date().toISOString(),
    lastHeadSha: head,
    lastCompletedTaskIds: Object.keys(ledger.tasks),
    lastGrades: grades,
    lastDirectives: [...directives],
    lastAverageRank: averageRank,
    personas: personas ?? prior?.personas,
  });
}

/**
 * Fuzzy match: returns true if `directive` text is recognizably represented in
 * the ledger's addressed parent directives. Uses normalized prefix + a couple
 * of distinctive content words to avoid the LLM rewording a directive past us.
 */
function directiveMatchesAddressedParentLocal(
  directive: string,
  addressedTexts: ReadonlyArray<string>,
): boolean {
  return directiveMatchesAddressedParent(directive, addressedTexts);
}

/**
 * Inspect whether a re-pitch is justified given the previous pitch's
 * directives and the BUILD_SPEC_LEDGER. Returns an array of directives that
 * have not yet been addressed in code. Empty array ⇒ safe to re-pitch.
 *
 * Exposed for the loop runner's investor-panel gate.
 */
export async function unaddressedDirectivesSinceLastPitch(repoPath: string): Promise<string[]> {
  const state = await readInvestorPanelState(repoPath);
  if (!state || !state.lastDirectives || state.lastDirectives.length === 0) return [];
  const ledger = await readBuildSpecLedger(repoPath);
  const addressedTexts = Object.values(ledger.addressedParents ?? {}).map((p) => p.text);
  return state.lastDirectives.filter((d) => !directiveMatchesAddressedParentLocal(d, addressedTexts));
}
import {
  INVESTOR_GRADE_ORDER,
  INVESTOR_ALL_A_MINUS_RANK,
  investorGradeRank,
  parseAutonomousInvestorConvergence,
  computeInvestorTargetFields,
  type InvestorLetterGrade,
} from "@foundry/core/investorGrades";
import {
  domainSummaryLine,
  getDomainKeyUserActions,
  getDomainNonGoals,
  getDomainPersonas,
  getDomainPrimaryMetric,
  getDomainSuccessExamples,
  getDomainVocabulary,
  hasDomain,
} from "@foundry/core/projectDomain";
import { StageInputCompositionSchema, type StageInputComposition } from "@foundry/core/stageInputs";
import type { RunContext, Stage } from "@foundry/core/types";
import { z } from "zod";

import { ConvergenceContractOutputSchema } from "./convergence_contract.js";
import { ProductDefinitionOutputSchema } from "./product_definition.js";
import { MonetizationOutputSchema } from "./monetization_architect.js";
import { FlywheelOutputSchema } from "./flywheel_designer.js";
import { MarketGapOutputSchema } from "./market_gap_analysis.js";

export type InvestorGrade = InvestorLetterGrade;

/** @deprecated Use INVESTOR_ALL_A_MINUS_RANK from `@foundry/core/investorGrades`. */
export const INVESTOR_MIN_RANK = INVESTOR_ALL_A_MINUS_RANK;

const GradeZod = z.enum(
  [...INVESTOR_GRADE_ORDER] as unknown as [InvestorLetterGrade, ...InvestorLetterGrade[]],
);

const PersonaSchema = z.object({
  id: z.enum(["elon_musk", "steve_jobs", "andreessen_horowitz"]),
  displayName: z.string(),
  grade: GradeZod,
  response: z.string(),
  /** Persona-specific refinement directives (file-anchored). */
  directives: z.array(z.string()).optional(),
});

export const InvestorPanelOutputSchema = z.object({
  pitchBrief: z.string(),
  investors: z.array(PersonaSchema).length(3),
  worstGrade: GradeZod,
  worstRank: z.number().int(),
  meetsMinimumGradeA: z.boolean(),
  /** When `foundry.autonomous_investor_convergence` is enabled, pipeline/loop use this bar (mean grade). */
  meetsInvestorTarget: z.boolean(),
  averageInvestorRank: z.number(),
  /** Product-shaped, code-actionable refinement directives the loop should act on. */
  combinedRefinementDirectives: z.array(z.string()),
  /**
   * Evidence/ops asks that require real devices or real users (on-device p95,
   * Yuka benchmarks, D1/D7 retention, prod migration verification). Surfaced to
   * the human; they never drive Cursor or block convergence. Foundry-internal
   * tracker chatter is dropped entirely and never appears here.
   */
  deferredHumanDirectives: z.array(z.string()).default([]),
  refinementRound: z.number().int().min(0),
  /**
   * True when the panel could not actually grade the product (LLM grader
   * unavailable) and Foundry failed closed instead of grading planning docs.
   * Such a panel never satisfies the convergence bar.
   */
  panelUnavailable: z.boolean().optional(),
});

export type InvestorPanelOutput = z.infer<typeof InvestorPanelOutputSchema>;

const InvestorPanelLlmDraftSchema = z.object({
  pitchBrief: z.string().optional(),
  investors: z.array(PersonaSchema).length(3),
  combinedRefinementDirectives: z.array(z.string()).optional(),
  deferredHumanDirectives: z.array(z.string()).optional(),
});

type Signals = {
  clarity: number;
  ambition: number;
  simplicity: number;
  monetization: number;
  differentiation: number;
  metricsAlignment: number;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function extractSignals(input: StageInputComposition): Signals {
  const pd = ProductDefinitionOutputSchema.safeParse(input.productDefinition);
  const mon = MonetizationOutputSchema.safeParse(input.monetizationConfig);
  const fly = FlywheelOutputSchema.safeParse(input.flywheel);
  const gap = MarketGapOutputSchema.safeParse(input.marketGap);
  const cc = ConvergenceContractOutputSchema.safeParse(input.convergenceContract);

  const oneLiner = pd.success ? pd.data.oneLiner : "";
  const mustN = pd.success ? pd.data.scope.mustShip.length : 0;
  const wontN = pd.success ? pd.data.scope.wontShip.length : 0;
  const acN = pd.success ? pd.data.acceptanceCriteria.length : 0;

  // Convergence contract is the authority on simplicity / clarity / focus when present.
  const convergedBonus = cc.success && cc.data.isConverged ? 12 : 0;
  const convergenceWarnPenalty = cc.success ? cc.data.convergenceWarnings.length * 4 : 0;
  const openObjectionPenalty = cc.success
    ? cc.data.openObjections.filter((o) => o.status === "open" || o.status === "regressed").length * 3
    : 0;
  const singularLoopBonus = cc.success ? 8 : 0;

  const clarity = clamp(50 + oneLiner.length / 8 + acN * 3 + convergedBonus - convergenceWarnPenalty, 35, 95);

  const ambition =
    fly.success && fly.data.flywheel[0]
      ? clamp(40 + fly.data.flywheel[0].steps.length * 6 + (input.config.project.north_star?.length ?? 0) / 5, 30, 95)
      : 45;

  const simplicity = clamp(
    75 -
      mustN * 4 -
      wontN * 2 +
      (pd.success && pd.data.coreWorkflows.length <= 2 ? 10 : 0) +
      singularLoopBonus +
      convergedBonus -
      openObjectionPenalty,
    25,
    92,
  );

  const monetization = mon.success
    ? clamp(
        35 +
          (mon.data.pricing.monthlyUsd > 0 ? 15 : 0) +
          mon.data.gates.length * 8 +
          mon.data.analyticsEvents.length * 3 +
          (mon.data.pricing.trialDays && mon.data.pricing.trialDays > 0 ? 8 : 0),
        28,
        96,
      )
    : 30;

  const differentiation = clamp(
    40 +
      (input.config.project.core_differentiators?.length ?? 0) * 10 +
      (gap.success ? gap.data.gapsToExploit.length * 5 : 0),
    25,
    94,
  );

  const metricsAlignment = clamp(
    35 + (input.config.metrics?.metrics?.length ?? 0) * 8 + (fly.success ? 12 : 0),
    28,
    93,
  );

  return { clarity, ambition, simplicity, monetization, differentiation, metricsAlignment };
}

function scoreToGrade(score: number): InvestorGrade {
  if (score < 18) return "F";
  if (score < 28) return "D";
  if (score < 38) return "C";
  if (score < 45) return "C-";
  if (score < 52) return "C+";
  if (score < 58) return "B-";
  if (score < 66) return "B";
  if (score < 74) return "B+";
  if (score < 82) return "A-";
  if (score < 90) return "A";
  return "A+";
}

function elonScore(s: Signals): number {
  return (
    s.ambition * 0.35 +
    s.metricsAlignment * 0.25 +
    s.clarity * 0.15 +
    s.monetization * 0.15 +
    s.differentiation * 0.1
  );
}

function jobsScore(s: Signals): number {
  return (
    s.simplicity * 0.4 +
    s.clarity * 0.25 +
    s.differentiation * 0.2 +
    s.ambition * 0.15
  );
}

function a16zScore(s: Signals): number {
  return (
    s.monetization * 0.35 +
    s.differentiation * 0.25 +
    s.clarity * 0.2 +
    s.metricsAlignment * 0.2
  );
}

/**
 * Minimal local hint schemas for runtime evidence — kept inline to avoid an
 * import cycle with `builder` / `independent_qa`. Only the fields that
 * influence the pitch brief are validated.
 */
const BuilderEvidenceSchema = z
  .object({
    status: z.enum(["ok", "partial", "blocked", "failed"]).optional(),
    changes: z
      .object({
        filesCreated: z.array(z.string()).optional(),
        filesModified: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .partial();

const QaEvidenceSchema = z
  .object({
    recommendation: z.string().optional(),
    score: z.number().optional(),
    blockers: z.array(z.string()).optional(),
  })
  .partial();

async function buildPitchBrief(input: StageInputComposition, repoPath: string): Promise<string> {
  const sinceLastPitch = await buildSinceLastPitchSection(repoPath);
  return buildPitchBriefSync(input) + sinceLastPitch;
}

function buildPitchBriefSync(input: StageInputComposition): string {
  const name = input.config.project.project_name;
  const ns = input.config.project.north_star;
  const pd = ProductDefinitionOutputSchema.safeParse(input.productDefinition);
  const mon = MonetizationOutputSchema.safeParse(input.monetizationConfig);
  const fly = FlywheelOutputSchema.safeParse(input.flywheel);
  const cc = ConvergenceContractOutputSchema.safeParse(input.convergenceContract);
  const builderEv = BuilderEvidenceSchema.safeParse(input.builder);
  const qaEv = QaEvidenceSchema.safeParse(input.independentQa);

  const lines: string[] = [`**${name}** — ${ns}`, ""];

  // Domain block: surface the configured product vocabulary and concrete user
  // actions so the investor LLM grades on the real product, not abstract
  // north-star phrasing. Without this, panels rated GutCheck (an
  // ingredient-safety scanner) on generic SaaS criteria.
  if (hasDomain(input.config.project)) {
    const domainPrimary = domainSummaryLine(input.config.project);
    const personas = getDomainPersonas(input.config.project);
    const actions = getDomainKeyUserActions(input.config.project);
    const examples = getDomainSuccessExamples(input.config.project);
    const nonGoals = getDomainNonGoals(input.config.project);
    const metric = getDomainPrimaryMetric(input.config.project);
    const vocab = getDomainVocabulary(input.config.project);
    lines.push("**Domain (project.domain):**");
    if (domainPrimary) lines.push(`- Primary moment: ${domainPrimary}`);
    if (personas.length > 0) lines.push(`- Personas: ${personas.join("; ")}`);
    if (actions.length > 0) {
      lines.push(`- Key ${vocab.noun}s the product must support:`);
      for (const a of actions.slice(0, 6)) lines.push(`  - ${a}`);
    }
    if (examples.length > 0) {
      lines.push("- Success examples (these are the demos to grade against):");
      for (const e of examples.slice(0, 6)) lines.push(`  - ${e}`);
    }
    if (nonGoals.length > 0) lines.push(`- Out of scope: ${nonGoals.join("; ")}`);
    if (metric) lines.push(`- Primary metric: ${metric}`);
    lines.push("");
  }

  // Convergence contract supplies the elevator + loop when present (single source of truth);
  // we deliberately omit parked features so the pitch can't leak deferred surface area.
  if (cc.success) {
    lines.push(
      `**Elevator:** ${cc.data.productThesis}`,
      `**Target user:** ${cc.data.targetUser}`,
      `**Singular loop:** ${cc.data.singularLoop.name} → metric \`${cc.data.singularLoop.northStarMetric.key}\` (target: ${cc.data.singularLoop.northStarMetric.target})`,
      `**Convergence:** ${cc.data.isConverged ? "yes" : "no"} (${cc.data.convergenceWarnings.length} warning(s), ${cc.data.openObjections.filter((o) => o.status === "open" || o.status === "regressed").length} open objection(s))`,
    );
  } else if (pd.success) {
    lines.push(`**Elevator:** ${pd.data.oneLiner}`);
  } else {
    lines.push("**Elevator:** (product definition unavailable)");
  }

  if (mon.success) {
    lines.push(
      `**Pricing:** $${mon.data.pricing.monthlyUsd}/mo · $${mon.data.pricing.yearlyUsd}/yr` +
        (mon.data.pricing.trialDays ? ` · ${mon.data.pricing.trialDays}d trial` : ""),
      `**Monetization:** ${mon.data.gates.length} gated feature(s); primary paywall moments tied to value.`,
    );
  } else {
    lines.push("**Monetization:** (not available)");
  }

  // Only fall back to flywheel-loop language when there is no convergence contract.
  if (!cc.success && fly.success && fly.data.flywheel[0]) {
    const f = fly.data.flywheel[0];
    lines.push(`**Core loop:** ${f.loopName} → metric \`${f.metric.key}\`.`);
  }

  // CURRENT REPO/PRODUCT STATE — the pitch must reflect what is actually built,
  // not just declared scope. The runner gate already prevents the panel from
  // running with open brief / open objections, but we annotate the evidence here
  // so the LLM grades on shipped reality.
  const builderStatus = builderEv.success ? builderEv.data.status ?? "missing" : "missing";
  const filesTouched = builderEv.success
    ? (builderEv.data.changes?.filesCreated?.length ?? 0) +
      (builderEv.data.changes?.filesModified?.length ?? 0)
    : 0;
  const qaRecommendation = qaEv.success ? qaEv.data.recommendation ?? "missing" : "missing";
  const qaScore = qaEv.success && typeof qaEv.data.score === "number" ? qaEv.data.score : undefined;
  const qaBlockers = qaEv.success ? qaEv.data.blockers?.length ?? 0 : 0;

  lines.push(
    `**Built state:** builder=${builderStatus} · files_touched=${filesTouched} · qa=${qaRecommendation}${qaScore !== undefined ? `(score ${qaScore})` : ""} · qa_blockers=${qaBlockers}`,
  );

  if (cc.success && cc.data.mvpBoundary.mustShip.length > 0) {
    lines.push(
      `**Must-ship scope:** ${cc.data.mvpBoundary.mustShip.length} item(s) declared in the contract; pitch is gated to only run when all are built.`,
    );
  }

  lines.push("", "_Investor panel memo for internal planning. Pitch reflects current product+repo state, not aspirational scope._");

  return lines.join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellBootstrapCommand(inner: string): string {
  const setup = [
    "[ -f ~/.bash_profile ] && source ~/.bash_profile >/dev/null 2>&1 || true",
    "[ -f ~/.bashrc ] && source ~/.bashrc >/dev/null 2>&1 || true",
    "[ -f ~/.profile ] && source ~/.profile >/dev/null 2>&1 || true",
  ].join("; ");
  return `${setup}; ${inner}`;
}

function execShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/bash";
    execFile(
      shell,
      ["-lc", shellBootstrapCommand(command)],
      {
        cwd,
        env: process.env,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      },
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

function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

function llmContext(input: StageInputComposition, pitchBrief: string): string {
  // Hygiene: only feed the panel product-facing inputs. We deliberately omit raw
  // Foundry internals (`builder` changes/status, `releaseAgent` checklist,
  // `currentStateAudit`, `feedback` ledger, `growthOperator`) because dumping them
  // makes the LLM critique our tooling ("builder partial", "BUILD_SPEC tasks
  // open") instead of the product. QA is reduced to a compact recommendation.
  const cc = ConvergenceContractOutputSchema.safeParse(input.convergenceContract);
  let convergenceContract: unknown = input.convergenceContract;
  if (cc.success) {
    // Drop tooling objections; tag evidence/ops so the LLM does not lower the
    // PRODUCT grade for go-to-market data it cannot produce from code.
    const filteredObjections = cc.data.openObjections
      .filter((o) => classifyInvestorDirective(o.objection) !== "foundry_meta")
      .map((o) => {
        const category = classifyInvestorDirective(o.objection);
        return category === "evidence" || category === "ops"
          ? {
              ...o,
              category,
              note: "human/non-code: do NOT lower the product grade for this; put it under deferredHumanDirectives",
            }
          : { ...o, category };
      });
    convergenceContract = { ...cc.data, openObjections: filteredObjections };
  }

  const qaEv = QaEvidenceSchema.safeParse(input.independentQa);
  const qaSummary = qaEv.success
    ? {
        recommendation: qaEv.data.recommendation ?? "missing",
        score: qaEv.data.score,
        blockerCount: qaEv.data.blockers?.length ?? 0,
      }
    : { recommendation: "missing" };

  const payload = {
    project: input.config.project,
    metrics: input.config.metrics,
    marketGap: input.marketGap,
    firstPrinciples: input.firstPrinciples,
    flywheel: input.flywheel,
    convergenceContract,
    productDefinition: input.productDefinition,
    monetizationConfig: input.monetizationConfig,
    qaSummary,
    pitchBrief,
  };
  return JSON.stringify(payload, null, 2);
}

async function gatherSurfaceInventory(
  input: StageInputComposition,
  repoPath: string,
): Promise<{ topFiles: string[]; wontShip: string[]; parkedFeatures: string[]; mustShipCount: number }> {
  const state = await readInvestorPanelState(repoPath);
  const sinceSha = state?.lastHeadSha ?? "";
  const diff = await gitDiffStatSinceSha(repoPath, sinceSha);
  const cc = ConvergenceContractOutputSchema.safeParse(input.convergenceContract);
  const pd = ProductDefinitionOutputSchema.safeParse(input.productDefinition);
  const wontShip = cc.success
    ? cc.data.mvpBoundary.mustNotShipYet
    : pd.success
      ? pd.data.scope.wontShip
      : [];
  const parkedFeatures = cc.success ? cc.data.mvpBoundary.mustNotShipYet : [];
  const mustShipCount = cc.success ? cc.data.mvpBoundary.mustShip.length : pd.success ? pd.data.scope.mustShip.length : 0;
  return { topFiles: diff.topFiles, wontShip, parkedFeatures, mustShipCount };
}

function elonDeletionPrompt(input: StageInputComposition, pitchBrief: string, surfaceLines: string[]): string {
  return [
    "You are Elon Musk doing Step 0 of his process: DELETE before you optimize or add.",
    "Review the product surfaces below. Do NOT suggest additions, polish, or new features.",
    "",
    "Return 2-5 removal directives only. Each MUST:",
    "- Start with `[remove]`",
    "- Name a specific screen/component file (`.tsx` / `.ts`) or testID to delete",
    "- Include how to verify absence (test or Maestro assertion)",
    "",
    "Output STRICT JSON only: {\"removalDirectives\":[\"[remove] …\"]}",
    "",
    "Product context:",
    pitchBrief,
    "",
    "Surface inventory:",
    ...surfaceLines,
    "",
    "Full project JSON (product-facing only):",
    llmContext(input, pitchBrief),
  ].join("\n");
}

const ElonDeletionLlmSchema = z.object({
  removalDirectives: z.array(z.string()).default([]),
});

async function runLlmJsonSubcall(
  ctx: RunContext,
  input: StageInputComposition,
  prompt: string,
  logLabel: string,
): Promise<string | undefined> {
  const command =
    input.config.project.cursor_automation?.command ?? process.env.FOUNDRY_CURSOR_AGENT_CMD ?? "agent";
  const model = resolveFoundryCursorModel(
    input.config.project.cursor_automation?.investor_panel_model ??
      input.config.project.cursor_automation?.qa_model,
    "investorPanelModel",
  );
  const modelName = model.trim().toLowerCase();
  const modelArgs =
    modelName === "auto" || modelName === "default"
      ? ["--model", shellQuote("auto")]
      : ["--model", shellQuote(model)];
  const shellCommand = [
    command,
    "-p",
    "--output-format",
    "text",
    "--force",
    "--trust",
    "--approve-mcps",
    "--workspace",
    shellQuote(ctx.repoPath),
    ...modelArgs,
    shellQuote(prompt),
  ].join(" ");

  const result = await execShell(shellCommand, ctx.repoPath, 5 * 60_000);
  if (result.exitCode !== 0) {
    ctx.logger(`[investor_panel] ${logLabel} unavailable`, {
      stderr: result.stderr.slice(0, 300),
    });
    return undefined;
  }
  return extractJsonObject(`${result.stdout}\n${result.stderr}`);
}

async function tryRunElonDeletionPass(
  ctx: RunContext,
  input: StageInputComposition,
  pitchBrief: string,
  settings: ReturnType<typeof parseInvestorPanelSettings>,
): Promise<string[]> {
  if (!settings.elonDeletionPass) return [];

  const inventory = await gatherSurfaceInventory(input, ctx.repoPath);
  const surfaceLines = buildSurfaceInventoryLines(inventory);
  const prompt = elonDeletionPrompt(input, pitchBrief, surfaceLines);
  const raw = await runLlmJsonSubcall(ctx, input, prompt, "elon_deletion_pass");

  if (raw) {
    try {
      const parsed = ElonDeletionLlmSchema.parse(JSON.parse(raw) as unknown);
      const normalized = parsed.removalDirectives.map(normalizeRemovalDirective).filter((d) => d.length > 0);
      if (normalized.length > 0) {
        ctx.logger("[investor_panel] elon deletion pass", { count: normalized.length });
        return normalized.slice(0, 6);
      }
    } catch (err) {
      ctx.logger("[investor_panel] elon deletion pass parse failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const heuristic = buildHeuristicRemovalDirectives({
    wontShip: inventory.wontShip,
    parkedFeatures: inventory.parkedFeatures,
    topFiles: inventory.topFiles,
    minCount: settings.minDeletionDirectives,
  });
  if (heuristic.length > 0) {
    ctx.logger("[investor_panel] elon deletion pass heuristic fallback", { count: heuristic.length });
  }
  return heuristic;
}

async function buildPersonaMemorySectionForPrompt(
  input: StageInputComposition,
  repoPath: string,
  settings: ReturnType<typeof parseInvestorPanelSettings>,
): Promise<string> {
  const state = await readInvestorPanelState(repoPath);
  const ledger = await readBuildSpecLedger(repoPath);
  const addressedTexts = Object.values(ledger.addressedParents ?? {}).map((p) => p.text);
  const qaEv = QaEvidenceSchema.safeParse(input.independentQa);
  return buildPersonaMemoryPromptSection({
    state,
    addressedTexts,
    qaRecommendation: qaEv.success ? qaEv.data.recommendation : undefined,
    qaBlockers: qaEv.success ? qaEv.data.blockers?.length ?? 0 : undefined,
    settings,
  });
}

function llmPrompt(
  input: StageInputComposition,
  pitchBrief: string,
  personaMemorySection: string,
  removalDirectives: string[],
): string {
  const removalBlock =
    removalDirectives.length > 0
      ? [
          "",
          "**ELON DELETION PASS (Step 0 — already run; honor these removals in grading):**",
          ...removalDirectives.map((d) => `- ${d}`),
          "",
        ].join("\n")
      : "";

  return [
    "You are GPT-5.4 acting as an investor-panel simulator for internal product planning.",
    "Evaluate this app and monetization plan using three distinct archetype voices:",
    "- Elon Musk — delete before add; first-principles; falsifiable metrics",
    "- Steve Jobs — one hero flow; first-session delight; invisible product",
    "- Andreessen Horowitz — monetization, distribution, retention proof",
    "",
    "Requirements:",
    "- Keep the pitch brief to 4-7 lines.",
    "- For each investor, return one grade from: F, D, C, C-, C+, B-, B, B+, A-, A, A+",
    "- Each investor response must be brief (max ~90 words).",
    "- Each investor MUST return their own `directives` array (0-3 items) — persona-specific, file-anchored product changes. Do not copy the same directive across personas.",
    "- GRADE THE PRODUCT A USER EXPERIENCES: the scan→verdict flow, first-session clarity/delight, differentiation, and the monetization model. Use `qaSummary` (recommendation/score) and `convergenceContract` (thesis, singular loop, isConverged, openObjections) as evidence. Do NOT credit capability that is only declared in scope.",
    "- READ the **SHIPPED SINCE LAST PITCH** and **PERSONA MEMORY** sections. If shipped work addresses a prior directive, ACKNOWLEDGE it and move your grade up. When all prior asks are delivered and QA is ship, grade A/A+ and say the product is exceptional.",
    "- CRITICAL — NEVER comment on or grade Foundry's internal tooling: build specs, ledgers, work packets, task IDs (e.g. 't1', 'dir-29'), 'builder partial / zero-delta', tracker reconciliation, primary slices, or the loop itself. These are NOT the product. Ignore any objection phrased in those terms entirely — do not echo it as a directive and do not let it affect the grade.",
    "- CRITICAL — do NOT lower the PRODUCT grade for go-to-market EVIDENCE that requires real devices or real users (on-device latency / p95, Yuka benchmark numbers, D1/D7 retention, cohort / acceptance numbers, production migration verification). Grade the product as built. Put any such ask in `deferredHumanDirectives` (a human runs them), never in `combinedRefinementDirectives`.",
    "- Treat only PRODUCT/UX/positioning items in `convergenceContract.openObjections` (status open/regressed) as grade-affecting; objections tagged category 'evidence' or 'ops' are non-code and must not lower the product grade.",
    "- Reward narrowing, deletion, and parking discipline (one singular loop, parked features removed from UI). Penalise cluttered, multi-bet pitches.",
    "- When grades are below A-band, put concrete PRODUCT refinement directives in each persona's `directives` and the combined list. Each MUST name the screen / component / file and the exact change. No vague prose ('tighten', 'delight', 'polish'). Prefer `[remove]` directives when clutter is the problem.",
    "- When grades are A or A+, responses must praise specific shipped work; `directives` and `combinedRefinementDirectives` should be empty unless there is a concrete regression.",
    "- Output STRICT JSON only. No markdown fences, no prose before/after.",
    "",
    "JSON schema:",
    '{"pitchBrief":"string","investors":[{"id":"elon_musk|steve_jobs|andreessen_horowitz","displayName":"string","grade":"F|D|C|C-|C+|B-|B|B+|A-|A|A+","response":"string","directives":["file-anchored change"]}],"combinedRefinementDirectives":["union of persona directives + removals"],"deferredHumanDirectives":["evidence/ops ask a human must run"]}',
    personaMemorySection,
    removalBlock,
    "",
    "Project context:",
    llmContext(input, pitchBrief),
  ].join("\n");
}

async function tryRunLlmInvestorPanel(
  ctx: RunContext,
  input: StageInputComposition,
  pitchBrief: string,
  refinementRound: number,
  removalDirectives: string[],
  personaMemorySection: string,
): Promise<
  | {
      pitchBrief: string;
      investors: z.infer<typeof PersonaSchema>[];
      worstGrade: InvestorGrade;
      worstRank: number;
      combinedRefinementDirectives: string[];
      deferredHumanDirectives: string[];
      refinementRound: number;
    }
  | undefined
> {
  const command =
    input.config.project.cursor_automation?.command ?? process.env.FOUNDRY_CURSOR_AGENT_CMD ?? "agent";
  const model = resolveFoundryCursorModel(
    input.config.project.cursor_automation?.investor_panel_model ??
      input.config.project.cursor_automation?.qa_model,
    "investorPanelModel",
  );
  const prompt = llmPrompt(input, pitchBrief, personaMemorySection, removalDirectives);
  const modelName = model.trim().toLowerCase();
  const modelArgs =
    modelName === "auto" || modelName === "default"
      ? ["--model", shellQuote("auto")]
      : ["--model", shellQuote(model)];
  const shellCommand = [
    command,
    "-p",
    "--output-format",
    "text",
    "--force",
    "--trust",
    "--approve-mcps",
    "--workspace",
    shellQuote(ctx.repoPath),
    ...modelArgs,
    shellQuote(prompt),
  ].join(" ");

  const result = await execShell(shellCommand, ctx.repoPath, 8 * 60_000);
  if (result.exitCode !== 0) {
    ctx.logger("[investor_panel] llm unavailable; falling back", {
      command,
      model,
      stderr: result.stderr.slice(0, 400),
    });
    return undefined;
  }

  const raw = extractJsonObject(`${result.stdout}\n${result.stderr}`);
  if (!raw) {
    ctx.logger("[investor_panel] llm parse failed; missing JSON", { model });
    return undefined;
  }

  try {
    const parsed = InvestorPanelLlmDraftSchema.parse(JSON.parse(raw) as unknown);
    const ranks = parsed.investors.map((p) => investorGradeRank(p.grade));
    const worstRank = Math.min(...ranks);
    const mergedDirectives = mergeInvestorDirectives(
      removalDirectives,
      parsed.investors.map((i) => ({ id: i.id, directives: i.directives })),
      parsed.combinedRefinementDirectives ?? [],
    );
    return {
      pitchBrief: parsed.pitchBrief?.trim() || pitchBrief,
      investors: parsed.investors,
      worstGrade: INVESTOR_GRADE_ORDER[worstRank] ?? "F",
      worstRank,
      combinedRefinementDirectives: mergedDirectives,
      deferredHumanDirectives: [...new Set(parsed.deferredHumanDirectives ?? [])].slice(0, 8),
      refinementRound,
    };
  } catch (err) {
    ctx.logger("[investor_panel] llm parse failed; invalid JSON shape", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function responseFor(
  id: "elon_musk" | "steve_jobs" | "andreessen_horowitz",
  grade: InvestorGrade,
  s: Signals,
): string {
  const tighten =
    investorGradeRank(grade) < INVESTOR_ALL_A_MINUS_RANK
      ? " To reach an A-band memo, tighten scope to one heroic claim, add a single crisp success metric with a date, and show how software margins improve as usage grows."
      : investorGradeRank(grade) >= investorGradeRank("A")
        ? " This is exceptional — ship it."
        : " This is fundable at the memo level; ship a narrow wedge and instrument the one metric that proves the loop.";

  if (id === "elon_musk") {
    return (
      `First-principles: ${s.ambition >= 70 ? "The ambition registers." : "Why isn't this 10× bolder — what's the limiting physics or cost curve?"} ` +
        `${s.metricsAlignment >= 65 ? "Metrics tie to outcomes." : "I need a falsifiable metric timeline, not vibes."} ` +
        tighten
    );
  }
  if (id === "steve_jobs") {
    return (
      `${s.simplicity >= 68 ? "The story feels focused." : "Too many ideas — what is the one experience that delights in the first minute?"} ` +
        `${s.clarity >= 70 ? "The narrative is clear." : "Make the product invisible; the user should feel the result, not the settings."} ` +
        tighten
    );
  }
  return (
    `${s.monetization >= 68 ? "Revenue story is plausible for software." : "Show me expansion revenue and why this isn't a one-time purchase disguised as SaaS."} ` +
      `${s.differentiation >= 65 ? "Wedge is identifiable." : "Distribution: who pulls this into the org and why switch now?"} ` +
      tighten
  );
}

export type InvestorDirectiveCategory =
  | "product_ux"
  | "positioning"
  | "evidence"
  | "ops"
  | "foundry_meta";

/**
 * Classify an investor refinement directive so the loop only acts on
 * product-shaped feedback.
 *
 * - `foundry_meta`: critiques of Foundry's own bookkeeping (BUILD_SPEC, ledger,
 *   work packet, task IDs, "builder partial/zero-delta", tracker). An investor
 *   never critiques our tooling — drop these entirely.
 * - `evidence` / `ops`: real-world data or infra that needs devices/users/prod
 *   (on-device p95, Yuka benchmarks, D1/D7 retention, Maestro/EAS/migration).
 *   Surface to the human; never drive Cursor or block convergence.
 * - `product_ux` / `positioning`: genuine, code-actionable product feedback —
 *   the only category the builder loop should consume.
 */
export function classifyInvestorDirective(text: string): InvestorDirectiveCategory {
  const t = text.toLowerCase();
  if (
    /\bbuild[_ ]?spec\b/.test(t) ||
    /\bledger\b/.test(t) ||
    /\bwork[_ ]?packet\b/.test(t) ||
    /\bdir-\d+\b/.test(t) ||
    /\bzero[- ]?delta\b/.test(t) ||
    /builder\s*[=:]?\s*partial/.test(t) ||
    /partial\/zero|partial or zero/.test(t) ||
    /reconcile the tracker|the tracker\b/.test(t) ||
    /grand[_ ]?wizard/.test(t) ||
    /primary[_ ]?slice/.test(t) ||
    (/\bfoundry\b/.test(t) && /(meta|artifact|internal|loop|tracker|tooling)/.test(t)) ||
    /open build[_ ]?spec tasks/.test(t) ||
    (/\bt[1-9]\b[^.]*\bt[1-9]\b/.test(t) && /\btask/.test(t))
  ) {
    return "foundry_meta";
  }
  if (
    /\bp95\b/.test(t) ||
    (/\blatency\b/.test(t) && /(measure|publish|benchmark|target hardware)/.test(t)) ||
    /benchmark(ed)? against/.test(t) ||
    (/\byuka\b/.test(t) && /(compar|benchmark|measure|publish|latency|speed)/.test(t)) ||
    /\bd1\b|\bd7\b/.test(t) ||
    /retention (cohort|numbers|rate|dashboard)/.test(t) ||
    /cohort (numbers|evidence|data)/.test(t) ||
    /repeat[- ]?scan rate/.test(t) ||
    /recommendation acceptance/.test(t) ||
    /real (numbers|users|data|cohort|traction)/.test(t) ||
    /(publish|capture|measure)\b[^.]*(evidence|metrics|numbers|cohort)/.test(t)
  ) {
    return "evidence";
  }
  if (
    /\bmaestro\b/.test(t) ||
    /\bsimulator\b|\bsimctl\b|coresimulator/.test(t) ||
    /\beas\b|testflight/.test(t) ||
    /provisioning|aps-environment/.test(t) ||
    /device proof|on (a )?(real )?device|target hardware/.test(t) ||
    (/\bsupabase\b/.test(t) && /(migration|production|prod|deploy)/.test(t)) ||
    /apply.*migration|migration.*production/.test(t) ||
    /\bin production\b/.test(t)
  ) {
    return "ops";
  }
  if (
    /\bthesis\b|one[- ]?liner|\belevator\b|positioning|\bpitch\b|must[- ]?ship|mvp boundary|convergence contract/.test(
      t,
    )
  ) {
    return "positioning";
  }
  return "product_ux";
}

/** Product-shaped directives the loop/Cursor should act on. */
export function isLoopActionableInvestorDirective(text: string): boolean {
  const c = classifyInvestorDirective(text);
  return c === "product_ux" || c === "positioning";
}

function buildDirectives(
  investors: z.infer<typeof PersonaSchema>[],
  s: Signals,
  removalDirectives: string[] = [],
): string[] {
  const d: string[] = [...removalDirectives.map(normalizeRemovalDirective)];
  for (const inv of investors) {
    if (investorGradeRank(inv.grade) >= INVESTOR_ALL_A_MINUS_RANK) continue;
    if (inv.id === "elon_musk") {
      if (d.length === 0) {
        d.push(
          normalizeRemovalDirective(
            "Remove one secondary card stack or duplicate CTA from the primary scan screen; test asserts only one hero action remains.",
          ),
        );
      }
      d.push("Add one 10× bolder milestone and a dated, falsifiable success metric tied to the flywheel.");
      if (s.metricsAlignment < 65) d.push("Align `metrics.yaml` targets explicitly to the primary loop metric.");
    } else if (inv.id === "steve_jobs") {
      d.push("Cut scope to a single hero workflow with a delightful first-session outcome; remove adjacent features from Phase 1.");
      if (s.simplicity < 68) d.push("Rewrite the one-liner so a stranger gets the benefit in one breath.");
    } else {
      d.push("Strengthen monetization: clearer upgrade path, expansion lever, and analytics events that prove conversion.");
      if (s.monetization < 68) d.push("Justify recurring value vs one-time utility; tighten gates to post-value moments.");
    }
  }
  return [...new Set(d)].slice(0, 10);
}

/**
 * Whether the document-only heuristic fallback is explicitly opted into. By
 * default the panel fails closed when the LLM grader is unavailable, because
 * heuristic grades score planning artifacts (one-liner length, must-ship
 * count, convergence flags) — not the built product — and have historically
 * certified incomprehensible apps as A-band.
 */
function investorHeuristicFallbackAllowed(): boolean {
  const v = (process.env.FOUNDRY_INVESTOR_ALLOW_HEURISTIC ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Builds a non-passing "panel unavailable" output used when the LLM grader is
 * unavailable and the heuristic fallback is not explicitly opted into. It can
 * never satisfy the convergence bar (all grades F, meetsInvestorTarget=false),
 * so the loop will not promote/converge on a panel that never saw the product.
 */
function buildUnavailableInvestorPanelOutput(
  pitchBrief: string,
  refinementRound: number,
  input: StageInputComposition,
): InvestorPanelOutput {
  const note =
    "Investor panel could not run: the LLM grader (cursor-agent) was unavailable, so no product-grounded grades were produced. " +
    "Foundry fails closed here instead of grading planning documents. Fix the grader (install/authenticate cursor-agent, or set " +
    "cursor_automation.command / FOUNDRY_CURSOR_AGENT_CMD), or set FOUNDRY_INVESTOR_ALLOW_HEURISTIC=1 to explicitly opt into the " +
    "document-only heuristic fallback.";
  const personas: Array<z.infer<typeof PersonaSchema>> = [
    { id: "elon_musk", displayName: "Elon Musk (archetype)", grade: "F", response: note },
    { id: "steve_jobs", displayName: "Steve Jobs (archetype)", grade: "F", response: note },
    { id: "andreessen_horowitz", displayName: "Andreessen Horowitz (archetype)", grade: "F", response: note },
  ];
  const t = computeInvestorTargetFields(
    personas.map((p) => p.grade),
    parseAutonomousInvestorConvergence(input.config.project.foundry),
  );
  return InvestorPanelOutputSchema.parse({
    pitchBrief,
    investors: personas,
    worstGrade: "F",
    worstRank: 0,
    meetsMinimumGradeA: false,
    meetsInvestorTarget: false,
    averageInvestorRank: t.averageInvestorRank,
    combinedRefinementDirectives: [
      "Restore the investor LLM grader so the panel can grade the built product, not planning documents (install/authenticate cursor-agent or set cursor_automation.command / FOUNDRY_CURSOR_AGENT_CMD).",
    ],
    refinementRound,
    panelUnavailable: true,
  });
}

function finalizeInvestorPanelOutput(
  draft: {
    pitchBrief: string;
    investors: z.infer<typeof PersonaSchema>[];
    worstGrade: InvestorGrade;
    worstRank: number;
    combinedRefinementDirectives: string[];
    deferredHumanDirectives?: string[];
    refinementRound: number;
    removalDirectives?: string[];
  },
  input: StageInputComposition,
  addressedTexts: string[] = [],
): InvestorPanelOutput {
  const grades = draft.investors.map((i) => i.grade);
  const t = computeInvestorTargetFields(grades, parseAutonomousInvestorConvergence(input.config.project.foundry));

  // Keep only product-shaped directives in the loop-driving list; route evidence/
  // ops items to a human checklist and drop Foundry-internal tracker chatter so
  // the builder loop never churns on un-codeable or self-referential feedback.
  const product: string[] = [];
  const deferred: string[] = [];
  for (const d of draft.deferredHumanDirectives ?? []) {
    if (classifyInvestorDirective(d) !== "foundry_meta") deferred.push(d);
  }
  const merged = mergeInvestorDirectives(
    draft.removalDirectives ?? [],
    draft.investors.map((i) => ({ id: i.id as PersonaId, directives: i.directives })),
    draft.combinedRefinementDirectives,
  );
  const staleFiltered = filterStaleDirectives(merged, addressedTexts);
  const genericFiltered = filterGenericDirectives(staleFiltered, addressedTexts, {
    requireFileAnchor: grades.every((g) => investorGradeRank(g) < investorGradeRank("A")),
  });

  for (const d of genericFiltered) {
    const cat = classifyInvestorDirective(d);
    if (cat === "foundry_meta") continue;
    if (cat === "evidence" || cat === "ops") deferred.push(d);
    else product.push(d);
  }

  // When all personas are A-band, clear directives so the loop converges to "exceptional".
  const allABand = grades.every((g) => investorGradeRank(g) >= INVESTOR_ALL_A_MINUS_RANK);

  return InvestorPanelOutputSchema.parse({
    ...draft,
    combinedRefinementDirectives: allABand ? [] : [...new Set(product)].slice(0, 10),
    deferredHumanDirectives: [...new Set(deferred)].slice(0, 8),
    meetsMinimumGradeA: t.meetsMinimumGradeA,
    meetsInvestorTarget: t.meetsInvestorTarget,
    averageInvestorRank: t.averageInvestorRank,
  });
}

export const investorPanelStage: Stage<StageInputComposition, InvestorPanelOutput> = {
  name: "investor_panel",
  description:
    "Brief investment memo + simulated grades (F–A+) from three archetype investors; emits refinement directives when below A-band.",
  inputSchema: StageInputCompositionSchema,
  outputSchema: InvestorPanelOutputSchema,
  async run(ctx: RunContext, input: StageInputComposition): Promise<InvestorPanelOutput> {
    const refinementRound = input.investorRefinement?.round ?? 0;
    const panelSettings = parseInvestorPanelSettings(input.config.project.foundry);
    ctx.logger("[investor_panel] evaluating", {
      project: input.config.project.project_name,
      refinementRound,
      personaMemory: panelSettings.personaMemory,
      elonDeletionPass: panelSettings.elonDeletionPass,
    });

    const pitchBrief = await buildPitchBrief(input, ctx.repoPath);
    const ledger = await readBuildSpecLedger(ctx.repoPath);
    const addressedTexts = Object.values(ledger.addressedParents ?? {}).map((p) => p.text);
    const personaMemorySection = await buildPersonaMemorySectionForPrompt(input, ctx.repoPath, panelSettings);
    const removalDirectives = await tryRunElonDeletionPass(ctx, input, pitchBrief, panelSettings);
    const llmDraft = await tryRunLlmInvestorPanel(
      ctx,
      input,
      pitchBrief,
      refinementRound,
      removalDirectives,
      personaMemorySection,
    );

    let output: InvestorPanelOutput;
    let modeLabel = "GPT-5.4";
    if (llmDraft) {
      output = finalizeInvestorPanelOutput(
        { ...llmDraft, removalDirectives },
        input,
        addressedTexts,
      );
    } else if (!investorHeuristicFallbackAllowed()) {
      ctx.logger("[investor_panel] LLM unavailable — failing closed (no heuristic grades)", {
        hint: "set FOUNDRY_INVESTOR_ALLOW_HEURISTIC=1 to opt into the document-only heuristic fallback",
      });
      output = buildUnavailableInvestorPanelOutput(pitchBrief, refinementRound, input);
      modeLabel = "panel unavailable (LLM grader offline)";
    } else {
      const signals = extractSignals(input);
      const bump = refinementRound * 4;
      const adj = { ...signals };
      for (const k of Object.keys(adj) as (keyof Signals)[]) {
        adj[k] = clamp(adj[k] + bump, 25, 98);
      }

      const gMusk = scoreToGrade(elonScore(adj));
      const gJobs = scoreToGrade(jobsScore(adj));
      const gA16z = scoreToGrade(a16zScore(adj));
      const personas: Array<z.infer<typeof PersonaSchema>> = [
        {
          id: "elon_musk",
          displayName: "Elon Musk (archetype)",
          grade: gMusk,
          response: responseFor("elon_musk", gMusk, adj),
        },
        {
          id: "steve_jobs",
          displayName: "Steve Jobs (archetype)",
          grade: gJobs,
          response: responseFor("steve_jobs", gJobs, adj),
        },
        {
          id: "andreessen_horowitz",
          displayName: "Andreessen Horowitz (archetype)",
          grade: gA16z,
          response: responseFor("andreessen_horowitz", gA16z, adj),
        },
      ];
      const ranks = personas.map((p) => investorGradeRank(p.grade));
      const worstRank = Math.min(...ranks);
      output = finalizeInvestorPanelOutput(
        {
          pitchBrief,
          investors: personas,
          worstGrade: INVESTOR_GRADE_ORDER[worstRank] ?? "F",
          worstRank,
          combinedRefinementDirectives:
            ranks.every((r) => r >= INVESTOR_ALL_A_MINUS_RANK) ? [] : buildDirectives(personas, adj, removalDirectives),
          refinementRound,
          removalDirectives,
        },
        input,
        addressedTexts,
      );
      modeLabel = "heuristic fallback";
    }

    const validated = output;

    if (removalDirectives.length > 0) {
      modeLabel = `${modeLabel} + Elon deletion pass (${removalDirectives.length})`;
    }

    const auto = parseAutonomousInvestorConvergence(input.config.project.foundry);
    const md = [
      `# Investor panel — ${input.config.project.project_name}`,
      "",
      "## Brief pitch (memo-style)",
      "",
      validated.pitchBrief,
      "",
      `## Archetype investors (${modeLabel})`,
      "",
      ...validated.investors.map((i) => {
        const dirs =
          i.directives?.length && i.directives.length > 0
            ? `\n\n**Directives:**\n${i.directives.map((d) => `- ${d}`).join("\n")}`
            : "";
        return `### ${i.displayName} — **${i.grade}**\n\n${i.response}${dirs}\n`;
      }),
      "",
      "## Verdict",
      "",
      `- **Worst grade:** ${validated.worstGrade}`,
      `- **Mean grade rank** (0=F … 10=A+): **${validated.averageInvestorRank.toFixed(2)}**`,
      `- **All personas in A-band (A- or better):** ${validated.meetsMinimumGradeA ? "yes" : "no"}`,
      `- **Meets investor target (pipeline bar):** ${validated.meetsInvestorTarget ? "yes" : "no"}${
        auto.enabled ? ` — autonomous mode: mean ≥ **${auto.minAverageGrade}**` : ""
      }`,
      removalDirectives.length
        ? [
            "",
            "## Elon deletion pass (Step 0 — remove before add)",
            "",
            ...removalDirectives.map((d) => `- ${d}`),
            "",
          ].join("\n")
        : "",
      validated.combinedRefinementDirectives.length
        ? ["", "## Refinement directives (product — drive the loop)", "", ...validated.combinedRefinementDirectives.map((d) => `- ${d}`), ""].join(
            "\n",
          )
        : "",
      validated.deferredHumanDirectives.length
        ? [
            "",
            "## Deferred to human (evidence / ops — not loop-actionable)",
            "_These need real devices, real users, or production access. They do not drive Cursor and do not block convergence._",
            "",
            ...validated.deferredHumanDirectives.map((d) => `- ${d}`),
            "",
          ].join("\n")
        : "",
      "",
      "_Investor panel is for internal planning only; grades are not financial or legal advice._",
      "",
    ].join("\n");

    await writeStageMarkdown(ctx, "investor_panel", "README.md", md);

    const gradesMap: Record<string, string> = {};
    for (const inv of validated.investors) {
      gradesMap[inv.displayName] = inv.grade;
    }

    const priorState = await readInvestorPanelState(ctx.repoPath);
    const pitchAt = new Date().toISOString();
    const personaMemories = panelSettings.personaMemory
      ? reconcilePersonaMemories(
          priorState,
          validated.investors.map((i) => ({
            id: i.id,
            grade: i.grade,
            response: i.response,
            directives: i.directives,
          })),
          validated.combinedRefinementDirectives,
          removalDirectives,
          addressedTexts,
          pitchAt,
        )
      : priorState?.personas;

    await recordInvestorPanelPitched(
      ctx.repoPath,
      gradesMap,
      validated.combinedRefinementDirectives,
      validated.averageInvestorRank,
      personaMemories,
    );

    return validated;
  },
};
