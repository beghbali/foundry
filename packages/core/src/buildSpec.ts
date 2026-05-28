import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

export const BUILD_SPEC_REL = "BUILD_SPEC.json";
export const BUILD_SPEC_MD_REL = "BUILD_SPEC.md";
export const BUILD_SPEC_LEDGER_REL = "BUILD_SPEC_LEDGER.json";

export const ConcreteTaskSchema = z.object({
  id: z.string(),
  /** Concrete imperative — verb + target file/component + outcome. */
  task: z.string(),
  /** Files Cursor should edit (preferred over generic guidance). */
  files: z.array(z.string()).default([]),
  /** Verifiable test or check Cursor must satisfy. */
  verification: z.string(),
  /** IDs of parent directives this task helps complete. */
  decomposedFrom: z.array(z.string()).default([]),
});

export const ParentDirectiveSchema = z.object({
  id: z.string(),
  source: z.enum([
    "investor_refinement",
    "investor_panel",
    "open_objection",
    "convergence_must_ship",
    "product_must_ship",
    "feedback",
    "other",
  ]),
  /** Original (often vague) directive text. */
  text: z.string(),
  /** Task IDs that decompose this directive — directive is `done` when all are checked. */
  childTaskIds: z.array(z.string()).default([]),
});

export const BuildSpecSliceSchema = z.object({
  id: z.string(),
  title: z.string(),
  userStory: z.string(),
  screens: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  /** Legacy free-text acceptance criteria (kept for back-compat; prefer `tasks`). */
  acceptance: z.array(z.string()).min(1),
  /** Concrete decomposed tasks Cursor implements. Each is verifiable. */
  tasks: z.array(ConcreteTaskSchema).default([]),
  outOfScope: z.array(z.string()).default([]),
  investorAddresses: z.array(z.string()).default([]),
});

export const GrandWizardOutputSchema = z.object({
  cycleTheme: z.string(),
  primarySliceId: z.string(),
  slices: z.array(BuildSpecSliceSchema).min(1),
  /** Vague parent directives consolidated this cycle, with their child task IDs. */
  parentDirectives: z.array(ParentDirectiveSchema).default([]),
  deferred: z.array(z.string()).default([]),
  definitionOfDone: z.array(z.string()).default([]),
  source: z.enum(["heuristic", "llm", "heuristic+llm", "cached"]),
  notes: z.array(z.string()).default([]),
  /** Heuristic flags surfaced for the loop console (e.g. uncovered directives). */
  diagnostics: z
    .object({
      vagueDirectivesParked: z.array(z.string()).default([]),
      directivesWithoutTasks: z.array(z.string()).default([]),
      tasksWithoutFiles: z.array(z.string()).default([]),
    })
    .default({ vagueDirectivesParked: [], directivesWithoutTasks: [], tasksWithoutFiles: [] }),
});

export type BuildSpecSlice = z.infer<typeof BuildSpecSliceSchema>;
export type ConcreteTask = z.infer<typeof ConcreteTaskSchema>;
export type ParentDirective = z.infer<typeof ParentDirectiveSchema>;
export type GrandWizardOutput = z.infer<typeof GrandWizardOutputSchema>;

export const BuildSpecLedgerSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  /** Fingerprint of upstream pipeline state that produced the active BUILD_SPEC. */
  upstreamFingerprint: z.string(),
  /** Persisted task completion across cycles. Keyed by stable task ID. */
  tasks: z.record(
    z.string(),
    z.object({
      completedAt: z.string(),
      /** Run ID where this task was first marked complete. */
      runId: z.string().optional(),
      /** Files touched when task was completed. */
      filesTouched: z.array(z.string()).default([]),
      /** Cumulative LOC delta across all completing edits. */
      locAdded: z.number().int().default(0),
      locRemoved: z.number().int().default(0),
    }),
  ),
  /** Cycles where this fingerprint produced no net progress (used to escalate / kick wizard). */
  stuckCycles: z.number().int().min(0).default(0),
  /**
   * Parent directives (raw investor/contract feedback text) that have been
   * fully addressed: every decomposed child task closed. Wizard uses this to
   * stop re-emitting work the repo has already absorbed.
   */
  addressedParents: z
    .record(
      z.string(),
      z.object({
        text: z.string(),
        source: z.string(),
        addressedAt: z.string(),
      }),
    )
    .default({}),
  /**
   * Tracks each cycle in which a parent directive failed to decompose into any
   * concrete child task. After STUCK_DROP_THRESHOLD consecutive failures the
   * directive is moved into `droppedParents` and the wizard stops emitting it.
   * This prevents abstract directives ("Outcome visibility...", "User-context
   * data loop...") from blocking every cycle when neither the heuristic nor
   * the LLM can anchor them in a concrete file.
   *
   * Keyed by parent directive text (stable across runs since text is preserved
   * verbatim). Value is the count of consecutive undecomposed cycles.
   */
  undecomposedParentStreak: z.record(z.string(), z.number().int().min(0)).default({}),
  /**
   * Parents permanently dropped from re-emission because they failed to
   * decompose for N consecutive cycles. Operator can revive one with
   * `foundry loop --reset-spec` (clears the ledger) or by manually editing
   * BUILD_SPEC_LEDGER.json.
   */
  droppedParents: z
    .record(
      z.string(),
      z.object({
        text: z.string(),
        source: z.string(),
        droppedAt: z.string(),
        afterStreak: z.number().int().min(1),
      }),
    )
    .default({}),
});

export type BuildSpecLedger = z.infer<typeof BuildSpecLedgerSchema>;

export function emptyBuildSpecLedger(): BuildSpecLedger {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    upstreamFingerprint: "",
    tasks: {},
    stuckCycles: 0,
    addressedParents: {},
    undecomposedParentStreak: {},
    droppedParents: {},
  };
}

/** Stable key for a parent directive in the streak/dropped ledgers. Uses
 *  text rather than ID because IDs are regenerated each cycle (`p1`, `p2`),
 *  whereas text is preserved verbatim from the upstream stage. */
export function droppedParentKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 200);
}

/** Default consecutive-failures threshold after which a parent is dropped. */
export const STUCK_DROP_THRESHOLD = 2;

export async function readBuildSpecLedger(repoPath: string): Promise<BuildSpecLedger> {
  try {
    const raw = await readFile(join(repoPath, ".foundry", BUILD_SPEC_LEDGER_REL), "utf8");
    const parsed = BuildSpecLedgerSchema.safeParse(JSON.parse(raw) as unknown);
    if (parsed.success) return parsed.data;
  } catch {
    /* missing or corrupt — start fresh */
  }
  return emptyBuildSpecLedger();
}

export async function writeBuildSpecLedger(repoPath: string, ledger: BuildSpecLedger): Promise<void> {
  const abs = join(repoPath, ".foundry", BUILD_SPEC_LEDGER_REL);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify(ledger, null, 2) + "\n", "utf8");
}

/**
 * Reduce a directive sentence to a stable "theme token" so minor LLM rewordings
 * collapse to the same fingerprint. Strategy:
 *   1. Lowercase, strip punctuation/diacritics
 *   2. Drop stopwords and short particles
 *   3. Lightly stem suffixes ("widening" → "widen", "removed" → "remov")
 *   4. Take the top-3 longest distinct stemmed words, sort alphabetically
 *
 * Picking top-N longest words biases toward substantive nouns/verbs that
 * survive LLM rewordings (e.g. "inevitable", "scan-only", "history"), while
 * dropping the cycle-to-cycle filler ("the", "feel", "make", "tighten") that
 * would otherwise bust the cache. Two directives that mean the same thing
 * collapse to the same token; two that mean different things still differ.
 */
function directiveThemeToken(text: string): string {
  const normalized = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";

  const STOP = new Set([
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has", "have",
    "in", "into", "is", "it", "its", "of", "on", "or", "our", "out", "should", "so", "that",
    "the", "their", "them", "then", "they", "this", "to", "was", "we", "were", "will", "with",
    "your", "you", "make", "ship", "do", "i", "im", "ive", "isnt", "dont", "cant", "would",
    "could", "must", "need", "needs", "needed", "very", "really", "just", "more", "less",
    "not", "instead", "without", "such", "than", "also", "may", "might", "feel", "feels",
    "felt", "story", "narrative", "vibes", "story",
  ]);

  const stem = (w: string): string => {
    // Conservative Porter-lite: peel one inflection layer so "widening" ⇄
    // "widen", "addresses" ⇄ "address", "removed" ⇄ "remov". Good enough to
    // collapse LLM tense/number shifts without merging unrelated tokens.
    if (w.length <= 4) return w;
    for (const suffix of ["ization", "ational", "tional", "ization", "izing", "ation", "tion", "ment", "ness", "able", "ible", "ings", "ing", "ies", "ied", "ers", "est", "ly", "ed", "es", "er", "s"]) {
      if (w.endsWith(suffix) && w.length - suffix.length >= 4) {
        return w.slice(0, w.length - suffix.length);
      }
    }
    return w;
  };

  const distinct = new Set<string>();
  for (const raw of normalized.split(" ")) {
    if (raw.length <= 2) continue;
    if (STOP.has(raw)) continue;
    distinct.add(stem(raw));
  }

  return [...distinct]
    .sort((a, b) => (b.length - a.length) || a.localeCompare(b))
    .slice(0, 3)
    .sort()
    .join(" ");
}

/**
 * Hash the upstream pipeline state that should trigger a wizard regeneration.
 * When this fingerprint matches the previous run, the wizard reuses the existing
 * BUILD_SPEC instead of burning ~3min of LLM tokens to produce a near-identical spec.
 *
 * Uses **directive themes** (slugified content words) rather than verbatim text
 * so investor/feedback rewordings don't bust the cache cycle after cycle. Two
 * directives that mean the same thing share a fingerprint; two that mean
 * different things don't.
 */
export function computeUpstreamFingerprint(input: {
  investorRefinementDirectives?: string[];
  investorPanelDirectives?: string[];
  openObjections?: string[];
  mustShip?: string[];
  feedbackHighlights?: string[];
}): string {
  const tokens = (xs: string[] | undefined): string[] => {
    if (!xs || xs.length === 0) return [];
    const out = new Set<string>();
    for (const x of xs) {
      const t = directiveThemeToken(x);
      if (t) out.add(t);
    }
    return [...out].sort();
  };
  const payload = JSON.stringify({
    ir: tokens(input.investorRefinementDirectives),
    ip: tokens(input.investorPanelDirectives),
    oo: tokens(input.openObjections),
    ms: tokens(input.mustShip),
    fb: tokens(input.feedbackHighlights),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/**
 * Returns true when the task is satisfied by the set of files just edited.
 *
 * Strict mode (all files must be touched): historically required every
 * `task.files[]` to appear in `touchedFiles`. This proved too strict in
 * practice — Cursor often closes a task by editing the primary file plus a
 * test, but skips secondary files the wizard listed for context. That left
 * tasks open forever and forced the ledger to re-emit them with fresh IDs.
 *
 * Relaxed mode (default): consider a task complete when an "anchor" file is
 * touched. The anchor is the first non-test file (or first file if all are
 * tests). This unblocks ledger progress without losing intent — operators
 * still see the task in `BUILD_SPEC` and can re-open it if the work was
 * incomplete.
 */
export function taskCompletedByEdits(
  task: ConcreteTask,
  touchedFiles: ReadonlyArray<string>,
  options: { strict?: boolean } = {},
): boolean {
  if (task.files.length === 0) return false;
  const touchedSet = new Set(touchedFiles);
  if (options.strict) {
    return task.files.every((f) => touchedSet.has(f));
  }
  const anchor = task.files.find((f) => !/\.test\.(t|j)sx?$|__tests__/.test(f)) ?? task.files[0];
  if (anchor && touchedSet.has(anchor)) return true;
  const touchedCount = task.files.filter((f) => touchedSet.has(f)).length;
  return touchedCount >= Math.ceil(task.files.length / 2);
}

/**
 * True when every child task of a parent directive has been closed in the
 * ledger. Used to permanently mark a parent directive as ADDRESSED so the
 * wizard can skip re-emitting it on subsequent cycles.
 */
export function parentDirectiveCompleted(
  parent: ParentDirective,
  ledger: BuildSpecLedger,
): boolean {
  if (parent.childTaskIds.length === 0) return false;
  return parent.childTaskIds.every((id) => id in ledger.tasks);
}

/**
 * Heuristic: a directive is "vague" when it lacks any concrete code anchor
 * (no file reference, no verb-with-target, no measurable outcome). Vague
 * directives must be DECOMPOSED into concrete tasks; otherwise the brief just
 * recycles investor prose every cycle.
 */
export function isVagueDirective(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (t.length < 12) return false;
  if (/`[^`]+`/.test(text)) return false;
  if (/\.(tsx?|jsx?|md|yaml|yml|sql|json|sh)\b/.test(text)) return false;
  const concreteVerbs =
    /\b(remove|delete|rename|extract|move|wire|implement|add (a |an |the )?(button|hook|test|screen|service|migration|component|column|field|api|endpoint|route|prop)|cap [\d]+|reduce.*to [\d]+|return\b|fetch\b|render\b|click on)\b/;
  if (concreteVerbs.test(t)) return false;
  const vagueMarkers =
    /\b(feel|inevitable|narrative|story|the issue is|focus|ambition|vibes?|delight|invisible|memo|bet|tighten|reframe|crisp|narrow your scope|wedge|focused experience|polished)\b/;
  if (vagueMarkers.test(t)) return true;
  if (/\b(make|ship|deliver|provide|enable|improve|enhance|create)\b/.test(t) && !/`/.test(text)) return true;
  return false;
}

/** True when a concrete task has at least one file reference or backtick code anchor. */
export function taskIsConcrete(task: ConcreteTask): boolean {
  if (task.files.length > 0) return true;
  if (/`[^`]+`/.test(task.task)) return true;
  if (/\.(tsx?|jsx?|md|yaml|yml|sql|json|sh)\b/.test(task.task)) return true;
  return !isVagueDirective(task.task);
}

/** Ops, device-lab, artifact, and infra noise — not product slices for Cursor. */
export function isEnvironmentalWorkItem(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /^automation_log:/.test(t.trim()) ||
    /\bbuilder\.log\b/.test(t) ||
    /\[process-error\]/.test(t) ||
    /connection lost.*reconnecting/.test(t) ||
    /physical hardware capture/.test(t) ||
    /\bcold scans? on target hardware\b/.test(t) ||
    /device benchmark json from account after/.test(t) ||
    /investors must (still )?run \d+\+ cold scans/.test(t) ||
    /\bmaestro\b/.test(t) ||
    /\bsimctl\b/.test(t) ||
    /coresimulator/.test(t) ||
    /provisioning profile/.test(t) ||
    /\baps-environment\b/.test(t) ||
    /\beas\b/.test(t) ||
    /artifact availability/.test(t) ||
    /pipeline artifact gap/.test(t) ||
    /missing foundry inputs/.test(t) ||
    /large[_ -]?files?/.test(t) ||
    /current_state_audit\/output\.json/.test(t) ||
    /shell_session_update/.test(t) ||
    /playwright chromium/.test(t) ||
    /repository-wide hygiene/.test(t) ||
    /external to the repository/.test(t) ||
    /not by product code/.test(t)
  );
}

export function slugifySliceId(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "slice"
  );
}

export function primaryBuildSpecSlice(spec: GrandWizardOutput): BuildSpecSlice {
  return spec.slices.find((s) => s.id === spec.primarySliceId) ?? spec.slices[0]!;
}

export async function readBuildSpecFromRepo(repoPath: string): Promise<GrandWizardOutput | undefined> {
  try {
    const raw = await readFile(join(repoPath, ".foundry", BUILD_SPEC_REL), "utf8");
    const parsed = GrandWizardOutputSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function renderBuildSpecMarkdown(spec: GrandWizardOutput, projectName: string): string {
  const primary = primaryBuildSpecSlice(spec);
  const lines: string[] = [
    `# Build Spec — ${projectName}`,
    "",
    `**Cycle theme:** ${spec.cycleTheme}`,
    "",
    `**Primary slice:** \`${primary.id}\` — ${primary.title}`,
    "",
    "## Primary slice",
    "",
    `**User story:** ${primary.userStory}`,
    "",
  ];

  if (primary.screens.length > 0) {
    lines.push("**Screens:**", ...primary.screens.map((s) => `- ${s}`), "");
  }
  if (primary.files.length > 0) {
    lines.push("**Files:**", ...primary.files.map((f) => `- \`${f}\``), "");
  }

  if (primary.tasks.length > 0) {
    lines.push("**Concrete tasks (decomposed from directives):**", "");
    for (const task of primary.tasks) {
      lines.push(`- **${task.id}** — ${task.task}`);
      if (task.files.length > 0) {
        lines.push(`  - files: ${task.files.map((f) => `\`${f}\``).join(", ")}`);
      }
      lines.push(`  - verify: ${task.verification}`);
      if (task.decomposedFrom.length > 0) {
        lines.push(`  - addresses: ${task.decomposedFrom.join(", ")}`);
      }
    }
    lines.push("");
  } else {
    lines.push("**Acceptance:**", ...primary.acceptance.map((a) => `- ${a}`), "");
  }

  if (spec.parentDirectives.length > 0) {
    lines.push("## Parent directives (this cycle)", "", "Each is satisfied when its child tasks are all complete.", "");
    for (const p of spec.parentDirectives) {
      const childList = p.childTaskIds.length > 0 ? p.childTaskIds.join(", ") : "_no children — needs decomposition_";
      lines.push(`- **${p.id}** (${p.source}) — ${p.text}`);
      lines.push(`  - children: ${childList}`);
    }
    lines.push("");
  }

  if (spec.diagnostics.directivesWithoutTasks.length > 0) {
    lines.push("## Diagnostics", "");
    lines.push("Directives that did NOT decompose into concrete tasks (the wizard could not anchor them in code):", "");
    for (const d of spec.diagnostics.directivesWithoutTasks) lines.push(`- ${d}`);
    lines.push("");
    lines.push("These are parked in `notes`; rerun with `foundry loop --reset-spec` after refining upstream stages, or write a project directive (`builder.directives` in project.yaml) to anchor them.", "");
  }

  if (primary.outOfScope.length > 0) {
    lines.push("**Out of scope (this cycle):**", ...primary.outOfScope.map((o) => `- ${o}`), "");
  }
  if (primary.investorAddresses.length > 0) {
    lines.push("**Investor objections addressed:**", ...primary.investorAddresses.map((d) => `- ${d}`), "");
  }

  const secondary = spec.slices.filter((s) => s.id !== primary.id);
  if (secondary.length > 0) {
    lines.push("## Secondary slices (defer unless primary is done)", "");
    for (const slice of secondary) {
      lines.push(`### ${slice.title}`, "", slice.userStory, "");
    }
  }

  if (spec.deferred.length > 0) {
    lines.push("## Deferred", "", ...spec.deferred.map((d) => `- ${d}`), "");
  }

  if (spec.definitionOfDone.length > 0) {
    lines.push("## Definition of done", "", ...spec.definitionOfDone.map((d) => `- ${d}`), "");
  }

  if (spec.notes.length > 0) {
    lines.push("## Notes", "", ...spec.notes.map((n) => `- ${n}`), "");
  }

  return lines.join("\n");
}
