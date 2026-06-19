import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { writeStageMarkdown } from "@foundry/core/artifacts";
import {
  BUILD_SPEC_MD_REL,
  BUILD_SPEC_REL,
  GrandWizardOutputSchema,
  STUCK_DROP_THRESHOLD,
  computeUpstreamFingerprint,
  droppedParentKey,
  isEnvironmentalWorkItem,
  isVagueDirective,
  readBuildSpecLedger,
  renderBuildSpecMarkdown,
  slugifySliceId,
  taskIsConcrete,
  writeBuildSpecLedger,
  type BuildSpecLedger,
  type BuildSpecSlice,
  type ConcreteTask,
  type GrandWizardOutput,
  type ParentDirective,
} from "@foundry/core/buildSpec";
import { resolveFoundryCursorModel } from "@foundry/core/cursorModels";
import { StageInputCompositionSchema, type StageInputComposition } from "@foundry/core/stageInputs";
import type { RunContext, Stage } from "@foundry/core/types";
import { z } from "zod";

import { ConvergenceContractOutputSchema } from "./convergence_contract.js";
import { CurrentStateAuditOutputSchema } from "./current_state_audit.js";
import { FeedbackAgentOutputSchema } from "./feedback_agent.js";
import { InvestorPanelOutputSchema } from "./investor_panel.js";
import { ProductDefinitionOutputSchema } from "./product_definition.js";

export { GrandWizardOutputSchema, type GrandWizardOutput } from "@foundry/core/buildSpec";

const GrandWizardLlmTaskSchema = z.object({
  id: z.string().optional(),
  task: z.string(),
  files: z.array(z.string()).optional(),
  verification: z.string().optional(),
  decomposedFrom: z.array(z.string()).optional(),
});

const GrandWizardLlmDraftSchema = z.object({
  cycleTheme: z.string().optional(),
  primarySliceId: z.string().optional(),
  primarySlice: z
    .object({
      id: z.string().optional(),
      title: z.string(),
      userStory: z.string(),
      screens: z.array(z.string()).optional(),
      files: z.array(z.string()).optional(),
      tasks: z.array(GrandWizardLlmTaskSchema).min(1),
      outOfScope: z.array(z.string()).optional(),
    })
    .optional(),
  parentDirectives: z
    .array(
      z.object({
        id: z.string(),
        text: z.string(),
        source: z.string().optional(),
        childTaskIds: z.array(z.string()).default([]),
      }),
    )
    .optional(),
  deferred: z.array(z.string()).optional(),
  definitionOfDone: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
});

type ParentSource = ParentDirective["source"];

type DirectiveCandidate = {
  id: string;
  text: string;
  source: ParentSource;
  weight: number;
};

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
      ["-lc", command],
      { cwd, env: process.env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
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

function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function mintParentId(text: string, index: number): string {
  return `dir-${index + 1}-${slugifySliceId(text).slice(0, 24)}`;
}

function mintTaskId(parentId: string, sub: number): string {
  return `${parentId}.t${sub}`;
}

/** Maximum concrete tasks the wizard ships per cycle. Smaller slice → real one-pass closure. */
const MAX_TASKS_PER_SLICE = 4;

/**
 * Fuzzy match: returns true when `a` and `b` describe the same intent. Same
 * heuristic as the runner's directive gate (normalized prefix overlap + ≥3
 * distinctive content words with ≥40% overlap). Survives LLM rewordings and
 * synonym verb swaps that the fingerprint tokenizer can't always catch.
 */
function fuzzyDirectiveMatch(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (nb.includes(na.slice(0, 40)) || na.includes(nb.slice(0, 40))) return true;
  const aw = new Set(na.split(" ").filter((w) => w.length > 4));
  const bw = new Set(nb.split(" ").filter((w) => w.length > 4));
  let overlap = 0;
  for (const w of aw) if (bw.has(w)) overlap++;
  return overlap >= 3 && overlap / Math.max(1, aw.size) >= 0.4;
}

/**
 * Returns `{ covered: true }` when every directive in the current upstream
 * inputs already has a matching parent in the existing spec OR a matching
 * addressed-parent in the ledger. Lets the wizard skip the LLM when investors
 * just *reword* the same critique (the fingerprint alone can't catch synonym
 * verb swaps like "Remove" ⇄ "Delete" ⇄ "Drop").
 */
function checkDirectiveCoverage(
  input: StageInputComposition,
  existing: GrandWizardOutput,
  ledger: BuildSpecLedger,
): { covered: boolean; total: number; matched: number } {
  const { parents: currentParents } = collectParentDirectives(input);
  const candidates: string[] = [
    ...existing.parentDirectives.map((p) => p.text),
    ...Object.values(ledger.addressedParents ?? {}).map((p) => p.text),
  ];
  if (currentParents.length === 0) return { covered: false, total: 0, matched: 0 };
  let matched = 0;
  for (const parent of currentParents) {
    if (candidates.some((c) => fuzzyDirectiveMatch(parent.text, c))) matched++;
  }
  return { covered: matched === currentParents.length, total: currentParents.length, matched };
}

function upstreamFingerprintForInput(input: StageInputComposition): string {
  const cc = ConvergenceContractOutputSchema.safeParse(input.convergenceContract);
  const pd = ProductDefinitionOutputSchema.safeParse(input.productDefinition);
  const inv = InvestorPanelOutputSchema.safeParse(input.investorPanel);
  const fb = FeedbackAgentOutputSchema.safeParse(input.feedback);
  const builderDirectives = (input.config.project.builder?.directives ?? []).map((d) => {
    const files = (d.files ?? []).join(",");
    return `${d.action ?? "add"}:${d.description.trim()}:${files}`;
  });
  return computeUpstreamFingerprint({
    investorRefinementDirectives: input.investorRefinement?.directives ?? [],
    investorPanelDirectives: inv.success ? inv.data.combinedRefinementDirectives ?? [] : [],
    openObjections: cc.success
      ? cc.data.openObjections.filter((o) => o.status === "open" || o.status === "regressed").map((o) => o.objection)
      : [],
    mustShip: cc.success ? cc.data.mvpBoundary.mustShip : pd.success ? pd.data.scope.mustShip : [],
    feedbackHighlights: fb.success
      ? (fb.data.items ?? [])
          .filter((item) => item.status === "open" && item.shouldImplement)
          .map((item) => item.summary)
          .slice(0, 10)
      : [],
    builderDirectives,
  });
}

function resolveGrandWizardModel(input: StageInputComposition, tier: "primary" | "strict"): string {
  const raw = input.config.project.cursor_automation;
  if (tier === "strict") {
    return resolveFoundryCursorModel(
      raw?.grand_wizard_strict_model ?? raw?.qa_strict_model,
      "grandWizardStrictModel",
    );
  }
  return resolveFoundryCursorModel(raw?.grand_wizard_model, "grandWizardModel");
}

function countPrimarySliceTasks(output: GrandWizardOutput): number {
  return output.slices[0]?.tasks.length ?? 0;
}

function isProtectedProjectDirective(text: string, input: StageInputComposition): boolean {
  for (const d of input.config.project.builder?.directives ?? []) {
    const desc = d.description.trim();
    if (!desc) continue;
    if (fuzzyDirectiveMatch(text, desc)) return true;
    if (fuzzyDirectiveMatch(text, `[project] ${desc}`)) return true;
    if (d.action === "remove" && fuzzyDirectiveMatch(text, `Remove from user-facing surfaces: ${desc}`)) {
      return true;
    }
  }
  return false;
}

/** Deterministic fallback: turn project.yaml `builder.directives` into concrete BUILD_SPEC tasks. */
function synthesizeTasksFromBuilderDirectives(
  input: StageInputComposition,
  output: GrandWizardOutput,
  screens: Array<{ name: string; file: string }>,
): GrandWizardOutput {
  const directives = input.config.project.builder?.directives ?? [];
  if (directives.length === 0 || countPrimarySliceTasks(output) > 0) return output;

  const slice = output.slices[0]!;
  const tasks: ConcreteTask[] = [];
  const parentDirectives: ParentDirective[] = [...output.parentDirectives];

  for (const [index, directive] of directives.entries()) {
    if (tasks.length >= MAX_TASKS_PER_SLICE) break;
    const desc = directive.description.trim();
    if (!desc) continue;
    const parentId = `dir-yaml-${index + 1}`;
    const files =
      directive.files?.length > 0
        ? uniqueStrings(directive.files)
        : guessFilesForText(desc, screens);
    if (files.length === 0) continue;

    const taskText =
      directive.action === "remove"
        ? `Remove from user-facing screens: ${desc}. Done = surface deleted AND a test asserts absence (text/testID no longer present).`
        : desc;

    const taskId = mintTaskId(parentId, 1);
    tasks.push({
      id: taskId,
      task: taskText,
      files,
      verification:
        directive.action === "remove"
          ? `Automated test or Maestro flow asserts the removed surface is absent from ${files[0]}.`
          : `Behavior change observable in ${files[0]} and covered by repo tests.`,
      decomposedFrom: [parentId],
    });

    if (!parentDirectives.some((p) => p.id === parentId)) {
      parentDirectives.push({
        id: parentId,
        source: "project_directive",
        text: taskText,
        childTaskIds: [taskId],
      });
    } else {
      const idx = parentDirectives.findIndex((p) => p.id === parentId);
      if (idx >= 0) {
        parentDirectives[idx] = {
          ...parentDirectives[idx]!,
          childTaskIds: uniqueStrings([...parentDirectives[idx]!.childTaskIds, taskId]),
        };
      }
    }
  }

  if (tasks.length === 0) return output;

  return {
    ...output,
    source: output.source === "heuristic" ? "heuristic+yaml" : output.source,
    parentDirectives,
    slices: [
      {
        ...slice,
        tasks,
        files: uniqueStrings([...slice.files, ...tasks.flatMap((t) => t.files)]).slice(0, 12),
      },
    ],
    notes: uniqueStrings([
      ...output.notes,
      `Synthesized ${tasks.length} concrete task(s) from project.yaml builder.directives (deterministic fallback).`,
    ]),
    diagnostics: {
      ...output.diagnostics,
      directivesWithoutTasks: parentDirectives.filter((p) => p.childTaskIds.length === 0).map((p) => p.text),
    },
  };
}

function collectParentDirectives(input: StageInputComposition): {
  parents: DirectiveCandidate[];
  environmental: string[];
  screens: Array<{ name: string; file: string; purposeGuess?: string }>;
  oneLiner: string;
  mustShipFromContract: string[];
} {
  const cc = ConvergenceContractOutputSchema.safeParse(input.convergenceContract);
  const pd = ProductDefinitionOutputSchema.safeParse(input.productDefinition);
  const fb = FeedbackAgentOutputSchema.safeParse(input.feedback);
  const inv = InvestorPanelOutputSchema.safeParse(input.investorPanel);
  const audit = CurrentStateAuditOutputSchema.safeParse(input.currentStateAudit);

  const screens = (audit.success ? audit.data.screens : []) ?? [];
  const oneLiner = pd.success ? pd.data.oneLiner : cc.success ? cc.data.productThesis : "Product slice";
  const parents: DirectiveCandidate[] = [];
  const environmental: string[] = [];
  let counter = 0;

  const push = (text: string, weight: number, source: ParentSource) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (isEnvironmentalWorkItem(trimmed)) {
      environmental.push(trimmed);
      return;
    }
    parents.push({
      id: mintParentId(trimmed, counter++),
      text: trimmed,
      source,
      weight,
    });
  };

  if (input.investorRefinement?.directives?.length) {
    for (const d of input.investorRefinement.directives) push(d, 120, "investor_refinement");
  }
  if (inv.success) {
    for (const d of inv.data.combinedRefinementDirectives ?? []) push(d, 110, "investor_panel");
  }
  if (cc.success) {
    for (const o of cc.data.openObjections) {
      if (o.status === "open" || o.status === "regressed") {
        push(o.objection, 105, "open_objection");
      }
    }
    for (const item of cc.data.mvpBoundary.mustShip) push(item, 95, "convergence_must_ship");
  }
  if (pd.success) {
    for (const item of pd.data.scope.mustShip) push(item, 90, "product_must_ship");
  }
  if (fb.success) {
    for (const item of fb.data.items ?? []) {
      if (item.status !== "open" || !item.shouldImplement) continue;
      const weight = item.priority === "high" ? 100 : item.priority === "medium" ? 75 : 55;
      push(item.summary, weight, "feedback");
    }
  }

  for (const directive of input.config.project.builder?.directives ?? []) {
    const desc = directive.description.trim();
    if (!desc) continue;
    const filesNote = directive.files?.length
      ? ` — files: ${directive.files.map((f) => `\`${f}\``).join(", ")}`
      : "";
    const text =
      directive.action === "remove"
        ? `[project] Remove from user-facing surfaces: ${desc}${filesNote}`
        : `[project] ${desc}${filesNote}`;
    push(text, 130, "project_directive");
  }

  parents.sort((a, b) => b.weight - a.weight || a.text.localeCompare(b.text));

  const mustShipFromContract = cc.success
    ? cc.data.mvpBoundary.mustShip.slice(0, 6)
    : pd.success
      ? pd.data.scope.mustShip.slice(0, 6)
      : [];

  return { parents, environmental: uniqueStrings(environmental), screens, oneLiner, mustShipFromContract };
}

function guessFilesForText(
  text: string,
  screens: Array<{ name: string; file: string }>,
): string[] {
  const lower = text.toLowerCase();
  const codeFences = Array.from(text.matchAll(/`([^`]+)`/g)).map((m) => m[1]!);
  const fromText = codeFences
    .filter((s) => /\.(tsx?|jsx?|md|yaml|yml|sql|json|sh)$|\//.test(s))
    .slice(0, 4);
  const screenHits = screens
    .filter((s) => lower.includes(s.name.toLowerCase()) || lower.includes(s.file.toLowerCase()))
    .map((s) => s.file);
  return uniqueStrings([...fromText, ...screenHits]).slice(0, 6);
}

/**
 * Heuristic decomposer: when we cannot LLM-refine, try to derive at least one
 * concrete task per parent directive by referencing audit screens and known
 * must-ship items. Concrete = "Edit `Screen.tsx` to <verb>" with a verifiable
 * check.
 */
function heuristicDecompose(
  parents: DirectiveCandidate[],
  screens: Array<{ name: string; file: string; purposeGuess?: string }>,
): { tasks: ConcreteTask[]; uncovered: DirectiveCandidate[] } {
  const tasks: ConcreteTask[] = [];
  const uncovered: DirectiveCandidate[] = [];

  for (const parent of parents) {
    const inferredFiles = guessFilesForText(parent.text, screens);
    if (inferredFiles.length > 0 && !isVagueDirective(parent.text)) {
      tasks.push({
        id: mintTaskId(parent.id, 1),
        task: parent.text,
        files: inferredFiles,
        verification: `Implementation visible in ${inferredFiles[0]}; no regression in repo tests.`,
        decomposedFrom: [parent.id],
      });
      continue;
    }
    if (inferredFiles.length > 0) {
      tasks.push({
        id: mintTaskId(parent.id, 1),
        task: `Edit ${inferredFiles.map((f) => `\`${f}\``).join(", ")} to advance: ${parent.text}`,
        files: inferredFiles,
        verification: `Behavior change observable in ${inferredFiles[0]} and covered by a test under tests/ or __tests__/.`,
        decomposedFrom: [parent.id],
      });
      continue;
    }
    uncovered.push(parent);
  }

  return { tasks, uncovered };
}

function buildHeuristicSpec(input: StageInputComposition, ledger: BuildSpecLedger): GrandWizardOutput {
  const { parents, environmental, screens, oneLiner, mustShipFromContract } = collectParentDirectives(input);
  const notes: string[] = [];

  const addressedParentIds = new Set(Object.keys(ledger.addressedParents ?? {}));
  const addressedParentTextsRaw = Object.values(ledger.addressedParents ?? {}).map((p) => p.text);
  const addressedParentTexts = new Set(addressedParentTextsRaw.map((t) => t.trim().toLowerCase()));
  // Parents that failed to decompose for STUCK_DROP_THRESHOLD consecutive
  // cycles are permanently dropped. Without this, the heuristic emits the
  // same abstract directive every cycle ("Outcome visibility...",
  // "User-context data loop...") and the user sees `parents X/Y decomposed`
  // stuck at the same number forever.
  const droppedParentTextsRaw = Object.values(ledger.droppedParents ?? {}).map((p) => p.text);
  const incompleteParents = parents.filter((p) => {
    if (addressedParentIds.has(p.id)) return false;
    if (addressedParentTexts.has(p.text.trim().toLowerCase())) return false;
    // Fuzzy match against addressed parents — the upstream stages (investor,
    // feedback, convergence_contract) frequently reword the same directive
    // ("Remove" ⇄ "Delete" ⇄ "Drop"). Without fuzzy comparison, a reworded
    // version re-emits as a "new" parent every cycle, which is exactly what
    // the user reported as "build targets remain the same, reworded with
    // investor prefix".
    if (addressedParentTextsRaw.some((t) => fuzzyDirectiveMatch(p.text, t))) return false;
    // Likewise for permanently-dropped parents.
    if (droppedParentTextsRaw.some((t) => fuzzyDirectiveMatch(p.text, t))) return false;
    return !Object.keys(ledger.tasks).some((taskId) => taskId.startsWith(`${p.id}.`));
  });
  const topParents = (incompleteParents.length > 0 ? incompleteParents : parents).slice(0, MAX_TASKS_PER_SLICE);
  const { tasks: heuristicTasks, uncovered } = heuristicDecompose(topParents, screens);

  const cycleTheme =
    topParents[0]?.text.slice(0, 160) ??
    mustShipFromContract[0] ??
    oneLiner ??
    "Ship a vertical slice of the singular loop";

  const primaryId = slugifySliceId(cycleTheme);
  const primarySlice: BuildSpecSlice = {
    id: primaryId,
    title: cycleTheme.slice(0, 120),
    userStory: `As a user, I can experience a tightened version of: ${cycleTheme}`,
    screens: screens.slice(0, 4).map((s) => `${s.name} (\`${s.file}\`)`),
    files: uniqueStrings(heuristicTasks.flatMap((t) => t.files)).slice(0, 10),
    acceptance: heuristicTasks.length > 0 ? heuristicTasks.map((t) => t.task).slice(0, 6) : [cycleTheme],
    tasks: heuristicTasks,
    outOfScope: uniqueStrings([
      "Maestro/device-lab setup and EAS release plumbing",
      "Paywall/analytics wiring unless required by this slice",
      "Edge-function rate limits unless this slice touches an API",
      ...environmental.slice(0, 4),
    ]),
    investorAddresses: topParents
      .filter((p) => p.source === "investor_refinement" || p.source === "investor_panel" || p.source === "open_objection")
      .map((p) => p.text),
  };

  const parentDirectives: ParentDirective[] = topParents.map((p) => ({
    id: p.id,
    source: p.source,
    text: p.text,
    childTaskIds: heuristicTasks.filter((t) => t.decomposedFrom.includes(p.id)).map((t) => t.id),
  }));

  const deferred = uniqueStrings([
    ...parents.slice(MAX_TASKS_PER_SLICE).map((p) => p.text),
    ...environmental,
  ]).slice(0, 12);

  const definitionOfDone = uniqueStrings([
    "Every parent directive in `parentDirectives` has at least one concrete child task implemented in product code",
    "Acceptance for the primary slice is verifiable in repo tests or visible UI",
    "No new environmental/ops blockers introduced in the work packet",
    ...(input.investorRefinement?.directives?.length
      ? [`Investor refinement round ${input.investorRefinement.round} directives addressed via decomposed tasks`]
      : []),
  ]);

  if (uncovered.length > 0) {
    notes.push(
      `Heuristic could not anchor ${uncovered.length} directive(s) to code: ${uncovered.map((u) => u.id).join(", ")}. LLM decomposition recommended.`,
    );
  }
  if (environmental.length > 0) {
    notes.push(`Parked ${environmental.length} environmental/ops item(s) from this cycle.`);
  }

  return {
    cycleTheme,
    primarySliceId: primaryId,
    slices: [primarySlice],
    parentDirectives,
    deferred,
    definitionOfDone,
    source: "heuristic",
    notes,
    diagnostics: {
      vagueDirectivesParked: topParents.filter((p) => isVagueDirective(p.text)).map((p) => p.text),
      directivesWithoutTasks: uncovered.map((u) => u.text),
      tasksWithoutFiles: heuristicTasks.filter((t) => t.files.length === 0).map((t) => t.task),
    },
  };
}

function applyConcretenessFilter(spec: GrandWizardOutput): GrandWizardOutput {
  const slice = spec.slices[0]!;
  const concreteTasks = slice.tasks.filter(taskIsConcrete);
  const droppedTasks = slice.tasks.filter((t) => !taskIsConcrete(t));

  const childIds = new Set(concreteTasks.map((t) => t.id));
  const parentDirectives: ParentDirective[] = spec.parentDirectives.map((p) => ({
    ...p,
    childTaskIds: p.childTaskIds.filter((id) => childIds.has(id)),
  }));

  const directivesWithoutTasks = parentDirectives
    .filter((p) => p.childTaskIds.length === 0)
    .map((p) => p.text);

  const newSlice: BuildSpecSlice = {
    ...slice,
    tasks: concreteTasks,
    acceptance:
      concreteTasks.length > 0
        ? concreteTasks.map((t) => t.task).slice(0, 6)
        : slice.acceptance,
    files: uniqueStrings([...slice.files, ...concreteTasks.flatMap((t) => t.files)]).slice(0, 12),
  };

  const notes = uniqueStrings([
    ...spec.notes,
    ...(droppedTasks.length > 0
      ? [`Dropped ${droppedTasks.length} non-concrete task(s) (no file/code anchor): ${droppedTasks.map((t) => t.task.slice(0, 80)).join(" | ")}`]
      : []),
  ]);

  return {
    ...spec,
    slices: [newSlice],
    parentDirectives,
    notes,
    diagnostics: {
      vagueDirectivesParked: spec.diagnostics.vagueDirectivesParked,
      directivesWithoutTasks,
      tasksWithoutFiles: concreteTasks.filter((t) => t.files.length === 0).map((t) => t.task),
    },
  };
}

function mergeLlmDraft(
  heuristic: GrandWizardOutput,
  draft: z.infer<typeof GrandWizardLlmDraftSchema>,
): GrandWizardOutput {
  const heuristicPrimary = heuristic.slices[0]!;
  const llmPrimary = draft.primarySlice;

  const sanitizeId = (raw: string | undefined, fallbackParentId: string, idx: number): string => {
    const trimmed = (raw ?? "").trim();
    const looksLikeSentence = trimmed.length === 0 || trimmed.length > 48 || /\s/.test(trimmed) || /[,.;:!?]/.test(trimmed);
    if (looksLikeSentence) return mintTaskId(fallbackParentId, idx + 1);
    if (trimmed.startsWith("task-") || trimmed.startsWith("dir-")) return trimmed;
    return `task-${slugifySliceId(trimmed)}`;
  };

  const fallbackParentId = heuristic.parentDirectives[0]?.id ?? "dir";
  const tasks: ConcreteTask[] = (llmPrimary?.tasks ?? heuristicPrimary.tasks).map((t, i) => ({
    id: sanitizeId((t as { id?: string }).id, fallbackParentId, i),
    task: t.task.trim(),
    files: uniqueStrings(t.files ?? []),
    verification: (t.verification ?? "Verified by repo tests").trim(),
    decomposedFrom: uniqueStrings(t.decomposedFrom ?? []),
  }));

  const childIds = new Set(tasks.map((t) => t.id));
  const parentDirectives: ParentDirective[] = (draft.parentDirectives ?? heuristic.parentDirectives).map((p) => {
    const sourceRaw = (p as { source?: string }).source ?? "other";
    const allowed: ReadonlyArray<ParentDirective["source"]> = [
      "investor_refinement",
      "investor_panel",
      "open_objection",
      "convergence_must_ship",
      "product_must_ship",
      "feedback",
      "other",
    ];
    const source: ParentDirective["source"] = (allowed as readonly string[]).includes(sourceRaw)
      ? (sourceRaw as ParentDirective["source"])
      : "other";
    return {
      id: p.id,
      text: p.text,
      source,
      childTaskIds: ((p as { childTaskIds?: string[] }).childTaskIds ?? []).filter((id) => childIds.has(id)),
    };
  });

  const primarySlice: BuildSpecSlice = {
    id: llmPrimary?.id?.trim() || heuristicPrimary.id,
    title: llmPrimary?.title?.trim() || heuristicPrimary.title,
    userStory: llmPrimary?.userStory?.trim() || heuristicPrimary.userStory,
    screens: uniqueStrings(llmPrimary?.screens ?? heuristicPrimary.screens),
    files: uniqueStrings([...(llmPrimary?.files ?? []), ...tasks.flatMap((t) => t.files)]).slice(0, 12),
    acceptance: tasks.map((t) => t.task).slice(0, 6),
    tasks,
    outOfScope: uniqueStrings(llmPrimary?.outOfScope ?? heuristicPrimary.outOfScope),
    investorAddresses: heuristicPrimary.investorAddresses,
  };

  return applyConcretenessFilter({
    cycleTheme: draft.cycleTheme?.trim() || heuristic.cycleTheme,
    primarySliceId: primarySlice.id,
    slices: [primarySlice],
    parentDirectives,
    deferred: uniqueStrings(draft.deferred ?? heuristic.deferred).slice(0, 14),
    definitionOfDone: uniqueStrings(draft.definitionOfDone ?? heuristic.definitionOfDone).slice(0, 8),
    source: "heuristic+llm",
    notes: uniqueStrings([...heuristic.notes, ...(draft.notes ?? []), "LLM decomposition applied to heuristic draft."]),
    diagnostics: heuristic.diagnostics,
  });
}

function llmPrompt(
  input: StageInputComposition,
  heuristic: GrandWizardOutput,
  alreadyAddressed: ReadonlyArray<{ text: string; addressedAt?: string }>,
  mandatory = false,
): string {
  const yamlDirectives = input.config.project.builder?.directives ?? [];
  const yamlBlock =
    yamlDirectives.length > 0
      ? [
          "PROJECT.YAML BUILDER DIRECTIVES (highest priority — each MUST become ≥1 concrete task with listed files):",
          ...yamlDirectives.slice(0, 8).map((d, i) => {
            const files = d.files?.length ? d.files.join(", ") : "(infer from description)";
            return `${i + 1}. [${d.action ?? "add"}] ${d.description.replace(/\s+/g, " ").slice(0, 200)} → files: ${files}`;
          }),
          "",
        ].join("\n")
      : "";
  const addressedBlock =
    alreadyAddressed.length > 0
      ? [
          "PRIOR-CYCLES ADDRESSED DIRECTIVES — DO NOT RE-EMIT EQUIVALENTS:",
          "These directives were already resolved in earlier cycles (the relevant product code was edited and the parent was marked addressed in BUILD_SPEC_LEDGER.addressedParents). You MUST NOT create new tasks that re-do these same intents under reworded titles. If upstream directives sound similar (e.g. 'Replace X with Y' / 'Replace X with Z' / 'Remove X' / 'Delete X'), treat them as the SAME and DROP them — do not emit them as parents or tasks.",
          ...alreadyAddressed.slice(0, 20).map((p, i) => `${i + 1}. ${p.text.replace(/\s+/g, " ").slice(0, 220)}`),
          mandatory
            ? "Do NOT emit empty tasks[] while project.yaml builder.directives remain — decompose them even if some upstream items were addressed."
            : "If every current upstream directive matches an addressed one above, emit an EMPTY primarySlice.tasks (`tasks: []`) and explain in `notes`. Do NOT invent make-work to fill the slice.",
          "",
        ].join("\n")
      : mandatory
        ? "MANDATORY DECOMPOSITION: upstream produced zero concrete tasks. project.yaml builder.directives and/or open parent directives MUST each become ≥1 code-anchored task. Empty `tasks: []` is forbidden.\n"
        : "";
  return [
    "You are the Grand Wizard. Your job is to DECOMPOSE vague upstream directives into concrete, code-anchored engineering tasks for the next Cursor pass.",
    "",
    "HARD RULES:",
    "- Each task MUST reference at least one concrete file path (under apps/, packages/, src/, supabase/, etc.) when possible.",
    "- Each task MUST be verifiable: a test file, a UI behavior change, or a measurable command output.",
    "- Tasks MUST start with a concrete imperative verb: Remove, Add, Wire, Replace, Render, Fetch, Implement, Delete, Rename, Extract, Move.",
    "- DO NOT echo investor prose ('make X feel inevitable', 'tighten the narrative'). DECOMPOSE such directives into 1-3 concrete tasks each.",
    "- Each task's `decomposedFrom` array MUST list the parent directive IDs it helps satisfy.",
    "- Every parent directive must have at least one concrete child task. If a directive cannot be anchored, DROP it from `parentDirectives` and note that in `notes` (do NOT pass it through).",
    "- 3-7 concrete tasks total in the primary slice. No more.",
    "- Pick ONE specific 'act' / loop step when the directive says 'make one act feel inevitable'. Don't restate the directive — answer it (e.g. 'point camera at packaged food → scan UPC → render deterministic explanation').",
    "",
    yamlBlock,
    addressedBlock,
    "Output STRICT JSON, no markdown fences:",
    `{
  "cycleTheme": "string (concrete, code-anchored)",
  "primarySliceId": "string",
  "primarySlice": {
    "id": "string",
    "title": "string",
    "userStory": "string",
    "screens": ["string"],
    "files": ["string"],
    "tasks": [{"id":"string","task":"imperative+target","files":["path"],"verification":"how to test","decomposedFrom":["dir-id"]}],
    "outOfScope": ["string"]
  },
  "parentDirectives": [{"id":"string","source":"investor_refinement|investor_panel|open_objection|convergence_must_ship|product_must_ship|feedback|other","text":"string","childTaskIds":["task-id"]}],
  "deferred": ["string"],
  "definitionOfDone": ["string"],
  "notes": ["string"]
}`,
    "",
    "Heuristic draft (refine: keep the IDs, decompose vague text into concrete child tasks):",
    JSON.stringify(heuristic, null, 2),
    "",
    "Upstream context:",
    JSON.stringify(
      {
        investorRefinement: input.investorRefinement,
        convergenceContract: input.convergenceContract,
        productDefinition: input.productDefinition,
        feedback: input.feedback,
        investorPanel: input.investorPanel,
        currentStateAudit: input.currentStateAudit,
      },
      null,
      2,
    ).slice(0, 28_000),
  ].join("\n");
}

async function tryRunLlmGrandWizard(
  ctx: RunContext,
  input: StageInputComposition,
  heuristic: GrandWizardOutput,
  alreadyAddressed: ReadonlyArray<{ text: string; addressedAt?: string }>,
  modelOverride?: string,
  opts?: { mandatory?: boolean },
): Promise<GrandWizardOutput | undefined> {
  const command =
    input.config.project.cursor_automation?.command ?? process.env.FOUNDRY_CURSOR_AGENT_CMD ?? "agent";
  const model = modelOverride ?? resolveGrandWizardModel(input, "primary");
  const prompt = llmPrompt(input, heuristic, alreadyAddressed, opts?.mandatory);
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

  const result = await execShell(shellCommand, ctx.repoPath, 12 * 60_000);
  if (result.exitCode !== 0) {
    ctx.logger("[grand_wizard] llm unavailable; using heuristic", {
      command,
      model,
      stderr: result.stderr.slice(0, 400),
    });
    return undefined;
  }

  const raw = extractJsonObject(`${result.stdout}\n${result.stderr}`);
  if (!raw) {
    ctx.logger("[grand_wizard] llm parse failed; missing JSON", { model });
    return undefined;
  }

  try {
    const parsed = GrandWizardLlmDraftSchema.parse(JSON.parse(raw) as unknown);
    return mergeLlmDraft(heuristic, parsed);
  } catch (err) {
    ctx.logger("[grand_wizard] llm parse failed; invalid JSON shape", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

async function writeCanonicalBuildSpec(
  ctx: RunContext,
  spec: GrandWizardOutput,
  projectName: string,
): Promise<void> {
  const foundryDir = join(ctx.repoPath, ".foundry");
  await mkdir(foundryDir, { recursive: true });
  const json = JSON.stringify(spec, null, 2) + "\n";
  const md = renderBuildSpecMarkdown(spec, projectName);
  await writeFile(join(foundryDir, BUILD_SPEC_REL), json, "utf8");
  await writeFile(join(foundryDir, BUILD_SPEC_MD_REL), md, "utf8");
  await writeStageMarkdown(ctx, "grand_wizard", BUILD_SPEC_MD_REL, md);
}

async function readExistingBuildSpec(repoPath: string): Promise<GrandWizardOutput | undefined> {
  try {
    const raw = await readFile(join(repoPath, ".foundry", BUILD_SPEC_REL), "utf8");
    const parsed = GrandWizardOutputSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * When there is a previous spec at the same upstream fingerprint, carry forward the
 * incomplete tasks (so we don't burn LLM tokens regenerating the same intent). Only
 * regenerate when upstream changed (new investor round, new objections, new must-ship).
 */
function carryForwardIncompleteSpec(
  previous: GrandWizardOutput,
  ledger: BuildSpecLedger,
): GrandWizardOutput {
  const slice = previous.slices[0];
  if (!slice) return previous;
  const remainingTasks = slice.tasks.filter((t) => !(t.id in ledger.tasks));
  const completedTaskIds = slice.tasks.filter((t) => t.id in ledger.tasks).map((t) => t.id);
  const allDone = slice.tasks.length > 0 && remainingTasks.length === 0;
  const carryNotes = uniqueStringsLocal([
    ...previous.notes,
    allDone
      ? `Reused BUILD_SPEC (upstream unchanged); ALL ${completedTaskIds.length} task(s) already done: ${completedTaskIds.join(", ")}. Slice now empty — wizard will regenerate next cycle if new directives arrive.`
      : completedTaskIds.length > 0
        ? `Reused BUILD_SPEC (upstream unchanged); ${completedTaskIds.length} task(s) already done: ${completedTaskIds.join(", ")}`
        : "Reused BUILD_SPEC (upstream unchanged); no tasks completed yet.",
  ]);
  return {
    ...previous,
    source: "cached",
    slices: [
      {
        ...slice,
        // CRITICAL: when remainingTasks is empty, return an empty slice — do NOT
        // fall back to the full task list. The previous fallback caused closed
        // tasks to reappear as "open" in the work packet every cycle, which is
        // exactly the "build targets remain the same, reworded with prefix"
        // symptom: workPacket then prefixed acceptance with the slice title
        // (e.g. `[Prove the … loop] Delete …`) and the loop replayed the work.
        tasks: remainingTasks,
      },
    ],
    notes: carryNotes,
  };
}

function uniqueStringsLocal(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export const grandWizardStage: Stage<StageInputComposition, GrandWizardOutput> = {
  name: "grand_wizard",
  description:
    "Decompose investor directives, convergence objections, and feedback into concrete code-anchored tasks (BUILD_SPEC) for Cursor. Skips regen when upstream is unchanged; persists task completion across cycles via BUILD_SPEC_LEDGER.",
  inputSchema: StageInputCompositionSchema,
  outputSchema: GrandWizardOutputSchema,
  async run(ctx: RunContext, input: StageInputComposition): Promise<GrandWizardOutput> {
    const projectName = input.config.project.project_name;
    const upstreamFingerprint = upstreamFingerprintForInput(input);
    const ledger = await readBuildSpecLedger(ctx.repoPath);
    const existingSpec = await readExistingBuildSpec(ctx.repoPath);

    ctx.logger("[grand_wizard] consolidating build spec", {
      project: projectName,
      upstreamFingerprint,
      ledgerFingerprint: ledger.upstreamFingerprint,
      completedTasks: Object.keys(ledger.tasks).length,
    });

    const fingerprintMatches = ledger.upstreamFingerprint === upstreamFingerprint;
    const coverageReuse =
      !fingerprintMatches && existingSpec ? checkDirectiveCoverage(input, existingSpec, ledger) : { covered: false, total: 0, matched: 0 };
    const shouldReuse = (fingerprintMatches && existingSpec) || (coverageReuse.covered && !!existingSpec);

    if (shouldReuse && existingSpec) {
      const carry = carryForwardIncompleteSpec(existingSpec, ledger);

      // Even on the cached/reuse path, increment streaks for parents that
      // still have no child tasks. Otherwise a forever-undecomposed directive
      // sits in the spec across many cached cycles without ever triggering
      // the drop. Apply the same threshold check.
      const cachedStreak: Record<string, number> = { ...(ledger.undecomposedParentStreak ?? {}) };
      const cachedDropped: Record<string, BuildSpecLedger["droppedParents"][string]> = {
        ...(ledger.droppedParents ?? {}),
      };
      const cachedNewlyDropped: string[] = [];
      const survivingParents: ParentDirective[] = [];
      for (const p of carry.parentDirectives) {
        const key = droppedParentKey(p.text);
        if (isProtectedProjectDirective(p.text, input)) {
          survivingParents.push(p);
          delete cachedStreak[key];
          continue;
        }
        if (p.childTaskIds.length === 0) {
          const next = (cachedStreak[key] ?? 0) + 1;
          if (next >= STUCK_DROP_THRESHOLD) {
            cachedDropped[key] = {
              text: p.text,
              source: p.source,
              droppedAt: new Date().toISOString(),
              afterStreak: next,
            };
            delete cachedStreak[key];
            cachedNewlyDropped.push(p.text);
            // Drop this parent from the cached spec going forward.
            continue;
          }
          cachedStreak[key] = next;
        } else {
          delete cachedStreak[key];
        }
        survivingParents.push(p);
      }
      const carryWithDrops: GrandWizardOutput = cachedNewlyDropped.length > 0
        ? {
            ...carry,
            parentDirectives: survivingParents,
            notes: uniqueStringsLocal([
              ...carry.notes,
              `Dropped ${cachedNewlyDropped.length} parent directive(s) after ${STUCK_DROP_THRESHOLD} consecutive undecomposed cycle(s) (from cached spec).`,
            ]),
          }
        : carry;

      await writeCanonicalBuildSpec(ctx, carryWithDrops, projectName);
      await writeBuildSpecLedger(ctx.repoPath, {
        ...ledger,
        // Update fingerprint to the new upstream tokens so the next cycle
        // can short-circuit via the cheap fingerprint check instead of the
        // coverage scan.
        upstreamFingerprint,
        updatedAt: new Date().toISOString(),
        undecomposedParentStreak: cachedStreak,
        droppedParents: cachedDropped,
      });
      ctx.logger(
        fingerprintMatches
          ? "[grand_wizard] upstream unchanged — reused BUILD_SPEC, skipped LLM"
          : "[grand_wizard] upstream reworded but coverage-equivalent — reused BUILD_SPEC, skipped LLM",
        {
          fingerprintMatches,
          coverageReused: !fingerprintMatches,
          directivesMatched: coverageReuse.matched,
          directivesTotal: coverageReuse.total,
          completedTasks: Object.keys(ledger.tasks).length,
          remainingTasks: carryWithDrops.slices[0]?.tasks.length ?? 0,
          newlyDroppedParents: cachedNewlyDropped.length,
        },
      );
      return carryWithDrops;
    }

    const heuristicDraft = applyConcretenessFilter(buildHeuristicSpec(input, ledger));
    const addressedForPrompt = Object.values(ledger.addressedParents ?? {}).map((p) => ({
      text: p.text,
      addressedAt: p.addressedAt,
    }));
    const audit = CurrentStateAuditOutputSchema.safeParse(input.currentStateAudit);
    const screens = (audit.success ? audit.data.screens : []) ?? [];

    let llmRefined = await tryRunLlmGrandWizard(
      ctx,
      input,
      heuristicDraft,
      addressedForPrompt,
      resolveGrandWizardModel(input, "primary"),
    );
    let output = llmRefined ?? heuristicDraft;

    if (countPrimarySliceTasks(output) === 0) {
      output = synthesizeTasksFromBuilderDirectives(input, output, screens);
    }

    if (countPrimarySliceTasks(output) === 0) {
      const strictModel = resolveGrandWizardModel(input, "strict");
      ctx.logger("[grand_wizard] zero tasks after heuristic — retrying LLM decomposition", {
        primaryModel: resolveGrandWizardModel(input, "primary"),
        strictModel,
        builderDirectives: input.config.project.builder?.directives?.length ?? 0,
        undecomposedParents: output.diagnostics.directivesWithoutTasks.length,
      });
      const retry = await tryRunLlmGrandWizard(
        ctx,
        input,
        output,
        addressedForPrompt,
        strictModel,
        { mandatory: true },
      );
      if (retry) {
        output = retry;
        llmRefined = retry;
      }
    }

    if (countPrimarySliceTasks(output) === 0) {
      output = synthesizeTasksFromBuilderDirectives(input, output, screens);
    }

    if (
      countPrimarySliceTasks(output) === 0 &&
      (input.config.project.builder?.directives?.length ?? 0) > 0
    ) {
      output = {
        ...output,
        notes: uniqueStringsLocal([
          ...output.notes,
          "BLOCKING: Grand Wizard produced zero concrete tasks despite project.yaml builder.directives. Authenticate cursor-agent / set cursor_automation.command so LLM decomposition can run.",
        ]),
      };
    }

    if (Object.keys(ledger.tasks).length > 0) {
      const slice = output.slices[0]!;
      const filteredTasks = slice.tasks.filter((t) => !(t.id in ledger.tasks));
      const droppedIds = slice.tasks.filter((t) => t.id in ledger.tasks).map((t) => t.id);
      if (droppedIds.length > 0) {
        output = {
          ...output,
          // Always use the ledger-filtered task list. NEVER fall back to the
          // pre-filter `slice.tasks` — that re-emits closed tasks and is the
          // root cause of repeating "build targets" across cycles.
          slices: [{ ...slice, tasks: filteredTasks }],
          notes: uniqueStringsLocal([
            ...output.notes,
            `Dropped ${droppedIds.length} task(s) already complete in BUILD_SPEC_LEDGER: ${droppedIds.join(", ")}`,
          ]),
        };
      }
    }

    // Post-LLM hardening: even with the explicit "DO NOT RE-EMIT" prompt
    // section, the LLM occasionally returns parent directives whose text
    // is a slight rewording of an already-addressed parent. Apply the same
    // fuzzy filter we use heuristically so the work packet does not re-list
    // the same intent under a new title in cycle N+1.
    const addressedTexts = Object.values(ledger.addressedParents ?? {}).map((p) => p.text);
    if (addressedTexts.length > 0 && output.parentDirectives.length > 0) {
      const survivingParents = output.parentDirectives.filter(
        (p) => !addressedTexts.some((t) => fuzzyDirectiveMatch(p.text, t)),
      );
      const droppedParents = output.parentDirectives.length - survivingParents.length;
      if (droppedParents > 0) {
        const survivingIds = new Set(survivingParents.map((p) => p.id));
        const slice = output.slices[0]!;
        const survivingTasks = slice.tasks.filter((t) =>
          t.decomposedFrom.length === 0 ? true : t.decomposedFrom.some((id) => survivingIds.has(id)),
        );
        output = {
          ...output,
          parentDirectives: survivingParents,
          slices: [{ ...slice, tasks: survivingTasks }],
          notes: uniqueStringsLocal([
            ...output.notes,
            `Dropped ${droppedParents} parent directive(s) already addressed in prior cycles (fuzzy-text match against BUILD_SPEC_LEDGER.addressedParents).`,
          ]),
        };
      }
    }

    // Track per-parent undecomposed streak. A parent is "undecomposed" this
    // cycle when it appears in `parentDirectives` but has zero child tasks
    // (heuristic + LLM both failed to anchor it). After STUCK_DROP_THRESHOLD
    // consecutive cycles in that state, move it to droppedParents so the
    // wizard stops emitting it forever. Operator can revive with --reset-spec.
    const updatedStreak: Record<string, number> = { ...(ledger.undecomposedParentStreak ?? {}) };
    const updatedDropped: Record<string, BuildSpecLedger["droppedParents"][string]> = {
      ...(ledger.droppedParents ?? {}),
    };
    const newlyDropped: string[] = [];
    for (const p of output.parentDirectives) {
      const key = droppedParentKey(p.text);
      if (isProtectedProjectDirective(p.text, input)) {
        delete updatedStreak[key];
        continue;
      }
      if (p.childTaskIds.length === 0) {
        const next = (updatedStreak[key] ?? 0) + 1;
        if (next >= STUCK_DROP_THRESHOLD) {
          updatedDropped[key] = {
            text: p.text,
            source: p.source,
            droppedAt: new Date().toISOString(),
            afterStreak: next,
          };
          delete updatedStreak[key];
          newlyDropped.push(p.text);
        } else {
          updatedStreak[key] = next;
        }
      } else {
        // Parent got at least one child task this cycle — reset the streak.
        delete updatedStreak[key];
      }
    }
    if (newlyDropped.length > 0) {
      // Surface the drop in the wizard output notes so the operator sees
      // *why* a previously-listed parent disappeared.
      const droppedSample = newlyDropped.slice(0, 3).map((t) => `"${t.slice(0, 80)}${t.length > 80 ? "…" : ""}"`).join("; ");
      const moreSuffix = newlyDropped.length > 3 ? ` (+${newlyDropped.length - 3} more)` : "";
      output = {
        ...output,
        notes: uniqueStringsLocal([
          ...output.notes,
          `Dropped ${newlyDropped.length} parent directive(s) after ${STUCK_DROP_THRESHOLD} consecutive undecomposed cycle(s): ${droppedSample}${moreSuffix}. Re-add via project.yaml \`builder.directives\` or rerun with \`--reset-spec\` to clear the dropped list.`,
        ]),
      };
    }

    await writeCanonicalBuildSpec(ctx, output, projectName);
    await writeBuildSpecLedger(ctx.repoPath, {
      ...ledger,
      updatedAt: new Date().toISOString(),
      upstreamFingerprint,
      stuckCycles: fingerprintMatches ? ledger.stuckCycles + 1 : 0,
      undecomposedParentStreak: updatedStreak,
      droppedParents: updatedDropped,
    });

    const slice = output.slices[0]!;
    ctx.logger("[grand_wizard] wrote BUILD_SPEC", {
      primarySliceId: output.primarySliceId,
      tasks: slice.tasks.length,
      parentDirectives: output.parentDirectives.length,
      directivesWithoutTasks: output.diagnostics.directivesWithoutTasks.length,
      tasksWithoutFiles: output.diagnostics.tasksWithoutFiles.length,
      source: output.source,
      upstreamFingerprint,
      newlyDroppedParents: newlyDropped.length,
      totalDroppedParents: Object.keys(updatedDropped).length,
    });

    return output;
  },
};
