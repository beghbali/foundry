import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
const BuilderDirectiveSchema = z.preprocess((value) => {
    if (typeof value === "string")
        return { description: value, files: [] };
    return value;
}, z.object({
    description: z.string(),
    files: z.array(z.string()).default([]),
    notes: z.string().optional(),
}));
/**
 * Domain block — first-class field for *what this app actually does*.
 *
 * Why: every stage in the pipeline (`product_definition`, `first_principles`,
 * `flywheel_designer`, `convergence_contract`, `investor_panel`,
 * `growth_operator`) was previously inferring "domain" from regex over
 * `north_star` / `project_name` / `constraints`, which collapsed to generic
 * SaaS phrasing for anything outside the few hardcoded buckets (gardening /
 * web data platform). Concrete user actions and vocabulary belong in the
 * config so all downstream copy can be specific instead of "Outcome
 * visibility: the user sees a concrete result after each interaction."
 *
 * Every field is optional so existing repos keep working unchanged; stages
 * fall back to legacy `inferDomain` when the block is absent.
 */
export const ProjectDomainSchema = z
    .object({
    /** Short label for the domain (e.g. "ingredient-safety scanner"). */
    name: z.string().optional(),
    /**
     * The single most important user moment, written as one concrete sentence
     * with a measurable outcome. Used verbatim where stages need a hero line.
     * Example: "Point camera at a packaged food → see stomach-safe verdict in <2s".
     */
    primary_user_action: z.string().optional(),
    /**
     * Concrete user actions the product must support. Each entry becomes a
     * Must Ship line in the brief (replaces the boilerplate "First-session
     * value / Outcome visibility / etc."). Keep these specific and verifiable.
     */
    key_user_actions: z.array(z.string()).optional(),
    /**
     * Domain vocabulary so generated copy uses the same words as the product.
     * `noun` ("a scan"), `verb` ("scan"), `outcome` ("verdict"), `actor` ("shopper").
     */
    vocabulary: z
        .object({
        noun: z.string().optional(),
        verb: z.string().optional(),
        outcome: z.string().optional(),
        actor: z.string().optional(),
    })
        .optional(),
    /** Concrete personas this product is built for. */
    personas: z.array(z.string()).optional(),
    /**
     * Specific success demos — `<input> → <expected outcome with metric>`. Used
     * in the investor pitch and as `requiredEvidence` for objections.
     */
    success_examples: z.array(z.string()).optional(),
    /** Things explicitly out of scope for this product. */
    non_goals: z.array(z.string()).optional(),
    /** The single metric that defines product success (e.g. "scan-to-verdict p95 < 2s"). */
    primary_metric: z.string().optional(),
})
    .strict();
export const ProjectYamlSchema = z.object({
    project_name: z.string(),
    repo_type: z.string(),
    north_star: z.string(),
    constraints: z.array(z.string()).optional(),
    core_differentiators: z.array(z.string()).optional(),
    domain: ProjectDomainSchema.optional(),
    market: z
        .object({
        competitors: z
            .array(z.union([
            z.string(),
            z.object({
                name: z.string(),
                focus: z.string().optional(),
            }),
        ]))
            .optional(),
    })
        .optional(),
    foundry: z
        .preprocess((value) => (value === null ? undefined : value), z
        .object({
        apply_baseline_shell: z.boolean().optional(),
        /**
         * Single long-lived branch for builder commits until release (e.g. `foundry/release`).
         * When omitted, each pipeline run uses `foundry/<runId>` (legacy).
         */
        builder_branch: z.string().min(1).optional(),
        /**
         * When true, `investor_panel` runs only if QA is ship with **zero blockers**, zero tracked
         * brief opens, `WORK_PACKET.json` exists, and zero open packet items — i.e. post-convergence pitch.
         */
        investor_panel_when_release_ready: z.boolean().optional(),
        /**
         * Overnight / hands-off mode: relax investor_panel gates so grading runs on the current repo,
         * use mean persona grade vs `min_average_grade`, and defer release approval + EAS prompts
         * in `foundry loop` until **both** the investor target is met and `convergence_contract` is converged
         * with no open/regressed objections (read from the latest artifact on disk).
         */
        autonomous_investor_convergence: z
            .object({
            enabled: z.preprocess((v) => {
                if (v === undefined || v === null)
                    return undefined;
                if (v === true || v === 1)
                    return true;
                if (v === false || v === 0)
                    return false;
                if (typeof v === "string") {
                    const s = v.trim().toLowerCase();
                    if (["true", "yes", "on", "1"].includes(s))
                        return true;
                    if (["false", "no", "off", "0"].includes(s))
                        return false;
                }
                return undefined;
            }, z.boolean().optional()),
            min_average_grade: z.string().optional(),
            relaxed_investor_gates: z.boolean().optional(),
            defer_release_prompt_until_investor_target: z.boolean().optional(),
        })
            .optional(),
    })
        .optional()),
    cursor_automation: z
        .object({
        enabled: z.boolean().optional(),
        command: z.string().optional(),
        builder_model: z.string().optional(),
        builder_fast_model: z.string().optional(),
        /** Used when `use_builder_economy_near_release` applies (default `auto`). */
        builder_economy_model: z.string().optional(),
        /** When true (default), use `builder_economy_model` if QA ship + no code blockers + release is awaiting_approval (not blocked_pre_release). */
        use_builder_economy_near_release: z.boolean().optional(),
        /** Model for `grand_wizard` consolidation (default `gpt-5.4-high`). */
        grand_wizard_model: z.string().optional(),
        qa_model: z.string().optional(),
        qa_strict_model: z.string().optional(),
        max_inner_loops: z.coerce.number().int().positive().optional(),
        timeout_minutes: z.coerce.number().int().positive().optional(),
    })
        .optional(),
    qa_automation: z
        .object({
        maestro: z
            .object({
            enabled: z.boolean().optional(),
            required: z.boolean().optional(),
            command: z.string().optional(),
            flow_path: z.string().optional(),
            install_if_missing: z.boolean().optional(),
            /** When set, run this shell command from the repo root instead of `maestro test …` (e.g. `npm run qa:device -- --debug-output .maestro-debug --flatten-debug-output`). */
            pipeline_command: z.string().optional(),
            /** When true, attempt to boot an iOS Simulator before running Maestro if none is currently booted. Defaults to true on macOS. */
            auto_boot_simulator: z.boolean().optional(),
            /** Preferred simulator name (substring match, e.g. "iPhone 16 Pro"). When unset, the newest available iPhone is selected. */
            preferred_simulator: z.string().optional(),
            /** Max seconds to wait for the simulator to reach `Booted` state after `simctl boot`. Default 90s. */
            boot_timeout_seconds: z.number().int().min(10).max(600).optional(),
        })
            .optional(),
    })
        .optional(),
    release_automation: z
        .object({
        eas: z
            .object({
            build_on_approval: z.boolean().optional(),
            command: z.string().optional(),
            profile: z.string().optional(),
            platform: z.enum(["ios", "android", "all"]).optional(),
            non_interactive: z.boolean().optional(),
        })
            .optional(),
    })
        .optional(),
    builder: z
        .object({
        directives: z
            .array(BuilderDirectiveSchema)
            .optional(),
    })
        .optional(),
});
function parseMetricTarget(value) {
    if (typeof value === "number")
        return value;
    if (typeof value !== "string")
        return Number.NaN;
    const raw = value.trim();
    if (!raw)
        return Number.NaN;
    const isPercent = raw.includes("%");
    // Accept formats like "50%", "$10", "1,200.5", "0.25"
    const numeric = raw.replace(/[$,%\s,]/g, "");
    const parsed = Number.parseFloat(numeric);
    if (!Number.isFinite(parsed))
        return Number.NaN;
    return isPercent ? parsed / 100 : parsed;
}
/** YAML often yields targets as strings (e.g. "50%", "$10", "0.25"). */
export const MetricsYamlSchema = z.object({
    metrics: z.array(z.object({
        key: z.string(),
        target: z.preprocess(parseMetricTarget, z
            .number()
            .refine((n) => Number.isFinite(n), { message: "target must be a finite number" })),
    })),
});
export const GatesYamlSchema = z.object({
    require_human_approval: z.array(z.string()),
});
export const FoundryConfigSchema = z.object({
    project: ProjectYamlSchema,
    metrics: MetricsYamlSchema,
    gates: GatesYamlSchema,
});
const REQUIRED_CONFIG_FILES = ["project.yaml", "metrics.yaml", "gates.yaml"];
export async function loadFoundryConfig(repoPath) {
    const foundryDir = join(repoPath, ".foundry");
    const missingFiles = (await Promise.all(REQUIRED_CONFIG_FILES.map(async (name) => {
        try {
            await access(join(foundryDir, name));
            return null;
        }
        catch {
            return name;
        }
    }))).filter((name) => Boolean(name));
    if (missingFiles.length > 0) {
        throw new Error(`Missing Foundry config file${missingFiles.length === 1 ? "" : "s"}: ${missingFiles.join(", ")} in ${foundryDir}. Run \`foundry init --repo ${repoPath}\` first.`);
    }
    const [projectRaw, metricsRaw, gatesRaw] = await Promise.all([
        readFile(join(foundryDir, "project.yaml"), "utf8"),
        readFile(join(foundryDir, "metrics.yaml"), "utf8"),
        readFile(join(foundryDir, "gates.yaml"), "utf8"),
    ]);
    return FoundryConfigSchema.parse({
        project: ProjectYamlSchema.parse(YAML.parse(projectRaw)),
        metrics: MetricsYamlSchema.parse(YAML.parse(metricsRaw)),
        gates: GatesYamlSchema.parse(YAML.parse(gatesRaw)),
    });
}
