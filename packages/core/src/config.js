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
export const ProjectYamlSchema = z.object({
    project_name: z.string(),
    repo_type: z.string(),
    north_star: z.string(),
    constraints: z.array(z.string()).optional(),
    core_differentiators: z.array(z.string()).optional(),
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
