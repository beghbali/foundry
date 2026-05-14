import { writeStageMarkdown } from "@foundry/core/artifacts";
import { InvestorRefinementContextSchema } from "@foundry/core/stageInputs";
import { z } from "zod";
import { ConvergenceContractOutputSchema } from "./convergence_contract.js";
import { FlywheelOutputSchema } from "./flywheel_designer.js";
import { RepoInventoryOutputSchema } from "./repo_inventory.js";
const ProductDefInputSchema = z.object({
    config: z.object({
        project: z.object({
            project_name: z.string(),
            repo_type: z.string().optional(),
            north_star: z.string(),
            core_differentiators: z.array(z.string()).optional(),
            constraints: z.array(z.string()).optional(),
        }),
    }),
    repoInventory: RepoInventoryOutputSchema,
    flywheel: FlywheelOutputSchema,
    /**
     * When present, `product_definition` defers to the contract for the singular loop,
     * MVP scope (mustShip / wontShip), one-liner, and target user. Investor directives
     * are *not* re-applied here because they were already metabolized into the contract;
     * applying them twice causes Phase-1 scope to grow with every refinement round.
     */
    convergenceContract: ConvergenceContractOutputSchema.optional(),
    investorRefinement: InvestorRefinementContextSchema.optional(),
});
export const ProductDefinitionOutputSchema = z.object({
    oneLiner: z.string(),
    targetUser: z.string(),
    coreWorkflows: z.array(z.object({
        name: z.string(),
        steps: z.array(z.string()),
        successMetric: z.string(),
    })),
    differentiators: z.array(z.string()),
    scope: z.object({
        mustShip: z.array(z.string()),
        shouldShip: z.array(z.string()),
        wontShip: z.array(z.string()),
    }),
    acceptanceCriteria: z.array(z.object({
        id: z.string(),
        description: z.string(),
        test: z.string(),
    })),
});
function applyInvestorRefinement(out, ir) {
    return {
        ...out,
        scope: {
            ...out.scope,
            mustShip: [
                ...ir.directives.map((d) => `[Investor refinement r${ir.round}] ${d}`),
                ...out.scope.mustShip,
            ],
        },
    };
}
/**
 * When `convergence_contract` is present, it is the source of truth for MVP scope.
 * We rebuild `product_definition` to enforce: one core workflow, mustShip from the
 * contract (capped), and wontShip = parked items. Differentiators and capability-aware
 * acceptance criteria from the domain builders are preserved (they're informed by the
 * repo inventory, which the contract doesn't replace).
 */
function applyConvergenceContract(out, contract) {
    const loop = contract.singularLoop;
    const singleWorkflow = {
        name: loop.name,
        steps: loop.steps,
        successMetric: `${loop.northStarMetric.key} — ${loop.northStarMetric.definition}`,
    };
    return {
        ...out,
        oneLiner: contract.productThesis,
        targetUser: contract.targetUser,
        coreWorkflows: [singleWorkflow],
        scope: {
            mustShip: contract.mvpBoundary.mustShip,
            shouldShip: out.scope.shouldShip.filter((s) => !contract.mvpBoundary.mustNotShipYet.some((p) => p.toLowerCase() === s.toLowerCase())),
            wontShip: Array.from(new Set([
                ...contract.mvpBoundary.mustNotShipYet,
                ...out.scope.wontShip,
            ])),
        },
    };
}
function inferDomain(input) {
    const haystack = [
        input.config.project.project_name,
        input.config.project.repo_type ?? "",
        input.config.project.north_star,
        ...(input.config.project.constraints ?? []),
        ...(input.config.project.core_differentiators ?? []),
        ...input.flywheel.flywheel.map((f) => f.loopName),
    ]
        .join(" ")
        .toLowerCase();
    if (/\b(garden|gardening|gardener|plant|harvest|seed|soil)\b/.test(haystack)) {
        return "gardening";
    }
    if (/\b(web_data_platform|data platform|cleanroom|clean room|snowflake|databricks|redshift|bigquery|warehouse|evidence pack|trust ledger|policy hash|agreement hash|overlap|cross-cloud|aws)\b/.test(haystack)) {
        return "web_data_platform";
    }
    return "generic";
}
function getCapabilities(input) {
    const inv = input.repoInventory;
    return {
        hasMobile: !!inv.detected.mobileAppDir,
        hasSupabase: inv.summary.hasSupabase,
        hasExpo: inv.summary.hasExpo,
        hasRulesEngine: !!inv.detected.rulesEngineDir,
        stack: inv.summary.repoTypeGuess,
    };
}
function buildGardening(input, caps) {
    const projectName = input.config.project.project_name;
    const northStar = input.config.project.north_star;
    const configDifferentiators = input.config.project.core_differentiators ?? [];
    const primaryLoop = input.flywheel.flywheel[0];
    const phase1Focus = input.flywheel.focusRecommendation.phase1;
    const platform = caps.hasExpo ? "mobile (Expo/React Native)" : "the primary client";
    const oneLiner = `${projectName} is a ${platform} app that tells gardeners exactly what to do this week — personalized by their garden, location, and season — so every grower gets better outcomes with less guesswork.`;
    const targetUser = "Home gardeners (beginner to intermediate) who want guided, season-aware recommendations instead of generic reference content. They garden in containers, raised beds, or small plots and check their phone weekly to decide what to do next.";
    const coreWorkflows = [
        {
            name: "Weekly Action Plan",
            steps: [
                `Open ${projectName} at the start of the week${caps.hasMobile ? " on mobile" : ""}.`,
                "View 1-3 recommended tasks based on garden setup, season, and plant stage.",
                "Tap a task to see why it matters and how to do it.",
                "Mark the task done with a quick log (optional photo).",
                "See the plan update and preview what's coming next week.",
            ],
            successMetric: "weekly_action_plan_completion_rate — % of active gardeners who complete at least one recommended task per week.",
        },
        {
            name: "Diagnosis to Recovery",
            steps: [
                "Notice a pest, disease, or unexpected growth issue.",
                `Open ${projectName} and describe or photograph the symptom.`,
                "Receive a likely diagnosis with context on why it happened.",
                "Follow a short recovery checklist with timeline.",
                "Log whether symptoms improved after the suggested window.",
            ],
            successMetric: "issue_recovery_workflow_completion_rate — % of diagnosis sessions that reach a completed recovery workflow.",
        },
        {
            name: "Garden Setup & Memory",
            steps: [
                `Create a garden profile in ${projectName}: location, type (container/raised bed/in-ground), and experience level.`,
                "Add plants by name or photo.",
                `${projectName} begins personalizing recommendations immediately.`,
                "As tasks are completed, the profile deepens automatically.",
                "Future recommendations reflect the garden's actual history.",
            ],
            successMetric: "garden_profile_completeness — share of active gardeners with enough data to personalize recommendations.",
        },
    ];
    const differentiators = [
        ...configDifferentiators,
        "Weekly action plan personalized by garden setup, location, and season — not generic calendar advice.",
        "Diagnosis resolves into a recovery workflow with steps and follow-up, not just a species label.",
        ...(caps.hasRulesEngine
            ? ["Rules engine enables deterministic, auditable care logic that users can trust."]
            : []),
        ...(caps.hasSupabase
            ? ["Supabase backend enables real-time sync, edge functions, and a compounding outcome-data loop."]
            : []),
    ];
    const mustShip = [
        `Weekly action feed on ${platform} showing 1-3 personalized tasks.`,
        "Garden setup flow: location, garden type, experience level, initial plants.",
        "Task completion logging with optional photo capture.",
        "Seasonal awareness: recommendations adjust by month and hardiness zone.",
        ...(caps.hasSupabase ? ["Supabase auth + profile storage for garden state and task history."] : []),
    ];
    const shouldShip = [
        "Diagnosis-to-recovery workflow (photo or text input).",
        "Push notification reminders for upcoming or overdue tasks.",
        "Basic outcome tracking: did the plant thrive, struggle, or die after a recommendation?",
        ...(caps.hasRulesEngine ? ["Rules-engine-driven care schedules for common plant types."] : []),
    ];
    const wontShip = [
        "Social feed, community features, or user-to-user messaging.",
        "Plant marketplace or e-commerce integration.",
        "AR/camera-based garden planning or 3D bed layout.",
        "Desktop or web client (mobile-first until engagement is proven).",
        "Gamification badges not tied to real garden outcomes.",
    ];
    const acceptanceCriteria = [
        {
            id: "AC-01",
            description: "A new gardener can set up a garden profile and see a personalized weekly plan within 3 minutes.",
            test: "End-to-end test: create account → complete garden setup → verify at least 1 task appears in the weekly feed.",
        },
        {
            id: "AC-02",
            description: "Completing a task updates the garden profile and adjusts future recommendations.",
            test: "Complete a recommended task → verify next week's plan differs from the default (regression test against static output).",
        },
        {
            id: "AC-03",
            description: "Recommendations are season-aware and change across months.",
            test: "Mock the current date to January vs. July for the same garden profile → verify different task sets are generated.",
        },
        {
            id: "AC-04",
            description: "The weekly plan loads in under 2 seconds on a mid-range device.",
            test: `Performance test on ${caps.hasExpo ? "Expo Go / dev build" : "target device"}: measure time from app-open to plan-rendered.`,
        },
        ...(caps.hasSupabase
            ? [
                {
                    id: "AC-05",
                    description: "Garden state syncs across devices via Supabase without data loss.",
                    test: "Log a task on device A → sign in on device B → verify the task and updated plan appear within 5 seconds.",
                },
            ]
            : []),
        {
            id: caps.hasSupabase ? "AC-06" : "AC-05",
            description: "The diagnosis workflow produces a recovery checklist, not just an identification label.",
            test: "Submit a known pest symptom → verify the response includes at least 2 recovery steps and a follow-up timeframe.",
        },
    ];
    return {
        oneLiner,
        targetUser,
        coreWorkflows,
        differentiators,
        scope: { mustShip, shouldShip, wontShip },
        acceptanceCriteria,
    };
}
function buildWebDataPlatform(input, caps) {
    const projectName = input.config.project.project_name;
    const northStar = input.config.project.north_star;
    const configDifferentiators = input.config.project.core_differentiators ?? [];
    return {
        oneLiner: `${projectName} is an enterprise web application and cloud data control plane for governed cross-cloud collaboration across warehouses without exposing raw customer data.`,
        targetUser: "Business partnership, measurement, data engineering, security, and legal teams that need Snowflake, Redshift, Databricks, BigQuery, or AWS data collaboration with auditable policy enforcement.",
        coreWorkflows: [
            {
                name: "Partner Collaboration Setup",
                steps: [
                    "Create or select the first organization and invite/select the partner organization.",
                    "Choose the collaboration goal, such as audience overlap or approved measurement.",
                    "Register participating datasets with business labels and technical owners.",
                    "Assign business, data engineering, security, and legal reviewers.",
                    "Advance only after the collaboration scope is approved.",
                ],
                successMetric: "collaboration_setup_completion_rate — Percent of collaborations that reach approved dataset selection.",
            },
            {
                name: "Warehouse Connector Verification",
                steps: [
                    "Choose Fast Demo or Enterprise Setup for Redshift, Snowflake, Databricks, BigQuery, or AWS.",
                    "Generate least-privilege setup SQL/IAM instructions for the selected platform.",
                    "Capture connector settings, schema/table references, and credential placeholders.",
                    "Verify connection, read-only access, approved table/view access, and lack of obvious write/admin privileges.",
                    "Store only connector metadata, verification posture, policy references, and hashes.",
                ],
                successMetric: "verified_connector_rate — Percent of configured connectors that pass least-privilege dry-run checks.",
            },
            {
                name: "Executable Agreement And Policy Approval",
                steps: [
                    "Generate a human-readable agreement preview for the selected parties and use case.",
                    "Compile agreement terms into policy checks for purpose, retention, allowed fields, min_cohort, and outputs.",
                    "Show policy diffs and hashes so legal terms are bound to executable enforcement.",
                    "Collect required business, legal, security, and data-owner approvals.",
                    "Lock the agreement snapshot and policy hash before execution.",
                ],
                successMetric: "policy_approval_cycle_time — Median time from agreement draft to locked policy approval.",
            },
            {
                name: "Governed Overlap Run And Evidence Pack",
                steps: [
                    "Run the approved overlap job against verified connector inputs.",
                    "Enforce min_cohort and suppress any result that violates policy.",
                    "Display aggregate-only results with suppressed-group explanations.",
                    "Generate an evidence pack with run, party, connector, policy, agreement, query, row-count, suppression, and app-version fields.",
                    "Record the run in the Trust Ledger for audit and download.",
                ],
                successMetric: "evidence_pack_completion_rate — Percent of approved runs that produce a complete downloadable evidence pack.",
            },
        ],
        differentiators: [
            `North star: ${northStar}`,
            ...configDifferentiators,
            "Executable agreements bind legal terms to policy checks, hashes, and run receipts.",
            "Trust Ledger makes collaboration history, connector posture, policy versions, query hashes, and evidence packs audit-ready.",
            "Business-user workflow hides raw SQL while preserving setup detail for security and data engineering reviewers.",
            "Cross-cloud control plane works with existing warehouses and cloud infrastructure instead of forcing a proprietary cleanroom.",
        ],
        scope: {
            mustShip: [
                "Web app workflow to create organizations, invite/select a partner, choose a collaboration goal, and register datasets.",
                "Connector setup for the primary MVP pair with Fast Demo and Enterprise Setup modes.",
                "Redshift and Snowflake connector metadata forms with least-privilege setup instructions and dry-run verification.",
                "Agreement generator that produces a human-readable preview and binds it to an executable policy hash.",
                "Policy approval workflow covering purpose, retention, allowed fields, min_cohort, and output limits.",
                "Overlap runner that produces aggregate-only results and enforces min_cohort suppression before display or export.",
                "Evidence pack generator with run, party, connector, policy, agreement, query, row-count, suppression, and app-version fields.",
                "Trust Ledger UI showing prior runs, statuses, parties, use cases, policy versions, result summaries, and evidence downloads.",
            ],
            shouldShip: [
                "Databricks and BigQuery connector stubs that share the same verification and evidence model.",
                "Security reviewer view exposing role names, permission checks, query hashes, connector posture, and evidence JSON.",
                "Synthetic seed/demo data scripts for FurnitureCo and BankCo kept separate from production connector code.",
                "Robust failure states for connector failure, missing table, missing permission, policy mismatch, and min_cohort suppression.",
                ...(caps.hasSupabase ? ["Supabase-backed persistence for metadata, approvals, policies, run records, and evidence artifacts."] : []),
            ],
            wontShip: [
                "Mobile application surface before the web data-platform workflow is proven.",
                "Full PSI, confidential computing, TEE attestation, or differential privacy unless actually implemented.",
                "Raw customer row storage, raw joined record storage, or unhashed identifier persistence.",
                "Production data marketplace, ad activation network, or broad partner discovery.",
                "Requiring business users to write SQL in the primary workflow.",
            ],
        },
        acceptanceCriteria: [
            {
                id: "AC-01",
                description: "A business user can create a collaboration, choose the overlap use case, register datasets, and reach agreement review without writing SQL.",
                test: "End-to-end web test: create FurnitureCo + BankCo collaboration -> choose cobranded credit card offer -> register datasets -> verify agreement preview appears.",
            },
            {
                id: "AC-02",
                description: "Connector setup supports demo and enterprise modes and verifies least-privilege read access.",
                test: "Unit/integration test connector dry-run paths for success, missing table, missing permission, and write/admin privilege warnings.",
            },
            {
                id: "AC-03",
                description: "Agreement terms compile into a stable policy hash and policy changes produce a different hash before approval.",
                test: "Unit test policy compiler and agreement generator: same input hash is stable; changed purpose/min_cohort/retention changes the hash.",
            },
            {
                id: "AC-04",
                description: "Overlap results enforce min_cohort before any segment is displayed, exported, or included in an evidence pack.",
                test: "Unit test overlap runner with cohorts above and below threshold; below-threshold groups are suppressed with reasons.",
            },
            {
                id: "AC-05",
                description: "Every completed run creates a Trust Ledger entry and downloadable evidence pack with required audit fields.",
                test: "Integration test run completion -> evidence pack JSON includes run_id, timestamp, parties, connector IDs, policy hash, agreement hash, query hashes, row counts, min_cohort, suppressed groups, output summary, and app version.",
            },
        ],
    };
}
function buildGeneric(input, caps) {
    const projectName = input.config.project.project_name;
    const northStar = input.config.project.north_star;
    const configDifferentiators = input.config.project.core_differentiators ?? [];
    const primaryLoop = input.flywheel.flywheel[0];
    const phase1Focus = input.flywheel.focusRecommendation.phase1;
    const platform = caps.hasExpo
        ? "mobile (Expo/React Native)"
        : caps.stack === "node"
            ? "web application"
            : "the primary client";
    const oneLiner = `${projectName} is a ${platform} product that delivers ${northStar.toLowerCase().replace(/\.$/, "")} through an opinionated, guided workflow — so users get results without configuration overhead.`;
    const targetUser = `Users who need ${northStar.toLowerCase().replace(/\.$/, "")} but find existing tools too broad, too manual, or too slow to deliver value in the first session.`;
    const coreWorkflows = primaryLoop
        ? [
            {
                name: "Core Value Loop",
                steps: primaryLoop.steps.map((s) => s.length > 120 ? s.slice(0, 117) + "..." : s),
                successMetric: `${primaryLoop.metric.key} — ${primaryLoop.metric.definition}`,
            },
            ...(input.flywheel.flywheel.length > 1
                ? [
                    {
                        name: input.flywheel.flywheel[1].loopName,
                        steps: input.flywheel.flywheel[1].steps.map((s) => s.length > 120 ? s.slice(0, 117) + "..." : s),
                        successMetric: `${input.flywheel.flywheel[1].metric.key} — ${input.flywheel.flywheel[1].metric.definition}`,
                    },
                ]
                : []),
        ]
        : [
            {
                name: "Primary Workflow",
                steps: [
                    "User arrives with a job to do.",
                    "The product recommends the next best action.",
                    "User completes the action and sees a result.",
                    "The product learns and improves the next recommendation.",
                ],
                successMetric: "next_best_action_completion_rate — % of sessions where the recommended action is completed.",
            },
        ];
    const differentiators = [
        ...configDifferentiators,
        "Opinionated defaults that deliver value before the user invests effort.",
        "Guided workflow that compounds with usage instead of requiring upfront configuration.",
    ];
    const mustShip = [
        `Core value loop on ${platform}: ${phase1Focus[0] ?? "shortest path from trigger to outcome."}`,
        "First-session value: a new user completes the primary job without onboarding friction.",
        ...(caps.hasSupabase ? ["Supabase auth + data persistence for user context."] : []),
        "Outcome visibility: the user sees a concrete result after each interaction.",
    ];
    const shouldShip = [
        "Progressive personalization as the product learns from usage.",
        "Notification or reminder when a recurring trigger occurs.",
        ...(phase1Focus.length > 2 ? [phase1Focus[2]] : []),
    ];
    const wontShip = [
        "Broad feature surface beyond the validated core loop.",
        "Social or community features before retention is proven.",
        "Integrations or plugins before the primary workflow is sticky.",
        "Paid acquisition channels before organic referral signals appear.",
    ];
    const acceptanceCriteria = [
        {
            id: "AC-01",
            description: "A new user completes the core job in the first session without guidance.",
            test: "End-to-end test: new account → complete primary workflow → verify outcome is visible.",
        },
        {
            id: "AC-02",
            description: "Repeat usage improves recommendation relevance.",
            test: "Simulate 4 sessions of usage → verify the product adapts output based on accumulated context.",
        },
        {
            id: "AC-03",
            description: "The primary workflow completes in under 3 seconds on target hardware.",
            test: "Performance test: measure time from action trigger to visible result.",
        },
        ...(caps.hasSupabase
            ? [
                {
                    id: "AC-04",
                    description: "User context persists and syncs via Supabase.",
                    test: "Complete an action → sign in on a new device → verify context and history appear.",
                },
            ]
            : []),
    ];
    return {
        oneLiner,
        targetUser,
        coreWorkflows,
        differentiators,
        scope: { mustShip, shouldShip, wontShip },
        acceptanceCriteria,
    };
}
function buildReadme(output, projectName) {
    const lines = [
        `# ${projectName} — Product Definition`,
        "",
        `> ${output.oneLiner}`,
        "",
        "## Target User",
        "",
        output.targetUser,
        "",
        "## Core Workflows",
        "",
    ];
    for (const wf of output.coreWorkflows) {
        lines.push(`### ${wf.name}`, "");
        wf.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
        lines.push("", `**Success metric:** ${wf.successMetric}`, "");
    }
    lines.push("## Differentiators", "");
    output.differentiators.forEach((d) => lines.push(`- ${d}`));
    lines.push("", "## Scope", "", "### Must ship (Phase 1)", "");
    output.scope.mustShip.forEach((s) => lines.push(`- ${s}`));
    lines.push("", "### Should ship (Phase 1 stretch)", "");
    output.scope.shouldShip.forEach((s) => lines.push(`- ${s}`));
    lines.push("", "### Won't ship (Phase 1)", "");
    output.scope.wontShip.forEach((s) => lines.push(`- ${s}`));
    lines.push("", "## Acceptance Criteria", "");
    output.acceptanceCriteria.forEach((ac) => {
        lines.push(`- **${ac.id}:** ${ac.description}`);
        lines.push(`  - _Test:_ ${ac.test}`);
    });
    lines.push("");
    return lines.join("\n");
}
export const productDefinitionStage = {
    name: "product_definition",
    description: "Synthesize flywheel loops and repo capabilities into a concrete product definition with workflows, scope, and acceptance criteria.",
    inputSchema: ProductDefInputSchema,
    outputSchema: ProductDefinitionOutputSchema,
    async run(ctx, input) {
        const domain = inferDomain(input);
        const caps = getCapabilities(input);
        ctx.logger("[product_definition] building", {
            project: input.config.project.project_name,
            domain,
            stack: caps.stack,
            hasMobile: caps.hasMobile,
            hasSupabase: caps.hasSupabase,
            hasRulesEngine: caps.hasRulesEngine,
            flywheelLoops: input.flywheel.flywheel.length,
        });
        let output = domain === "gardening"
            ? buildGardening(input, caps)
            : domain === "web_data_platform"
                ? buildWebDataPlatform(input, caps)
                : buildGeneric(input, caps);
        if (input.convergenceContract) {
            // Convergence contract is authoritative; investor directives were already
            // metabolized into it, so we do NOT also call `applyInvestorRefinement`.
            output = applyConvergenceContract(output, input.convergenceContract);
        }
        else if (input.investorRefinement) {
            // Legacy fallback for pipelines that haven't adopted convergence_contract yet.
            output = applyInvestorRefinement(output, input.investorRefinement);
        }
        const validated = ProductDefinitionOutputSchema.parse(output);
        await writeStageMarkdown(ctx, "product_definition", "README.md", buildReadme(validated, input.config.project.project_name));
        return validated;
    },
};
