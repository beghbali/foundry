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
] as const;

export type InvestorLetterGrade = (typeof INVESTOR_GRADE_ORDER)[number];

export function investorGradeRank(g: string): number {
  const idx = INVESTOR_GRADE_ORDER.indexOf(g as InvestorLetterGrade);
  return idx >= 0 ? idx : 0;
}

/** A- and above — classic “all personas in A band” bar. */
export const INVESTOR_ALL_A_MINUS_RANK = investorGradeRank("A-");

export type AutonomousInvestorConvergenceYaml = {
  enabled?: boolean;
  /** Mean of the three persona ranks must be >= this grade (default B+ when enabled). */
  min_average_grade?: string;
  /**
   * When true (default while `enabled`), investor_panel ignores convergence + brief/packet
   * readiness gates so grading can run on the current repo; QA + builder gates still apply.
   */
  relaxed_investor_gates?: boolean;
  /**
   * When true (default while `enabled`), `foundry loop` skips release approval / EAS prompts
   * until `meetsInvestorTarget` **and** `convergence_contract` is converged with no open/regressed objections.
   */
  defer_release_prompt_until_investor_target?: boolean;
};

function yamlTruthy(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "yes" || s === "on" || s === "1";
  }
  return false;
}

export function parseAutonomousInvestorConvergence(foundry: { autonomous_investor_convergence?: unknown } | null | undefined): {
  enabled: boolean;
  relaxedInvestorGates: boolean;
  deferReleaseUntilInvestorTarget: boolean;
  minAverageGrade: InvestorLetterGrade;
} {
  const aic = foundry?.autonomous_investor_convergence as AutonomousInvestorConvergenceYaml | undefined;
  const enabled = yamlTruthy(aic?.enabled);
  const relaxedInvestorGates = enabled && aic?.relaxed_investor_gates !== false;
  const deferReleaseUntilInvestorTarget = enabled && aic?.defer_release_prompt_until_investor_target !== false;
  const raw = typeof aic?.min_average_grade === "string" ? aic.min_average_grade.trim() : "";
  const minAverageGrade = (INVESTOR_GRADE_ORDER.includes(raw as InvestorLetterGrade)
    ? raw
    : "B+") as InvestorLetterGrade;
  return {
    enabled,
    relaxedInvestorGates,
    deferReleaseUntilInvestorTarget,
    minAverageGrade,
  };
}

export type ParsedAutonomousInvestorConvergence = ReturnType<typeof parseAutonomousInvestorConvergence>;

export function hasAutonomousInvestorConvergenceKey(
  foundry: { autonomous_investor_convergence?: unknown } | null | undefined,
): boolean {
  return Object.prototype.hasOwnProperty.call(foundry ?? {}, "autonomous_investor_convergence");
}

/** `foundry loop --profile investor` applies these when `autonomous_investor_convergence` is omitted from project.yaml. */
const INVESTOR_LOOP_AUTONOMOUS_DEFAULTS: ParsedAutonomousInvestorConvergence = {
  enabled: true,
  relaxedInvestorGates: true,
  deferReleaseUntilInvestorTarget: true,
  minAverageGrade: "B+",
};

/**
 * Resolves autonomous investor settings for CLI loop logic. When `investorLoopDefaults` is true and the
 * YAML block is absent, returns the investor-loop defaults (B+ mean, relaxed gates, defer release).
 */
export function resolveAutonomousInvestorConvergenceForRun(
  foundry: { autonomous_investor_convergence?: unknown } | null | undefined,
  opts: { investorLoopDefaults?: boolean },
): ParsedAutonomousInvestorConvergence {
  const parsed = parseAutonomousInvestorConvergence(foundry);
  if (!opts.investorLoopDefaults || hasAutonomousInvestorConvergenceKey(foundry)) return parsed;
  if (parsed.enabled) return parsed;
  return INVESTOR_LOOP_AUTONOMOUS_DEFAULTS;
}

/**
 * In-memory merge for pipeline runs: stages read `config.project.foundry` via parseAutonomous… — injecting
 * the default block keeps investor_panel / stageRunner aligned with `foundry loop --profile investor`.
 */
export function withInvestorLoopAutonomousDefaultsIfNeeded<
  T extends { project: { foundry?: { autonomous_investor_convergence?: unknown } } },
>(config: T, apply: boolean): T {
  if (!apply) return config;
  if (hasAutonomousInvestorConvergenceKey(config.project.foundry)) return config;
  if (parseAutonomousInvestorConvergence(config.project.foundry).enabled) return config;
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

export function computeInvestorTargetFields(
  grades: string[],
  opts: ReturnType<typeof parseAutonomousInvestorConvergence>,
): {
  meetsMinimumGradeA: boolean;
  meetsInvestorTarget: boolean;
  averageInvestorRank: number;
} {
  const ranks = grades.map((g) => investorGradeRank(g));
  const averageInvestorRank =
    ranks.length === 0 ? 0 : ranks.reduce((a, b) => a + b, 0) / ranks.length;
  const meetsMinimumGradeA = ranks.length > 0 && ranks.every((r) => r >= INVESTOR_ALL_A_MINUS_RANK);

  if (!opts.enabled) {
    return { meetsMinimumGradeA, meetsInvestorTarget: meetsMinimumGradeA, averageInvestorRank };
  }

  const minR = investorGradeRank(opts.minAverageGrade);
  const meetsInvestorTarget = ranks.length > 0 && averageInvestorRank + 1e-9 >= minR;
  return { meetsMinimumGradeA, meetsInvestorTarget, averageInvestorRank };
}
