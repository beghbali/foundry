import { execFile } from "node:child_process";
import { writeStageMarkdown } from "@foundry/core/artifacts";
import { StageInputCompositionSchema } from "@foundry/core/stageInputs";
import { z } from "zod";
import { ConvergenceContractOutputSchema } from "./convergence_contract.js";
import { ProductDefinitionOutputSchema } from "./product_definition.js";
import { MonetizationOutputSchema } from "./monetization_architect.js";
import { FlywheelOutputSchema } from "./flywheel_designer.js";
import { MarketGapOutputSchema } from "./market_gap_analysis.js";
const GRADE_ORDER = [
    "F",
    "D",
    "C",
    "C-",
    "C+",
    "B-",
    "B",
    "B+",
    "A-",
    "A",
    "A+",
];
const GradeZod = z.enum(GRADE_ORDER);
function gradeRank(g) {
    return GRADE_ORDER.indexOf(g);
}
/** A- and above satisfy “at least A band” (not B+). */
export const INVESTOR_MIN_RANK = gradeRank("A-");
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
function buildPitchBrief(input) {
    const name = input.config.project.project_name;
    const ns = input.config.project.north_star;
    const pd = ProductDefinitionOutputSchema.safeParse(input.productDefinition);
    const mon = MonetizationOutputSchema.safeParse(input.monetizationConfig);
    const fly = FlywheelOutputSchema.safeParse(input.flywheel);
    const cc = ConvergenceContractOutputSchema.safeParse(input.convergenceContract);
    const builderEv = BuilderEvidenceSchema.safeParse(input.builder);
    const qaEv = QaEvidenceSchema.safeParse(input.independentQa);
    const lines = [`**${name}** — ${ns}`, ""];
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
        "- If `convergenceContract.openObjections` contains any `open` or `regressed` objections, treat them as unresolved and reflect that in your grade and response.",
        "- Reward narrowing and parking discipline (one singular loop, parked features in `mustNotShipYet`). Penalise cluttered, multi-bet pitches.",
        "- If grades are below A-band, include concrete refinement directives that target unresolved objections from `convergenceContract.openObjections` first.",
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
    const implicitModel = ["auto", "default"].includes(model.trim().toLowerCase());
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
        ...(implicitModel ? [] : ["--model", shellQuote(model)]),
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
        const ranks = parsed.investors.map((p) => gradeRank(p.grade));
        const worstRank = Math.min(...ranks);
        return InvestorPanelOutputSchema.parse({
            pitchBrief: parsed.pitchBrief?.trim() || pitchBrief,
            investors: parsed.investors,
            worstGrade: GRADE_ORDER[worstRank] ?? "F",
            worstRank,
            meetsMinimumGradeA: ranks.every((r) => r >= INVESTOR_MIN_RANK),
            combinedRefinementDirectives: [...new Set(parsed.combinedRefinementDirectives ?? [])].slice(0, 8),
            refinementRound,
        });
    }
    catch (err) {
        ctx.logger("[investor_panel] llm parse failed; invalid JSON shape", {
            error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
    }
}
function responseFor(id, grade, s) {
    const tighten = gradeRank(grade) < INVESTOR_MIN_RANK
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
        if (gradeRank(inv.grade) >= INVESTOR_MIN_RANK)
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
        const pitchBrief = buildPitchBrief(input);
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
            const ranks = personas.map((p) => gradeRank(p.grade));
            const worstRank = Math.min(...ranks);
            output = {
                pitchBrief,
                investors: personas,
                worstGrade: GRADE_ORDER[worstRank] ?? "F",
                worstRank,
                meetsMinimumGradeA: ranks.every((r) => r >= INVESTOR_MIN_RANK),
                combinedRefinementDirectives: ranks.every((r) => r >= INVESTOR_MIN_RANK) ? [] : buildDirectives(personas, adj),
                refinementRound,
            };
            modeLabel = "heuristic fallback";
        }
        const validated = InvestorPanelOutputSchema.parse(output);
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
            `- **Meets A-band (A- or better):** ${validated.meetsMinimumGradeA ? "yes" : "no"}`,
            validated.combinedRefinementDirectives.length
                ? ["", "## Refinement directives", "", ...validated.combinedRefinementDirectives.map((d) => `- ${d}`), ""].join("\n")
                : "",
            "",
            "_Investor panel is for internal planning only; grades are not financial or legal advice._",
            "",
        ].join("\n");
        await writeStageMarkdown(ctx, "investor_panel", "README.md", md);
        return validated;
    },
};
