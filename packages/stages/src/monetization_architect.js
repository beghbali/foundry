import { writeStageMarkdown } from "@foundry/core/artifacts";
import { InvestorRefinementContextSchema } from "@foundry/core/stageInputs";
import { z } from "zod";
import { ProductDefinitionOutputSchema } from "./product_definition.js";
const MonetizationInputSchema = z.object({
    config: z.object({
        project: z.object({
            project_name: z.string(),
            north_star: z.string(),
            core_differentiators: z.array(z.string()).optional(),
        }),
        metrics: z.object({
            metrics: z.array(z.object({
                key: z.string(),
                target: z.number(),
            })),
        }),
    }),
    productDefinition: ProductDefinitionOutputSchema,
    investorRefinement: InvestorRefinementContextSchema.optional(),
});
export const MonetizationOutputSchema = z.object({
    pricing: z.object({
        monthlyUsd: z.number(),
        yearlyUsd: z.number(),
        trialDays: z.number().optional(),
    }),
    entitlements: z.array(z.object({
        id: z.string(),
        description: z.string(),
    })),
    offerings: z.array(z.object({
        id: z.string(),
        packages: z.array(z.object({
            id: z.string(),
            productId: z.string(),
            entitlementId: z.string(),
        })),
    })),
    gates: z.array(z.object({
        feature: z.string(),
        freeLimit: z
            .object({
            type: z.enum(["count", "rate"]),
            value: z.number(),
            period: z.enum(["month", "week", "day"]),
        })
            .optional(),
        requiresEntitlement: z.string().optional(),
        paywallMoment: z.string(),
    })),
    analyticsEvents: z.array(z.object({
        name: z.string(),
        when: z.string(),
        properties: z.array(z.string()),
    })),
});
function inferDomain(input) {
    const haystack = [
        input.config.project.project_name,
        input.config.project.north_star,
        input.productDefinition.oneLiner,
    ]
        .join(" ")
        .toLowerCase();
    if (/\b(garden|gardening|gardener|plant|harvest|seed|soil)\b/.test(haystack)) {
        return "gardening";
    }
    return "generic";
}
function revenueMetricTarget(input) {
    const m = input.config.metrics.metrics.find((m) => /revenue|arr|mrr/i.test(m.key));
    return m?.target;
}
function buildGardening(input) {
    const projectName = input.config.project.project_name;
    const pid = projectName.toLowerCase().replace(/[^a-z0-9]/g, "_");
    return {
        pricing: {
            monthlyUsd: 4.99,
            yearlyUsd: 29.99,
            trialDays: 7,
        },
        entitlements: [
            {
                id: "pro",
                description: "Full access to unlimited weekly tasks, unlimited diagnosis workflows, multiple garden profiles, and full history.",
            },
        ],
        offerings: [
            {
                id: "default",
                packages: [
                    {
                        id: "monthly",
                        productId: `${pid}_pro_monthly`,
                        entitlementId: "pro",
                    },
                    {
                        id: "annual",
                        productId: `${pid}_pro_annual`,
                        entitlementId: "pro",
                    },
                ],
            },
        ],
        gates: [
            {
                feature: "weekly_action_plan",
                freeLimit: { type: "count", value: 1, period: "week" },
                requiresEntitlement: "pro",
                paywallMoment: "After the free user completes their 1 weekly task, show the paywall when they try to view additional recommendations.",
            },
            {
                feature: "diagnosis_workflow",
                freeLimit: { type: "count", value: 2, period: "month" },
                requiresEntitlement: "pro",
                paywallMoment: "When a free user starts their 3rd diagnosis in a calendar month, show the paywall before results load.",
            },
            {
                feature: "garden_profiles",
                freeLimit: { type: "count", value: 1, period: "month" },
                requiresEntitlement: "pro",
                paywallMoment: "When a free user taps 'Add another garden', show the paywall explaining that multiple gardens require Pro.",
            },
            {
                feature: "full_task_history",
                requiresEntitlement: "pro",
                paywallMoment: "Free users see only the current week's history. When they scroll past the fold into older history, show the paywall.",
            },
            {
                feature: "personalized_insights",
                requiresEntitlement: "pro",
                paywallMoment: "After 4 weeks of usage, surface a 'Your garden insights' card. Tapping it shows the paywall for free users.",
            },
        ],
        analyticsEvents: [
            {
                name: "paywall_shown",
                when: "A gate blocks a free user and the paywall UI is displayed.",
                properties: ["feature", "gate_trigger", "user_tenure_days", "tasks_completed_total"],
            },
            {
                name: "trial_started",
                when: "User begins the free trial from the paywall or settings.",
                properties: ["source_feature", "offering_id", "package_id"],
            },
            {
                name: "trial_converted",
                when: "Trial ends and the first paid renewal processes successfully.",
                properties: ["package_id", "trial_duration_days", "tasks_completed_during_trial"],
            },
            {
                name: "subscription_started",
                when: "User subscribes (non-trial) or renews after lapse.",
                properties: ["package_id", "offering_id", "is_resubscribe"],
            },
            {
                name: "subscription_cancelled",
                when: "User cancels their subscription (still active until period end).",
                properties: ["package_id", "tenure_months", "tasks_completed_total", "cancellation_reason"],
            },
            {
                name: "paywall_dismissed",
                when: "User closes the paywall without starting a trial or subscribing.",
                properties: ["feature", "gate_trigger", "dismiss_method"],
            },
            {
                name: "gate_hit",
                when: "A free-limit threshold is reached (tracked even before the paywall renders).",
                properties: ["feature", "limit_type", "limit_value", "current_usage"],
            },
        ],
    };
}
function buildGeneric(input) {
    const projectName = input.config.project.project_name;
    const pid = projectName.toLowerCase().replace(/[^a-z0-9]/g, "_");
    const workflows = input.productDefinition.coreWorkflows;
    const primaryWorkflow = workflows[0]?.name ?? "core workflow";
    return {
        pricing: {
            monthlyUsd: 5.99,
            yearlyUsd: 39.99,
            trialDays: 7,
        },
        entitlements: [
            {
                id: "pro",
                description: `Full access to unlimited ${primaryWorkflow.toLowerCase()} sessions, extended history, and premium features.`,
            },
        ],
        offerings: [
            {
                id: "default",
                packages: [
                    {
                        id: "monthly",
                        productId: `${pid}_pro_monthly`,
                        entitlementId: "pro",
                    },
                    {
                        id: "annual",
                        productId: `${pid}_pro_annual`,
                        entitlementId: "pro",
                    },
                ],
            },
        ],
        gates: [
            {
                feature: "primary_workflow",
                freeLimit: { type: "rate", value: 3, period: "week" },
                requiresEntitlement: "pro",
                paywallMoment: `After the free user reaches 3 ${primaryWorkflow.toLowerCase()} sessions in a week, show the paywall on the next attempt.`,
            },
            {
                feature: "history_and_context",
                requiresEntitlement: "pro",
                paywallMoment: "Free users see only the last 7 days of history. Attempting to access older data shows the paywall.",
            },
            ...(workflows.length > 1
                ? [
                    {
                        feature: workflows[1].name.toLowerCase().replace(/\s+/g, "_"),
                        freeLimit: { type: "count", value: 2, period: "month" },
                        requiresEntitlement: "pro",
                        paywallMoment: `After 2 free uses of ${workflows[1].name} per month, show the paywall before the next session.`,
                    },
                ]
                : []),
            {
                feature: "personalized_recommendations",
                requiresEntitlement: "pro",
                paywallMoment: "After enough usage data is collected, surface a 'personalized insights' prompt. Free users see the paywall on tap.",
            },
        ],
        analyticsEvents: [
            {
                name: "paywall_shown",
                when: "A gate blocks a free user and the paywall UI is displayed.",
                properties: ["feature", "gate_trigger", "user_tenure_days"],
            },
            {
                name: "trial_started",
                when: "User begins the free trial.",
                properties: ["source_feature", "offering_id", "package_id"],
            },
            {
                name: "trial_converted",
                when: "Trial ends and the first paid renewal processes.",
                properties: ["package_id", "trial_duration_days"],
            },
            {
                name: "subscription_started",
                when: "User subscribes or renews after lapse.",
                properties: ["package_id", "offering_id", "is_resubscribe"],
            },
            {
                name: "subscription_cancelled",
                when: "User cancels their subscription.",
                properties: ["package_id", "tenure_months", "cancellation_reason"],
            },
            {
                name: "paywall_dismissed",
                when: "User closes the paywall without acting.",
                properties: ["feature", "gate_trigger", "dismiss_method"],
            },
        ],
    };
}
function buildReadme(output, projectName, revenueTarget, investorRefinement) {
    const yearlyMonthly = (output.pricing.yearlyUsd / 12).toFixed(2);
    const savingsPercent = Math.round((1 - output.pricing.yearlyUsd / 12 / output.pricing.monthlyUsd) * 100);
    const lines = [
        `# ${projectName} — Monetization Architecture`,
        "",
        "## How we make money",
        "",
        `${projectName} uses a **freemium + subscription** model. The core experience is free with usage limits. Power users upgrade to **Pro** to remove limits and unlock the full feature set.`,
        "",
        "| Plan | Price | Notes |",
        "| --- | --- | --- |",
        `| Free | $0 | Limited usage per feature (see gates below) |`,
        `| Pro Monthly | $${output.pricing.monthlyUsd.toFixed(2)}/mo | Full access |`,
        `| Pro Annual | $${output.pricing.yearlyUsd.toFixed(2)}/yr ($${yearlyMonthly}/mo) | ${savingsPercent}% savings vs monthly |`,
    ];
    if (output.pricing.trialDays) {
        lines.push(`| Trial | ${output.pricing.trialDays} days | Full Pro access, then auto-converts |`);
    }
    if (revenueTarget !== undefined) {
        const targetDisplay = revenueTarget >= 1000
            ? `$${(revenueTarget / 1000).toFixed(0)}k`
            : `$${revenueTarget.toFixed(0)}`;
        lines.push("", `**Revenue target:** ${targetDisplay} (from metrics.yaml). At $${yearlyMonthly}/mo effective annual price, this requires ~${Math.ceil(revenueTarget / output.pricing.yearlyUsd)} annual subscribers or ~${Math.ceil(revenueTarget / 12 / output.pricing.monthlyUsd)} monthly subscribers.`);
    }
    lines.push("", "## What's free vs. paid", "", "| Feature | Free | Pro |", "| --- | --- | --- |");
    for (const gate of output.gates) {
        const featureLabel = gate.feature.replace(/_/g, " ");
        let freeCol;
        if (gate.freeLimit) {
            const period = gate.freeLimit.period === "month" ? "/mo" : gate.freeLimit.period === "week" ? "/wk" : "/day";
            freeCol = `${gate.freeLimit.value}${period}`;
        }
        else {
            freeCol = "Locked";
        }
        lines.push(`| ${featureLabel} | ${freeCol} | Unlimited |`);
    }
    lines.push("", "## Paywall moments", "", "Each gate has a specific moment when the paywall appears — always *after* the user has experienced value, never before.", "");
    for (const gate of output.gates) {
        lines.push(`- **${gate.feature.replace(/_/g, " ")}:** ${gate.paywallMoment}`);
    }
    lines.push("", "## RevenueCat configuration", "", "### Entitlements", "");
    for (const ent of output.entitlements) {
        lines.push(`- \`${ent.id}\`: ${ent.description}`);
    }
    lines.push("", "### Offerings & packages", "");
    for (const offering of output.offerings) {
        lines.push(`**Offering:** \`${offering.id}\``, "");
        for (const pkg of offering.packages) {
            lines.push(`- \`${pkg.id}\` → product \`${pkg.productId}\` → entitlement \`${pkg.entitlementId}\``);
        }
        lines.push("");
    }
    lines.push("## Analytics events", "");
    for (const evt of output.analyticsEvents) {
        lines.push(`- **${evt.name}:** ${evt.when}`);
        lines.push(`  - Properties: ${evt.properties.map((p) => `\`${p}\``).join(", ")}`);
    }
    if (investorRefinement) {
        lines.push("", "## Investor panel refinement", "", `Round ${investorRefinement.round} — incorporate into pricing, gates, and analytics events:`, "", ...investorRefinement.directives.map((d) => `- ${d}`), "", "_See also `product_definition` must-ship items updated in the same refinement round._", "");
    }
    lines.push("");
    return lines.join("\n");
}
export const monetizationArchitectStage = {
    name: "monetization_architect",
    description: "Design RevenueCat-ready monetization config: pricing, entitlements, offerings, gates, and analytics events.",
    inputSchema: MonetizationInputSchema,
    outputSchema: MonetizationOutputSchema,
    async run(ctx, input) {
        const domain = inferDomain(input);
        const revTarget = revenueMetricTarget(input);
        ctx.logger("[monetization_architect] designing", {
            project: input.config.project.project_name,
            domain,
            workflows: input.productDefinition.coreWorkflows.length,
            metricsCount: input.config.metrics.metrics.length,
            revenueTarget: revTarget,
        });
        const output = domain === "gardening" ? buildGardening(input) : buildGeneric(input);
        const validated = MonetizationOutputSchema.parse(output);
        await writeStageMarkdown(ctx, "monetization_architect", "README.md", buildReadme(validated, input.config.project.project_name, revTarget, input.investorRefinement));
        return validated;
    },
};
