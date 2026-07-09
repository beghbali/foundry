import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
export const BuildSpecLedgerSchema = z.object({
    version: z.literal(1),
    updatedAt: z.string(),
    /** Fingerprint of upstream pipeline state that produced the active BUILD_SPEC. */
    upstreamFingerprint: z.string(),
    /** Persisted task completion across cycles. Keyed by stable task ID. */
    tasks: z.record(z.string(), z.object({
        completedAt: z.string(),
        /** Run ID where this task was first marked complete. */
        runId: z.string().optional(),
        /** Files touched when task was completed. */
        filesTouched: z.array(z.string()).default([]),
        /** Cumulative LOC delta across all completing edits. */
        locAdded: z.number().int().default(0),
        locRemoved: z.number().int().default(0),
    })),
    /** Cycles where this fingerprint produced no net progress (used to escalate / kick wizard). */
    stuckCycles: z.number().int().min(0).default(0),
    /**
     * Parent directives (raw investor/contract feedback text) that have been
     * fully addressed: every decomposed child task closed. Wizard uses this to
     * stop re-emitting work the repo has already absorbed.
     */
    addressedParents: z
        .record(z.string(), z.object({
        text: z.string(),
        source: z.string(),
        addressedAt: z.string(),
    }))
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
        .record(z.string(), z.object({
        text: z.string(),
        source: z.string(),
        droppedAt: z.string(),
        afterStreak: z.number().int().min(1),
    }))
        .default({}),
});
export function emptyBuildSpecLedger() {
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
export function droppedParentKey(text) {
    return text.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 200);
}
/** Default consecutive-failures threshold after which a parent is dropped. */
export const STUCK_DROP_THRESHOLD = 2;
export async function readBuildSpecLedger(repoPath) {
    try {
        const raw = await readFile(join(repoPath, ".foundry", BUILD_SPEC_LEDGER_REL), "utf8");
        const parsed = BuildSpecLedgerSchema.safeParse(JSON.parse(raw));
        if (parsed.success)
            return parsed.data;
    }
    catch {
        /* missing or corrupt — start fresh */
    }
    return emptyBuildSpecLedger();
}
export async function writeBuildSpecLedger(repoPath, ledger) {
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
function directiveThemeToken(text) {
    const normalized = text
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9 ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!normalized)
        return "";
    const STOP = new Set([
        "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has", "have",
        "in", "into", "is", "it", "its", "of", "on", "or", "our", "out", "should", "so", "that",
        "the", "their", "them", "then", "they", "this", "to", "was", "we", "were", "will", "with",
        "your", "you", "make", "ship", "do", "i", "im", "ive", "isnt", "dont", "cant", "would",
        "could", "must", "need", "needs", "needed", "very", "really", "just", "more", "less",
        "not", "instead", "without", "such", "than", "also", "may", "might", "feel", "feels",
        "felt", "story", "narrative", "vibes", "story",
    ]);
    const stem = (w) => {
        // Conservative Porter-lite: peel one inflection layer so "widening" ⇄
        // "widen", "addresses" ⇄ "address", "removed" ⇄ "remov". Good enough to
        // collapse LLM tense/number shifts without merging unrelated tokens.
        if (w.length <= 4)
            return w;
        for (const suffix of ["ization", "ational", "tional", "ization", "izing", "ation", "tion", "ment", "ness", "able", "ible", "ings", "ing", "ies", "ied", "ers", "est", "ly", "ed", "es", "er", "s"]) {
            if (w.endsWith(suffix) && w.length - suffix.length >= 4) {
                return w.slice(0, w.length - suffix.length);
            }
        }
        return w;
    };
    const distinct = new Set();
    for (const raw of normalized.split(" ")) {
        if (raw.length <= 2)
            continue;
        if (STOP.has(raw))
            continue;
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
export function computeUpstreamFingerprint(input) {
    const tokens = (xs) => {
        if (!xs || xs.length === 0)
            return [];
        const out = new Set();
        for (const x of xs) {
            const t = directiveThemeToken(x);
            if (t)
                out.add(t);
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
export function taskCompletedByEdits(task, touchedFiles, options = {}) {
    if (task.files.length === 0)
        return false;
    const touchedSet = new Set(touchedFiles);
    if (options.strict) {
        return task.files.every((f) => touchedSet.has(f));
    }
    const anchor = task.files.find((f) => !/\.test\.(t|j)sx?$|__tests__/.test(f)) ?? task.files[0];
    if (anchor && touchedSet.has(anchor))
        return true;
    const touchedCount = task.files.filter((f) => touchedSet.has(f)).length;
    return touchedCount >= Math.ceil(task.files.length / 2);
}
/**
 * True when every child task of a parent directive has been closed in the
 * ledger. Used to permanently mark a parent directive as ADDRESSED so the
 * wizard can skip re-emitting it on subsequent cycles.
 */
export function parentDirectiveCompleted(parent, ledger) {
    if (parent.childTaskIds.length === 0)
        return false;
    return parent.childTaskIds.every((id) => id in ledger.tasks);
}
/**
 * Heuristic: a directive is "vague" when it lacks any concrete code anchor
 * (no file reference, no verb-with-target, no measurable outcome). Vague
 * directives must be DECOMPOSED into concrete tasks; otherwise the brief just
 * recycles investor prose every cycle.
 */
export function isVagueDirective(text) {
    const t = text.toLowerCase().trim();
    if (t.length < 12)
        return false;
    if (/`[^`]+`/.test(text))
        return false;
    if (/\.(tsx?|jsx?|md|yaml|yml|sql|json|sh)\b/.test(text))
        return false;
    const concreteVerbs = /\b(remove|delete|rename|extract|move|wire|implement|add (a |an |the )?(button|hook|test|screen|service|migration|component|column|field|api|endpoint|route|prop)|cap [\d]+|reduce.*to [\d]+|return\b|fetch\b|render\b|click on)\b/;
    if (concreteVerbs.test(t))
        return false;
    const vagueMarkers = /\b(feel|inevitable|narrative|story|the issue is|focus|ambition|vibes?|delight|invisible|memo|bet|tighten|reframe|crisp|narrow your scope|wedge|focused experience|polished)\b/;
    if (vagueMarkers.test(t))
        return true;
    if (/\b(make|ship|deliver|provide|enable|improve|enhance|create)\b/.test(t) && !/`/.test(text))
        return true;
    return false;
}
/** True when a concrete task has at least one file reference or backtick code anchor. */
export function taskIsConcrete(task) {
    if (task.files.length > 0)
        return true;
    if (/`[^`]+`/.test(task.task))
        return true;
    if (/\.(tsx?|jsx?|md|yaml|yml|sql|json|sh)\b/.test(task.task))
        return true;
    return !isVagueDirective(task.task);
}
/** Normalize directive/packet text for fuzzy overlap checks. */
export function normDirectiveText(s) {
    return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}
/** True when `directive` is recognizably represented in addressed parent/task texts. */
export function directiveMatchesAddressedText(directive, addressedTexts) {
    const a = normDirectiveText(directive);
    if (a.length === 0)
        return false;
    const aPrefix = a.slice(0, 40);
    const aWords = new Set(a.split(" ").filter((w) => w.length > 4));
    for (const p of addressedTexts) {
        const b = normDirectiveText(p);
        if (b.length === 0)
            continue;
        if (b.includes(aPrefix) || a.includes(b.slice(0, 40)))
            return true;
        const bWords = new Set(b.split(" ").filter((w) => w.length > 4));
        let overlap = 0;
        for (const w of aWords)
            if (bWords.has(w))
                overlap++;
        if (overlap >= 3 && overlap / Math.max(1, aWords.size) >= 0.4)
            return true;
    }
    return false;
}
/** Product file paths referenced in an investor/builder directive (for `[remove]` verification). */
export function extractRemovalTargetPaths(directive) {
    const paths = new Set();
    for (const m of directive.matchAll(/`?(apps\/[^\s`]+?\.(?:tsx?|jsx?))`?/gi)) {
        paths.add(m[1]);
    }
    for (const m of directive.matchAll(/\b(apps\/[^\s`]+?\.(?:tsx?|jsx?))\b/gi)) {
        paths.add(m[1]);
    }
    return [...paths];
}
export function collectBuildSpecAddressedTexts(spec, ledger) {
    const out = [];
    for (const p of Object.values(ledger.addressedParents ?? {})) {
        if (p.text?.trim())
            out.push(p.text);
    }
    if (spec) {
        for (const slice of spec.slices) {
            for (const task of slice.tasks) {
                if (task.id in ledger.tasks)
                    out.push(task.task);
            }
        }
        for (const parent of spec.parentDirectives) {
            if (parent.text?.trim())
                out.push(parent.text);
        }
    }
    return out;
}
/**
 * Whether an investor directive appears implemented: ledger/task fuzzy match,
 * or `[remove]` screen files absent on disk.
 */
export function investorDirectiveAppearsBuilt(directive, addressedTexts, repoPath) {
    if (/ScanScreen\.tsx/i.test(directive) &&
        (/pre-scan cards|firstScanPrimer|single priority selector|gc_scan_context_picker|gc_last_result_banner/i.test(directive))) {
        try {
            const raw = readFileSync(join(repoPath, "apps/mobile/src/screens/ScanScreen.tsx"), "utf8");
            if (raw.includes("gc_scan_gut_score_trend") || /gutScoreTrend|handleTrendPress/i.test(raw))
                return false;
            return true;
        }
        catch {
            return false;
        }
    }
    if (directiveMatchesAddressedText(directive, addressedTexts))
        return true;
    const removalPaths = extractRemovalTargetPaths(directive);
    const screenRemovals = removalPaths.filter((p) => /Screen\.tsx$/i.test(p));
    if (/^\[remove\]/i.test(directive.trim()) &&
        screenRemovals.length > 0 &&
        screenRemovals.every((rel) => !existsSync(join(repoPath, rel)))) {
        return true;
    }
    if (/gc_scan_gut_score_trend/i.test(directive)) {
        try {
            const raw = readFileSync(join(repoPath, "apps/mobile/src/screens/ScanScreen.tsx"), "utf8");
            if (!raw.includes("gc_scan_gut_score_trend"))
                return true;
        }
        catch {
            /* file missing */
        }
    }
    return false;
}
export function dedupeInvestorDirectives(directives) {
    const seen = new Set();
    const out = [];
    for (const d of directives) {
        const removalPaths = extractRemovalTargetPaths(d).sort().join("|");
        const key = removalPaths || normDirectiveText(d).slice(0, 72);
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(d);
    }
    return out;
}
export function filterUnbuiltInvestorDirectives(directives, addressedTexts, repoPath) {
    return dedupeInvestorDirectives(directives.filter((d) => !investorDirectiveAppearsBuilt(d, addressedTexts, repoPath)));
}
export async function reconcileInvestorDirectivesInLedger(repoPath) {
    let state;
    try {
        state = JSON.parse(await readFile(join(repoPath, ".foundry/INVESTOR_PANEL_STATE.json"), "utf8"));
    }
    catch {
        return [];
    }
    const directives = state.lastDirectives ?? [];
    if (directives.length === 0)
        return [];
    const spec = await readBuildSpecFromRepo(repoPath);
    const ledger = await readBuildSpecLedger(repoPath);
    const addressedTexts = collectBuildSpecAddressedTexts(spec, ledger);
    const addressedMap = { ...(ledger.addressedParents ?? {}) };
    const addressedValues = Object.values(addressedMap).map((p) => p.text);
    const newly = [];
    for (let i = 0; i < directives.length; i++) {
        const d = directives[i];
        if (directiveMatchesAddressedText(d, addressedValues))
            continue;
        if (!investorDirectiveAppearsBuilt(d, addressedTexts, repoPath))
            continue;
        const slug = normDirectiveText(d).slice(0, 28).replace(/\s+/g, "_") || `dir_${i}`;
        const id = `investor_reconcile_${i}_${slug}`;
        if (id in addressedMap)
            continue;
        addressedMap[id] = {
            text: d,
            source: "investor_panel",
            addressedAt: new Date().toISOString(),
        };
        newly.push(d.slice(0, 96));
    }
    if (newly.length > 0) {
        ledger.addressedParents = addressedMap;
        ledger.updatedAt = new Date().toISOString();
        await writeBuildSpecLedger(repoPath, ledger);
    }
    return newly;
}
/** Ops, device-lab, artifact, and infra noise — not product slices for Cursor. */
export function isEnvironmentalWorkItem(text) {
    const t = text.toLowerCase();
    return (/^automation_log:/.test(t.trim()) ||
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
        /boot an ios simulator/.test(t) ||
        /no booted simulator/.test(t) ||
        (/connect a device/.test(t) && /re-run/.test(t)) ||
        /environmental — not a code failure/.test(t) ||
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
        /not by product code/.test(t) ||
        /grand wizard upstream/.test(t) ||
        (/build_spec/.test(t) && /tasks\[\]/.test(t) && /empty/.test(t)) ||
        /mitigated in product/.test(t) ||
        /foundry loop --reset-spec/.test(t) ||
        /upstream llm decomposition/.test(t) ||
        /empty at source/.test(t) ||
        /\(informational\)/.test(t) ||
        /primarysliceanchors.*mitigat/.test(t) ||
        (/convergence-contract-sync/.test(t) && /contract (line|block|sync)/.test(t)) ||
        (/foundry-root-artifacts/.test(t) && /regression guard/.test(t)));
}
export function slugifySliceId(title) {
    return (title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "slice");
}
export function primaryBuildSpecSlice(spec) {
    return spec.slices.find((s) => s.id === spec.primarySliceId) ?? spec.slices[0];
}
export async function readBuildSpecFromRepo(repoPath) {
    try {
        const raw = await readFile(join(repoPath, ".foundry", BUILD_SPEC_REL), "utf8");
        const parsed = GrandWizardOutputSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : undefined;
    }
    catch {
        return undefined;
    }
}
export function renderBuildSpecMarkdown(spec, projectName) {
    const primary = primaryBuildSpecSlice(spec);
    const lines = [
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
    }
    else {
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
        for (const d of spec.diagnostics.directivesWithoutTasks)
            lines.push(`- ${d}`);
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
