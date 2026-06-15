import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeStageMarkdown } from "@foundry/core/artifacts";
import { domainSummaryLine, getDomainPrimaryMetric, } from "@foundry/core/projectDomain";
import { StageInputCompositionSchema } from "@foundry/core/stageInputs";
import { z } from "zod";
import { BuilderOutputSchema } from "./builder.js";
import { FlywheelOutputSchema } from "./flywheel_designer.js";
import { MonetizationOutputSchema } from "./monetization_architect.js";
import { ProductDefinitionOutputSchema } from "./product_definition.js";
import { ReleaseAgentOutputSchema } from "./release_agent.js";
const RunManifestLiteSchema = z.object({
    runId: z.string(),
    startedAt: z.string(),
    status: z.enum(["running", "passed", "failed"]).optional(),
});
export const GrowthOperatorOutputSchema = z.object({
    metricsSnapshot: z.array(z.object({
        key: z.string(),
        target: z.number(),
        current: z.number().nullable(),
        status: z.enum(["on_track", "at_risk", "unknown"]),
    })),
    productStage: z.enum(["pre_launch", "launched", "growing"]),
    experiments: z.array(z.object({
        name: z.string(),
        hypothesis: z.string(),
        metric: z.string(),
        effort: z.enum(["low", "medium", "high"]),
        priority: z.number().min(1).max(5),
    })),
    flywheelAlignment: z.array(z.object({
        loop: z.string(),
        healthSignal: z.enum(["strong", "weak", "unmeasured"]),
        nextAction: z.string(),
    })),
    runHistory: z.object({
        totalRuns: z.number(),
        lastRunAt: z.string().nullable(),
        trend: z.enum(["improving", "stable", "declining", "insufficient_data"]),
    }),
    recommendations: z.array(z.string()),
});
function isGardeningDomain(projectName, northStar) {
    const haystack = `${projectName} ${northStar}`.toLowerCase();
    return /\b(garden|gardening|gardener|plant|harvest|seed|soil)\b/.test(haystack);
}
async function safeReadJson(path) {
    try {
        const raw = await readFile(path, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
async function listRunDirectories(repoPath) {
    const outRoot = join(repoPath, ".foundry", "out");
    let names;
    try {
        names = await readdir(outRoot);
    }
    catch {
        return [];
    }
    const dirs = [];
    for (const name of names) {
        const p = join(outRoot, name);
        try {
            if ((await stat(p)).isDirectory())
                dirs.push(name);
        }
        catch {
            /* skip */
        }
    }
    dirs.sort((a, b) => b.localeCompare(a));
    return dirs;
}
async function findPrefixedStageOutput(runDir, stageSuffix) {
    let entries;
    try {
        entries = await readdir(runDir, { withFileTypes: true });
    }
    catch {
        return undefined;
    }
    for (const e of entries) {
        if (e.isDirectory() && e.name.endsWith(`_${stageSuffix}`)) {
            const p = join(runDir, e.name, "output.json");
            try {
                if ((await stat(p)).isFile())
                    return p;
            }
            catch {
                /* continue */
            }
        }
    }
    return undefined;
}
async function countPriorApprovedReleases(repoPath, excludeRunId) {
    const runs = await listRunDirectories(repoPath);
    let n = 0;
    for (const runId of runs) {
        if (runId === excludeRunId)
            continue;
        const out = await findPrefixedStageOutput(join(repoPath, ".foundry", "out", runId), "release_agent");
        if (!out)
            continue;
        const raw = await safeReadJson(out);
        const parsed = ReleaseAgentOutputSchema.safeParse(raw);
        if (parsed.success && (parsed.data.status === "approved" || parsed.data.status === "auto_approved")) {
            n += 1;
        }
    }
    return n;
}
function detectProductStage(release, priorApprovedReleases) {
    const rel = release;
    if (rel?.status === "awaiting_approval" ||
        rel?.status === "blocked_by_qa" ||
        rel?.status === "blocked_pre_release") {
        return "pre_launch";
    }
    if (rel?.status === "approved" || rel?.status === "auto_approved") {
        return priorApprovedReleases >= 1 ? "growing" : "launched";
    }
    if (priorApprovedReleases === 0)
        return "pre_launch";
    if (priorApprovedReleases === 1)
        return "launched";
    return "growing";
}
function normalizeKeyParts(key) {
    return key
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((p) => p.length > 2);
}
function haystackForImplementation(productDef, builder) {
    const pdLines = [
        ...productDef.scope.mustShip,
        ...productDef.scope.shouldShip,
        ...productDef.coreWorkflows.map((w) => `${w.name} ${w.successMetric}`),
        ...productDef.acceptanceCriteria.map((a) => `${a.id} ${a.description}`),
    ].join(" ");
    const bFiles = builder
        ? [...builder.changes.filesCreated, ...builder.changes.filesModified].join(" ")
        : "";
    return `${pdLines} ${bFiles}`.toLowerCase();
}
function metricImplementationStatus(metricKey, haystack, flywheelMetricKeys) {
    const parts = normalizeKeyParts(metricKey);
    if (parts.length === 0)
        return "unknown";
    let hits = 0;
    for (const p of parts) {
        if (haystack.includes(p))
            hits += 1;
    }
    if (flywheelMetricKeys.has(metricKey))
        hits += 1;
    if (hits >= Math.min(2, parts.length))
        return "on_track";
    if (hits === 0)
        return "at_risk";
    return "unknown";
}
function buildExperiments(gardening, productStage, gatedFeatures, northStar, flywheelMetrics) {
    const primaryMetric = flywheelMetrics[0] ?? "weekly_active_users";
    const generic = [
        {
            name: "Onboarding completion funnel",
            hypothesis: "Reducing steps to first value will increase activation within the first session.",
            metric: "activation_rate",
            effort: "medium",
            priority: 5,
        },
        {
            name: "Re-engagement push for dormant users",
            hypothesis: "A well-timed nudge brings back users who were active but lapsed in the last 14 days.",
            metric: "resurrected_weekly_actives",
            effort: "low",
            priority: 4,
        },
        {
            name: "Referral prompt after success moment",
            hypothesis: "Users share immediately after a positive outcome, improving k-factor.",
            metric: "invites_per_activated_user",
            effort: "medium",
            priority: 4,
        },
        {
            name: "Paywall placement experiment",
            hypothesis: "Testing paywall after the second success session improves conversion without hurting activation.",
            metric: "trial_to_paid_conversion",
            effort: "high",
            priority: 3,
        },
        {
            name: "Empty-state to core workflow",
            hypothesis: "Stronger empty states increase depth of use in week one.",
            metric: primaryMetric,
            effort: "low",
            priority: 3,
        },
    ];
    const garden = [
        {
            name: "Weekly plan notification",
            hypothesis: "A concise weekly reminder increases habit formation and plan completion.",
            metric: "weekly_action_plan_completion_rate",
            effort: "low",
            priority: 5,
        },
        {
            name: "Share harvest photo",
            hypothesis: "Social proof from harvest shares drives organic installs from similar gardeners.",
            metric: "retained_gardener_referral_rate",
            effort: "medium",
            priority: 4,
        },
        {
            name: "Seasonal challenge",
            hypothesis: "Time-bound challenges increase session depth during peak planting windows.",
            metric: "sessions_per_active_user",
            effort: "medium",
            priority: 4,
        },
        {
            name: "Diagnosis recovery nudge",
            hypothesis: "Follow-up prompts after diagnosis improve recovery workflow completion.",
            metric: "issue_recovery_workflow_completion_rate",
            effort: "low",
            priority: 4,
        },
        {
            name: "Companion planting discovery",
            hypothesis: "Highlighting companion suggestions increases plants logged and return visits.",
            metric: "plants_logged_per_active_user",
            effort: "high",
            priority: 3,
        },
    ];
    let pool = gardening ? garden : generic;
    if (productStage === "pre_launch") {
        pool = pool.map((e) => e.name.includes("Paywall") || e.name.includes("Referral")
            ? { ...e, priority: Math.max(1, e.priority - 1) }
            : e);
    }
    if (gatedFeatures.length) {
        pool = [
            {
                name: `Monetization: ${gatedFeatures[0]} unlock path`,
                hypothesis: "Clearer upgrade moments when users hit gated limits will lift conversion without hurting top-of-funnel.",
                metric: "trial_to_paid_conversion",
                effort: "medium",
                priority: 4,
            },
            ...pool,
        ];
    }
    const sorted = [...pool].sort((a, b) => b.priority - a.priority);
    return sorted.slice(0, 5);
}
function flywheelAlignmentRows(flyParsed, productDef, builder) {
    if (!flyParsed.success) {
        return [
            {
                loop: "(flywheel not available)",
                healthSignal: "unmeasured",
                nextAction: "Re-run flywheel_designer or ensure prior stage outputs are present.",
            },
        ];
    }
    const hay = productDef ? haystackForImplementation(productDef, builder) : "";
    return flyParsed.data.flywheel.map((loop) => {
        const metricKey = loop.metric.key;
        const stepKeywords = loop.steps.join(" ").toLowerCase();
        const loopKeywords = `${loop.loopName} ${stepKeywords} ${metricKey}`.toLowerCase();
        let score = 0;
        for (const must of productDef?.scope.mustShip ?? []) {
            const m = must.toLowerCase();
            if (loopKeywords.split(/\s+/).some((w) => w.length > 3 && m.includes(w)))
                score += 1;
        }
        if (hay.includes(metricKey.toLowerCase()))
            score += 2;
        if (builder) {
            const files = [...builder.changes.filesCreated, ...builder.changes.filesModified].join(" ").toLowerCase();
            if (files.includes(metricKey.split("_")[0] ?? ""))
                score += 1;
        }
        let healthSignal = "unmeasured";
        if (score >= 3)
            healthSignal = "strong";
        else if (score >= 1)
            healthSignal = "weak";
        const nextAction = healthSignal === "strong"
            ? `Instrument ${metricKey} and run a focused experiment on the loop trigger: ${loop.trigger.slice(0, 120)}`
            : healthSignal === "weak"
                ? `Ship missing workflow pieces aligned with "${loop.loopName}" before scaling acquisition.`
                : `Define analytics for ${metricKey} and map one UI surface to the first step in this loop.`;
        return {
            loop: loop.loopName,
            healthSignal,
            nextAction,
        };
    });
}
async function computeRunHistory(repoPath, currentRunId, currentSnapshot) {
    const runIds = await listRunDirectories(repoPath);
    const totalRuns = runIds.length;
    const priorIds = runIds.filter((id) => id !== currentRunId);
    let lastRunAt = null;
    if (priorIds.length > 0) {
        const prevDir = join(repoPath, ".foundry", "out", priorIds[0]);
        const manifestPath = join(prevDir, "run.json");
        const m = await safeReadJson(manifestPath);
        const parsed = RunManifestLiteSchema.safeParse(m);
        if (parsed.success)
            lastRunAt = parsed.data.startedAt;
    }
    const priorScores = [];
    for (const rid of priorIds.slice(0, 8)) {
        const p = await findPrefixedStageOutput(join(repoPath, ".foundry", "out", rid), "growth_operator");
        if (!p)
            continue;
        const raw = await safeReadJson(p);
        const prevOut = GrowthOperatorOutputSchema.safeParse(raw);
        if (!prevOut.success)
            continue;
        const onTrack = prevOut.data.metricsSnapshot.filter((x) => x.status === "on_track").length;
        priorScores.push(onTrack);
    }
    let trend = "insufficient_data";
    if (priorScores.length >= 1) {
        const latestPrior = priorScores[0];
        const current = currentSnapshot.filter((x) => x.status === "on_track").length;
        if (priorScores.length >= 2) {
            const older = priorScores[1];
            if (current > Math.max(latestPrior, older))
                trend = "improving";
            else if (current < Math.min(latestPrior, older))
                trend = "declining";
            else
                trend = "stable";
        }
        else {
            if (current > latestPrior)
                trend = "improving";
            else if (current < latestPrior)
                trend = "declining";
            else
                trend = "stable";
        }
    }
    return { totalRuns, lastRunAt, trend };
}
function renderGrowthDashboard(output, projectName, northStar) {
    const metricsTable = [
        "| Metric | Target | Current | Status |",
        "| --- | ---: | ---: | --- |",
        ...output.metricsSnapshot.map((m) => `| \`${m.key}\` | ${m.target} | ${m.current === null ? "—" : m.current} | ${m.status} |`),
    ].join("\n");
    const experimentsTable = [
        "| Priority | Experiment | Hypothesis | Metric | Effort |",
        "| ---: | --- | --- | --- | --- |",
        ...output.experiments.map((e) => `| ${e.priority} | **${e.name}** | ${e.hypothesis} | \`${e.metric}\` | ${e.effort} |`),
    ].join("\n");
    const flyTable = [
        "| Flywheel loop | Health | Next action |",
        "| --- | --- | --- |",
        ...output.flywheelAlignment.map((f) => `| ${f.loop} | ${f.healthSignal} | ${f.nextAction} |`),
    ].join("\n");
    return [
        `# Growth dashboard — ${projectName}`,
        "",
        "**North star:** " + northStar,
        "",
        `**Product stage:** \`${output.productStage}\``,
        "",
        "## Metrics snapshot",
        "",
        "Configured targets from `.foundry/metrics.yaml`. Current values are not collected by the pipeline yet (`null` until instrumentation lands).",
        "",
        metricsTable,
        "",
        "## Experiments backlog",
        "",
        experimentsTable,
        "",
        "## Flywheel alignment",
        "",
        flyTable,
        "",
        "## Run history",
        "",
        `- **Total runs observed:** ${output.runHistory.totalRuns}`,
        `- **Previous run started at:** ${output.runHistory.lastRunAt ?? "_(none or first run)_"}`,
        `- **Trend (on-track metric count vs. prior artifacts):** \`${output.runHistory.trend}\``,
        "",
        "## Recommendations",
        "",
        ...output.recommendations.map((r) => `- ${r}`),
        "",
        "---",
        "",
        "_Generated by the `growth_operator` stage. Re-run the pipeline after shipping instrumentation to refresh trends._",
    ].join("\n");
}
export const growthOperatorStage = {
    name: "growth_operator",
    description: "Analyze metrics, recommend growth experiments, and track progress toward north star goals.",
    inputSchema: StageInputCompositionSchema,
    outputSchema: GrowthOperatorOutputSchema,
    async run(ctx, input) {
        const projectName = input.config.project.project_name;
        const northStar = input.config.project.north_star;
        ctx.logger("[growth_operator] start", { project: projectName });
        const gardening = isGardeningDomain(projectName, northStar);
        const releaseParsed = ReleaseAgentOutputSchema.safeParse(input.releaseAgent);
        const priorApproved = await countPriorApprovedReleases(ctx.repoPath, ctx.runId);
        const releaseOut = releaseParsed.success ? releaseParsed.data : undefined;
        const productStage = detectProductStage(releaseOut, priorApproved);
        const flyParsed = FlywheelOutputSchema.safeParse(input.flywheel);
        const productParsed = ProductDefinitionOutputSchema.safeParse(input.productDefinition);
        const builderParsed = BuilderOutputSchema.safeParse(input.builder);
        const monParsed = MonetizationOutputSchema.safeParse(input.monetizationConfig);
        const flywheelMetricKeys = new Set();
        if (flyParsed.success) {
            for (const f of flyParsed.data.flywheel) {
                flywheelMetricKeys.add(f.metric.key);
            }
        }
        const builderOut = builderParsed.success ? builderParsed.data : undefined;
        const haystack = productParsed.success ? haystackForImplementation(productParsed.data, builderOut) : "";
        const metricsSnapshot = input.config.metrics.metrics.map((m) => ({
            key: m.key,
            target: m.target,
            current: null,
            status: productParsed.success
                ? metricImplementationStatus(m.key, haystack, flywheelMetricKeys)
                : "unknown",
        }));
        const gatedFeatures = monParsed.success ? monParsed.data.gates.map((g) => g.feature) : [];
        const flywheelMetrics = flyParsed.success ? flyParsed.data.flywheel.map((f) => f.metric.key) : [];
        const experiments = buildExperiments(gardening, productStage, gatedFeatures, northStar, flywheelMetrics);
        const productOut = productParsed.success ? productParsed.data : undefined;
        const flywheelAlignment = flywheelAlignmentRows(flyParsed, productOut, builderOut);
        const runHistory = await computeRunHistory(ctx.repoPath, ctx.runId, metricsSnapshot);
        // Domain-aware framing: when project.domain is configured, prefer the
        // configured primary metric / moment over the generic north_star summary
        // so growth experiments target the same outcome the brief is being graded on.
        const domainPrimary = domainSummaryLine(input.config.project);
        const domainMetric = getDomainPrimaryMetric(input.config.project);
        const headlineRec = domainPrimary
            ? `Align the next ${experiments.length} experiments with the configured primary moment: ${domainPrimary}${domainMetric ? ` (target: ${domainMetric})` : ""}.`
            : `Align the next ${experiments.length} experiments with north star: ${northStar.slice(0, 160)}${northStar.length > 160 ? "…" : ""}`;
        const recommendations = [headlineRec];
        if (productStage === "pre_launch") {
            recommendations.push("Stay focused on release readiness: conversion experiments are secondary until the build ships.");
        }
        if (gatedFeatures.length) {
            recommendations.push(`Monetization gates in play (${gatedFeatures.slice(0, 3).join(", ")}): pair growth tests with entitlement analytics.`);
        }
        if (flyParsed.success) {
            recommendations.push(`Prioritize loops where health is weak: ${flywheelAlignment.filter((f) => f.healthSignal === "weak").map((f) => f.loop).join("; ") || "none flagged — keep monitoring"}.`);
        }
        recommendations.push(`Run history trend is \`${runHistory.trend}\` across ${runHistory.totalRuns} pipeline run(s); add real metric ingestion to replace null currents.`);
        const output = {
            metricsSnapshot,
            productStage,
            experiments,
            flywheelAlignment,
            runHistory,
            recommendations,
        };
        const validated = GrowthOperatorOutputSchema.parse(output);
        await writeStageMarkdown(ctx, "growth_operator", "README.md", renderGrowthDashboard(validated, projectName, northStar));
        ctx.logger("[growth_operator] done", {
            productStage,
            experiments: validated.experiments.length,
            trend: validated.runHistory.trend,
        });
        return validated;
    },
};
