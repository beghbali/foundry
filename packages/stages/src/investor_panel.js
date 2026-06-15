import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { writeStageMarkdown } from "@foundry/core/artifacts";
import { readBuildSpecFromRepo, readBuildSpecLedger } from "@foundry/core/buildSpec";
const execFileAsync = promisify(execFile);
const INVESTOR_PANEL_STATE_REL = ".foundry/INVESTOR_PANEL_STATE.json";
async function readInvestorPanelState(repoPath) {
    try {
        const raw = await readFile(join(repoPath, INVESTOR_PANEL_STATE_REL), "utf8");
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
async function writeInvestorPanelState(repoPath, state) {
    await writeFile(join(repoPath, INVESTOR_PANEL_STATE_REL), JSON.stringify(state, null, 2) + "\n", "utf8");
}
async function gitHeadSha(repoPath) {
    try {
        const { stdout } = await execFileAsync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" });
        return stdout.trim();
    }
    catch {
        return "";
    }
}
async function gitDiffStatSinceSha(repoPath, sinceSha) {
    if (!sinceSha)
        return { filesChanged: 0, insertions: 0, deletions: 0, topFiles: [], commitCount: 0 };
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
    }
    catch {
        return { filesChanged: 0, insertions: 0, deletions: 0, topFiles: [], commitCount: 0 };
    }
}
async function buildSinceLastPitchSection(repoPath) {
    const state = await readInvestorPanelState(repoPath);
    const head = await gitHeadSha(repoPath);
    const spec = await readBuildSpecFromRepo(repoPath);
    const ledger = await readBuildSpecLedger(repoPath);
    const completedTaskIds = Object.keys(ledger.tasks);
    const newlyCompleted = state?.lastCompletedTaskIds
        ? completedTaskIds.filter((id) => !state.lastCompletedTaskIds.includes(id))
        : completedTaskIds;
    const lines = ["", "**SHIPPED SINCE LAST PITCH (grade the delta, not just the elevator):**"];
    if (!state) {
        lines.push("- First pitch this run — no prior baseline to diff against.");
    }
    else {
        const diff = await gitDiffStatSinceSha(repoPath, state.lastHeadSha);
        lines.push(`- Commits: ${diff.commitCount}, files: ${diff.filesChanged}, +${diff.insertions}/-${diff.deletions} LOC since previous pitch (last pitched ${state.lastPitchAt}).`);
        if (diff.topFiles.length > 0) {
            lines.push(`- Largest product edits: ${diff.topFiles.map((f) => `\`${f}\``).join(", ")}.`);
        }
        if (state.lastGrades) {
            const prev = Object.entries(state.lastGrades).map(([k, v]) => `${k}=${v}`).join(", ");
            lines.push(`- Previous grades: ${prev}. Grades should move when shipped work addresses prior directives.`);
        }
    }
    if (newlyCompleted.length > 0) {
        lines.push("- Concrete task IDs completed (from BUILD_SPEC_LEDGER):");
        for (const id of newlyCompleted.slice(0, 8)) {
            const task = spec?.slices[0]?.tasks.find((t) => t.id === id);
            if (task) {
                lines.push(`  - **${id}**: ${task.task} (verify: ${task.verification})`);
            }
            else {
                const ledgerEntry = ledger.tasks[id];
                const filesNote = ledgerEntry && ledgerEntry.filesTouched.length > 0 ? ` files: ${ledgerEntry.filesTouched.slice(0, 3).join(", ")}` : "";
                lines.push(`  - **${id}**${filesNote}`);
            }
        }
    }
    if (spec) {
        const slice = spec.slices[0];
        const openTasks = slice?.tasks.filter((t) => !(t.id in ledger.tasks)) ?? [];
        if (openTasks.length > 0) {
            lines.push(`- Still open this cycle (${openTasks.length}): ${openTasks.map((t) => t.id).slice(0, 6).join(", ")}.`);
        }
        if (spec.parentDirectives.length > 0) {
            const addressedParents = spec.parentDirectives.filter((p) => p.childTaskIds.length > 0 && p.childTaskIds.every((cid) => cid in ledger.tasks));
            if (addressedParents.length > 0) {
                lines.push(`- Parent directives now ADDRESSED in code (grade these up): ${addressedParents.map((p) => `"${p.text.slice(0, 80)}"`).join("; ")}.`);
            }
        }
    }
    if (head) {
        lines.push(`- Current HEAD: \`${head.slice(0, 8)}\`.`);
    }
    return lines.join("\n");
}
export async function recordInvestorPanelPitched(repoPath, grades, directives, averageRank) {
    const head = await gitHeadSha(repoPath);
    const ledger = await readBuildSpecLedger(repoPath);
    await writeInvestorPanelState(repoPath, {
        lastPitchAt: new Date().toISOString(),
        lastHeadSha: head,
        lastCompletedTaskIds: Object.keys(ledger.tasks),
        lastGrades: grades,
        lastDirectives: [...directives],
        lastAverageRank: averageRank,
    });
}
/**
 * Fuzzy match: returns true if `directive` text is recognizably represented in
 * the ledger's addressed parent directives. Uses normalized prefix + a couple
 * of distinctive content words to avoid the LLM rewording a directive past us.
 */
function directiveMatchesAddressedParent(directive, addressedTexts) {
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    const a = norm(directive);
    if (a.length === 0)
        return false;
    const aPrefix = a.slice(0, 40);
    const aWords = new Set(a.split(" ").filter((w) => w.length > 4));
    for (const p of addressedTexts) {
        const b = norm(p);
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
/**
 * Inspect whether a re-pitch is justified given the previous pitch's
 * directives and the BUILD_SPEC_LEDGER. Returns an array of directives that
 * have not yet been addressed in code. Empty array ⇒ safe to re-pitch.
 *
 * Exposed for the loop runner's investor-panel gate.
 */
export async function unaddressedDirectivesSinceLastPitch(repoPath) {
    const state = await readInvestorPanelState(repoPath);
    if (!state || !state.lastDirectives || state.lastDirectives.length === 0)
        return [];
    const ledger = await readBuildSpecLedger(repoPath);
    const addressedTexts = Object.values(ledger.addressedParents ?? {}).map((p) => p.text);
    return state.lastDirectives.filter((d) => !directiveMatchesAddressedParent(d, addressedTexts));
}
import { INVESTOR_GRADE_ORDER, INVESTOR_ALL_A_MINUS_RANK, investorGradeRank, parseAutonomousInvestorConvergence, computeInvestorTargetFields, } from "@foundry/core/investorGrades";
import { domainSummaryLine, getDomainKeyUserActions, getDomainNonGoals, getDomainPersonas, getDomainPrimaryMetric, getDomainSuccessExamples, getDomainVocabulary, hasDomain, } from "@foundry/core/projectDomain";
import { StageInputCompositionSchema } from "@foundry/core/stageInputs";
import { z } from "zod";
import { ConvergenceContractOutputSchema } from "./convergence_contract.js";
import { ProductDefinitionOutputSchema } from "./product_definition.js";
import { MonetizationOutputSchema } from "./monetization_architect.js";
import { FlywheelOutputSchema } from "./flywheel_designer.js";
import { MarketGapOutputSchema } from "./market_gap_analysis.js";
/** @deprecated Use INVESTOR_ALL_A_MINUS_RANK from `@foundry/core/investorGrades`. */
export const INVESTOR_MIN_RANK = INVESTOR_ALL_A_MINUS_RANK;
const GradeZod = z.enum([...INVESTOR_GRADE_ORDER]);
const PersonaSchema = z.object({
    id: z.enum(["elon_musk", "steve_jobs", "andreessen_horowitz"]),
    displayName: z.string(),
    grade: GradeZod,
    response: z.string(),
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
    combinedRefinementDirectives: z.array(z.string()),
    refinementRound: z.number().int().min(0),
});
const InvestorPanelLlmDraftSchema = z.object({
    pitchBrief: z.string().optional(),
    investors: z.array(PersonaSchema).length(3),
    combinedRefinementDirectives: z.array(z.string()).optional(),
});
function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}
function extractSignals(input) {
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
    const ambition = fly.success && fly.data.flywheel[0]
        ? clamp(40 + fly.data.flywheel[0].steps.length * 6 + (input.config.project.north_star?.length ?? 0) / 5, 30, 95)
        : 45;
    const simplicity = clamp(75 -
        mustN * 4 -
        wontN * 2 +
        (pd.success && pd.data.coreWorkflows.length <= 2 ? 10 : 0) +
        singularLoopBonus +
        convergedBonus -
        openObjectionPenalty, 25, 92);
    const monetization = mon.success
        ? clamp(35 +
            (mon.data.pricing.monthlyUsd > 0 ? 15 : 0) +
            mon.data.gates.length * 8 +
            mon.data.analyticsEvents.length * 3 +
            (mon.data.pricing.trialDays && mon.data.pricing.trialDays > 0 ? 8 : 0), 28, 96)
        : 30;
    const differentiation = clamp(40 +
        (input.config.project.core_differentiators?.length ?? 0) * 10 +
        (gap.success ? gap.data.gapsToExploit.length * 5 : 0), 25, 94);
    const metricsAlignment = clamp(35 + (input.config.metrics?.metrics?.length ?? 0) * 8 + (fly.success ? 12 : 0), 28, 93);
    return { clarity, ambition, simplicity, monetization, differentiation, metricsAlignment };
}
function scoreToGrade(score) {
    if (score < 18)
        return "F";
    if (score < 28)
        return "D";
    if (score < 38)
        return "C";
    if (score < 45)
        return "C-";
    if (score < 52)
        return "C+";
    if (score < 58)
        return "B-";
    if (score < 66)
        return "B";
    if (score < 74)
        return "B+";
    if (score < 82)
        return "A-";
    if (score < 90)
        return "A";
    return "A+";
}
function elonScore(s) {
    return (s.ambition * 0.35 +
        s.metricsAlignment * 0.25 +
        s.clarity * 0.15 +
        s.monetization * 0.15 +
        s.differentiation * 0.1);
}
function jobsScore(s) {
    return (s.simplicity * 0.4 +
        s.clarity * 0.25 +
        s.differentiation * 0.2 +
        s.ambition * 0.15);
}
function a16zScore(s) {
    return (s.monetization * 0.35 +
        s.differentiation * 0.25 +
        s.clarity * 0.2 +
        s.metricsAlignment * 0.2);
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
async function buildPitchBrief(input, repoPath) {
    const sinceLastPitch = await buildSinceLastPitchSection(repoPath);
    return buildPitchBriefSync(input) + sinceLastPitch;
}
function buildPitchBriefSync(input) {
    const name = input.config.project.project_name;
    const ns = input.config.project.north_star;
    const pd = ProductDefinitionOutputSchema.safeParse(input.productDefinition);
    const mon = MonetizationOutputSchema.safeParse(input.monetizationConfig);
    const fly = FlywheelOutputSchema.safeParse(input.flywheel);
    const cc = ConvergenceContractOutputSchema.safeParse(input.convergenceContract);
    const builderEv = BuilderEvidenceSchema.safeParse(input.builder);
    const qaEv = QaEvidenceSchema.safeParse(input.independentQa);
    const lines = [`**${name}** — ${ns}`, ""];
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
        if (domainPrimary)
            lines.push(`- Primary moment: ${domainPrimary}`);
        if (personas.length > 0)
            lines.push(`- Personas: ${personas.join("; ")}`);
        if (actions.length > 0) {
            lines.push(`- Key ${vocab.noun}s the product must support:`);
            for (const a of actions.slice(0, 6))
                lines.push(`  - ${a}`);
        }
        if (examples.length > 0) {
            lines.push("- Success examples (these are the demos to grade against):");
            for (const e of examples.slice(0, 6))
                lines.push(`  - ${e}`);
        }
        if (nonGoals.length > 0)
            lines.push(`- Out of scope: ${nonGoals.join("; ")}`);
        if (metric)
            lines.push(`- Primary metric: ${metric}`);
        lines.push("");
    }
    // Convergence contract supplies the elevator + loop when present (single source of truth);
    // we deliberately omit parked features so the pitch can't leak deferred surface area.
    if (cc.success) {
        lines.push(`**Elevator:** ${cc.data.productThesis}`, `**Target user:** ${cc.data.targetUser}`, `**Singular loop:** ${cc.data.singularLoop.name} → metric \`${cc.data.singularLoop.northStarMetric.key}\` (target: ${cc.data.singularLoop.northStarMetric.target})`, `**Convergence:** ${cc.data.isConverged ? "yes" : "no"} (${cc.data.convergenceWarnings.length} warning(s), ${cc.data.openObjections.filter((o) => o.status === "open" || o.status === "regressed").length} open objection(s))`);
    }
    else if (pd.success) {
        lines.push(`**Elevator:** ${pd.data.oneLiner}`);
    }
    else {
        lines.push("**Elevator:** (product definition unavailable)");
    }
    if (mon.success) {
        lines.push(`**Pricing:** $${mon.data.pricing.monthlyUsd}/mo · $${mon.data.pricing.yearlyUsd}/yr` +
            (mon.data.pricing.trialDays ? ` · ${mon.data.pricing.trialDays}d trial` : ""), `**Monetization:** ${mon.data.gates.length} gated feature(s); primary paywall moments tied to value.`);
    }
    else {
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
    lines.push(`**Built state:** builder=${builderStatus} · files_touched=${filesTouched} · qa=${qaRecommendation}${qaScore !== undefined ? `(score ${qaScore})` : ""} · qa_blockers=${qaBlockers}`);
    if (cc.success && cc.data.mvpBoundary.mustShip.length > 0) {
        lines.push(`**Must-ship scope:** ${cc.data.mvpBoundary.mustShip.length} item(s) declared in the contract; pitch is gated to only run when all are built.`);
    }
    lines.push("", "_Investor panel memo for internal planning. Pitch reflects current product+repo state, not aspirational scope._");
    return lines.join("\n");
}
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
function shellBootstrapCommand(inner) {
    const setup = [
        "[ -f ~/.bash_profile ] && source ~/.bash_profile >/dev/null 2>&1 || true",
        "[ -f ~/.bashrc ] && source ~/.bashrc >/dev/null 2>&1 || true",
        "[ -f ~/.profile ] && source ~/.profile >/dev/null 2>&1 || true",
    ].join("; ");
    return `${setup}; ${inner}`;
}
function execShell(command, cwd, timeoutMs) {
    return new Promise((resolve) => {
        const shell = process.env.SHELL || "/bin/bash";
        execFile(shell, ["-lc", shellBootstrapCommand(command)], {
            cwd,
            env: process.env,
            timeout: timeoutMs,
            maxBuffer: 16 * 1024 * 1024,
        }, (error, stdout, stderr) => {
            resolve({
                exitCode: error ? 1 : 0,
                stdout: typeof stdout === "string" ? stdout : "",
                stderr: typeof stderr === "string" ? stderr : "",
            });
        });
    });
}
function extractJsonObject(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start)
        return undefined;
    return text.slice(start, end + 1);
}
function llmContext(input, pitchBrief) {
    const payload = {
        project: input.config.project,
        metrics: input.config.metrics,
        gates: input.config.gates,
        currentStateAudit: input.currentStateAudit,
        marketGap: input.marketGap,
        firstPrinciples: input.firstPrinciples,
        flywheel: input.flywheel,
        convergenceContract: input.convergenceContract,
        productDefinition: input.productDefinition,
        monetizationConfig: input.monetizationConfig,
        builder: input.builder,
        independentQa: input.independentQa,
        releaseAgent: input.releaseAgent,
        growthOperator: input.growthOperator,
        feedback: input.feedback,
        investorRefinement: input.investorRefinement,
        pitchBrief,
    };
    return JSON.stringify(payload, null, 2);
}
function llmPrompt(input, pitchBrief) {
    return [
        "You are GPT-5.4 acting as an investor-panel simulator for internal product planning.",
        "Evaluate this app and monetization plan using three distinct archetype voices:",
        "- Elon Musk",
        "- Steve Jobs",
        "- Andreessen Horowitz",
        "",
        "Requirements:",
        "- Keep the pitch brief to 4-7 lines.",
        "- For each investor, return one grade from: F, D, C, C-, C+, B-, B, B+, A-, A, A+",
        "- Each investor response must be brief (max ~90 words).",
        "- Base the evaluation on the CURRENT state of the product as built (use `builder.status`, `builder.changes.filesCreated/Modified`, `independentQa.recommendation/score/blockers`, and `convergenceContract.isConverged` / `convergenceContract.openObjections`). Do NOT credit the team for capability that is only declared in scope.",
        "- READ the **SHIPPED SINCE LAST PITCH** section in the pitch brief carefully. If a previous directive you (or another investor) gave is now reflected in completed BUILD_SPEC_LEDGER tasks or git commits, ACKNOWLEDGE the progress in your response and reflect it in your grade — do not repeat directives that have already been addressed.",
        "- If your prior grade was below the A-band and the shipped delta materially addresses your concern, you should move the grade up. If nothing was shipped or shipped work missed your point, hold or lower the grade and explain why.",
        "- If `convergenceContract.openObjections` contains any `open` or `regressed` objections, treat them as unresolved and reflect that in your grade and response.",
        "- Reward narrowing and parking discipline (one singular loop, parked features in `mustNotShipYet`). Penalise cluttered, multi-bet pitches.",
        "- If grades are below A-band, include concrete refinement directives that target unresolved objections from `convergenceContract.openObjections` first. Do not re-issue directives already in the `SHIPPED SINCE LAST PITCH` addressed list.",
        "- Output STRICT JSON only. No markdown fences, no prose before/after.",
        "",
        "JSON schema:",
        '{"pitchBrief":"string","investors":[{"id":"elon_musk|steve_jobs|andreessen_horowitz","displayName":"string","grade":"F|D|C|C-|C+|B-|B|B+|A-|A|A+","response":"string"}],"combinedRefinementDirectives":["string"]}',
        "",
        "Project context:",
        llmContext(input, pitchBrief),
    ].join("\n");
}
async function tryRunLlmInvestorPanel(ctx, input, pitchBrief, refinementRound) {
    const command = input.config.project.cursor_automation?.command ?? process.env.FOUNDRY_CURSOR_AGENT_CMD ?? "agent";
    const model = input.config.project.cursor_automation?.qa_model ?? "gpt-5.4-high";
    const prompt = llmPrompt(input, pitchBrief);
    const modelName = model.trim().toLowerCase();
    const modelArgs = modelName === "auto" || modelName === "default"
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
        const parsed = InvestorPanelLlmDraftSchema.parse(JSON.parse(raw));
        const ranks = parsed.investors.map((p) => investorGradeRank(p.grade));
        const worstRank = Math.min(...ranks);
        return finalizeInvestorPanelOutput({
            pitchBrief: parsed.pitchBrief?.trim() || pitchBrief,
            investors: parsed.investors,
            worstGrade: INVESTOR_GRADE_ORDER[worstRank] ?? "F",
            worstRank,
            combinedRefinementDirectives: [...new Set(parsed.combinedRefinementDirectives ?? [])].slice(0, 8),
            refinementRound,
        }, input);
    }
    catch (err) {
        ctx.logger("[investor_panel] llm parse failed; invalid JSON shape", {
            error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
    }
}
function responseFor(id, grade, s) {
    const tighten = investorGradeRank(grade) < INVESTOR_ALL_A_MINUS_RANK
        ? " To reach an A-band memo, tighten scope to one heroic claim, add a single crisp success metric with a date, and show how software margins improve as usage grows."
        : " This is fundable at the memo level; ship a narrow wedge and instrument the one metric that proves the loop.";
    if (id === "elon_musk") {
        return (`First-principles: ${s.ambition >= 70 ? "The ambition registers." : "Why isn't this 10× bolder — what's the limiting physics or cost curve?"} ` +
            `${s.metricsAlignment >= 65 ? "Metrics tie to outcomes." : "I need a falsifiable metric timeline, not vibes."} ` +
            tighten);
    }
    if (id === "steve_jobs") {
        return (`${s.simplicity >= 68 ? "The story feels focused." : "Too many ideas — what is the one experience that delights in the first minute?"} ` +
            `${s.clarity >= 70 ? "The narrative is clear." : "Make the product invisible; the user should feel the result, not the settings."} ` +
            tighten);
    }
    return (`${s.monetization >= 68 ? "Revenue story is plausible for software." : "Show me expansion revenue and why this isn't a one-time purchase disguised as SaaS."} ` +
        `${s.differentiation >= 65 ? "Wedge is identifiable." : "Distribution: who pulls this into the org and why switch now?"} ` +
        tighten);
}
function buildDirectives(investors, s) {
    const d = [];
    for (const inv of investors) {
        if (investorGradeRank(inv.grade) >= INVESTOR_ALL_A_MINUS_RANK)
            continue;
        if (inv.id === "elon_musk") {
            d.push("Add one 10× bolder milestone and a dated, falsifiable success metric tied to the flywheel.");
            if (s.metricsAlignment < 65)
                d.push("Align `metrics.yaml` targets explicitly to the primary loop metric.");
        }
        else if (inv.id === "steve_jobs") {
            d.push("Cut scope to a single hero workflow with a delightful first-session outcome; remove adjacent features from Phase 1.");
            if (s.simplicity < 68)
                d.push("Rewrite the one-liner so a stranger gets the benefit in one breath.");
        }
        else {
            d.push("Strengthen monetization: clearer upgrade path, expansion lever, and analytics events that prove conversion.");
            if (s.monetization < 68)
                d.push("Justify recurring value vs one-time utility; tighten gates to post-value moments.");
        }
    }
    return [...new Set(d)].slice(0, 8);
}
function finalizeInvestorPanelOutput(draft, input) {
    const grades = draft.investors.map((i) => i.grade);
    const t = computeInvestorTargetFields(grades, parseAutonomousInvestorConvergence(input.config.project.foundry));
    return InvestorPanelOutputSchema.parse({
        ...draft,
        meetsMinimumGradeA: t.meetsMinimumGradeA,
        meetsInvestorTarget: t.meetsInvestorTarget,
        averageInvestorRank: t.averageInvestorRank,
    });
}
export const investorPanelStage = {
    name: "investor_panel",
    description: "Brief investment memo + simulated grades (F–A+) from three archetype investors; emits refinement directives when below A-band.",
    inputSchema: StageInputCompositionSchema,
    outputSchema: InvestorPanelOutputSchema,
    async run(ctx, input) {
        const refinementRound = input.investorRefinement?.round ?? 0;
        ctx.logger("[investor_panel] evaluating", {
            project: input.config.project.project_name,
            refinementRound,
        });
        const pitchBrief = await buildPitchBrief(input, ctx.repoPath);
        const llmOutput = await tryRunLlmInvestorPanel(ctx, input, pitchBrief, refinementRound);
        let output;
        let modeLabel = "GPT-5.4";
        if (llmOutput) {
            output = llmOutput;
        }
        else {
            const signals = extractSignals(input);
            const bump = refinementRound * 4;
            const adj = { ...signals };
            for (const k of Object.keys(adj)) {
                adj[k] = clamp(adj[k] + bump, 25, 98);
            }
            const gMusk = scoreToGrade(elonScore(adj));
            const gJobs = scoreToGrade(jobsScore(adj));
            const gA16z = scoreToGrade(a16zScore(adj));
            const personas = [
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
            output = finalizeInvestorPanelOutput({
                pitchBrief,
                investors: personas,
                worstGrade: INVESTOR_GRADE_ORDER[worstRank] ?? "F",
                worstRank,
                combinedRefinementDirectives: ranks.every((r) => r >= INVESTOR_ALL_A_MINUS_RANK) ? [] : buildDirectives(personas, adj),
                refinementRound,
            }, input);
            modeLabel = "heuristic fallback";
        }
        const validated = output;
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
            ...validated.investors.map((i) => `### ${i.displayName} — **${i.grade}**\n\n${i.response}\n`),
            "",
            "## Verdict",
            "",
            `- **Worst grade:** ${validated.worstGrade}`,
            `- **Mean grade rank** (0=F … 10=A+): **${validated.averageInvestorRank.toFixed(2)}**`,
            `- **All personas in A-band (A- or better):** ${validated.meetsMinimumGradeA ? "yes" : "no"}`,
            `- **Meets investor target (pipeline bar):** ${validated.meetsInvestorTarget ? "yes" : "no"}${auto.enabled ? ` — autonomous mode: mean ≥ **${auto.minAverageGrade}**` : ""}`,
            validated.combinedRefinementDirectives.length
                ? ["", "## Refinement directives", "", ...validated.combinedRefinementDirectives.map((d) => `- ${d}`), ""].join("\n")
                : "",
            "",
            "_Investor panel is for internal planning only; grades are not financial or legal advice._",
            "",
        ].join("\n");
        await writeStageMarkdown(ctx, "investor_panel", "README.md", md);
        const gradesMap = {};
        for (const inv of validated.investors) {
            gradesMap[inv.displayName] = inv.grade;
        }
        await recordInvestorPanelPitched(ctx.repoPath, gradesMap, validated.combinedRefinementDirectives, validated.averageInvestorRank);
        return validated;
    },
};
