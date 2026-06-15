/** Shared investor letter-grade ordering (keep aligned with `investor_panel` stage). */
export const INVESTOR_GRADE_ORDER = [
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
export function investorGradeRank(g) {
    const idx = INVESTOR_GRADE_ORDER.indexOf(g);
    return idx >= 0 ? idx : 0;
}
/** A- and above — classic “all personas in A band” bar. */
export const INVESTOR_ALL_A_MINUS_RANK = investorGradeRank("A-");
function yamlTruthy(v) {
    if (v === true || v === 1)
        return true;
    if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        return s === "true" || s === "yes" || s === "on" || s === "1";
    }
    return false;
}
export function parseAutonomousInvestorConvergence(foundry) {
    const aic = foundry?.autonomous_investor_convergence;
    const enabled = yamlTruthy(aic?.enabled);
    const relaxedInvestorGates = enabled && aic?.relaxed_investor_gates !== false;
    const deferReleaseUntilInvestorTarget = enabled && aic?.defer_release_prompt_until_investor_target !== false;
    const raw = typeof aic?.min_average_grade === "string" ? aic.min_average_grade.trim() : "";
    const minAverageGrade = (INVESTOR_GRADE_ORDER.includes(raw)
        ? raw
        : "B+");
    return {
        enabled,
        relaxedInvestorGates,
        deferReleaseUntilInvestorTarget,
        minAverageGrade,
    };
}
export function hasAutonomousInvestorConvergenceKey(foundry) {
    return Object.prototype.hasOwnProperty.call(foundry ?? {}, "autonomous_investor_convergence");
}
/** `foundry loop --profile investor` applies these when `autonomous_investor_convergence` is omitted from project.yaml. */
const INVESTOR_LOOP_AUTONOMOUS_DEFAULTS = {
    enabled: true,
    relaxedInvestorGates: true,
    deferReleaseUntilInvestorTarget: true,
    minAverageGrade: "B+",
};
/**
 * Resolves autonomous investor settings for CLI loop logic. When `investorLoopDefaults` is true and the
 * YAML block is absent, returns the investor-loop defaults (B+ mean, relaxed gates, defer release).
 */
export function resolveAutonomousInvestorConvergenceForRun(foundry, opts) {
    const parsed = parseAutonomousInvestorConvergence(foundry);
    if (!opts.investorLoopDefaults || hasAutonomousInvestorConvergenceKey(foundry))
        return parsed;
    if (parsed.enabled)
        return parsed;
    return INVESTOR_LOOP_AUTONOMOUS_DEFAULTS;
}
/**
 * In-memory merge for pipeline runs: stages read `config.project.foundry` via parseAutonomous… — injecting
 * the default block keeps investor_panel / stageRunner aligned with `foundry loop --profile investor`.
 */
export function withInvestorLoopAutonomousDefaultsIfNeeded(config, apply) {
    if (!apply)
        return config;
    if (hasAutonomousInvestorConvergenceKey(config.project.foundry))
        return config;
    if (parseAutonomousInvestorConvergence(config.project.foundry).enabled)
        return config;
    return {
        ...config,
        project: {
            ...config.project,
            foundry: {
                ...(config.project.foundry ?? {}),
                autonomous_investor_convergence: {
                    enabled: true,
                    relaxed_investor_gates: true,
                    defer_release_prompt_until_investor_target: true,
                    min_average_grade: "B+",
                },
            },
        },
    };
}
export function computeInvestorTargetFields(grades, opts) {
    const ranks = grades.map((g) => investorGradeRank(g));
    const averageInvestorRank = ranks.length === 0 ? 0 : ranks.reduce((a, b) => a + b, 0) / ranks.length;
    const meetsMinimumGradeA = ranks.length > 0 && ranks.every((r) => r >= INVESTOR_ALL_A_MINUS_RANK);
    if (!opts.enabled) {
        return { meetsMinimumGradeA, meetsInvestorTarget: meetsMinimumGradeA, averageInvestorRank };
    }
    const minR = investorGradeRank(opts.minAverageGrade);
    const meetsInvestorTarget = ranks.length > 0 && averageInvestorRank + 1e-9 >= minR;
    return { meetsMinimumGradeA, meetsInvestorTarget, averageInvestorRank };
}
