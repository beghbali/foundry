import { writeStageMarkdown } from "@foundry/core/artifacts";
import { z } from "zod";
import { MarketGapOutputSchema } from "./market_gap_analysis.js";
import { RepoInventoryOutputSchema } from "./repo_inventory.js";
const WedgeMoveSchema = z.object({
    move: z.string(),
    why_it_wins: z.string(),
    moat_vector: z.enum(["data", "workflow", "distribution", "engineering"]),
    minimum_viable_proof: z.string(),
});
const FirstPrinciplesHintSchema = z.object({
    wedge_moves: z.array(WedgeMoveSchema).optional(),
}).optional();
const FlywheelInputSchema = z.object({
    config: z.object({
        project: z.object({
            project_name: z.string(),
            north_star: z.string(),
            core_differentiators: z.array(z.string()).optional(),
        }),
    }),
    repoInventory: RepoInventoryOutputSchema,
    marketGap: MarketGapOutputSchema,
    firstPrinciples: FirstPrinciplesHintSchema,
});
export const FlywheelOutputSchema = z.object({
    flywheel: z.array(z.object({
        loopName: z.string(),
        steps: z.array(z.string()).min(4).max(7),
        trigger: z.string(),
        valueCreated: z.string(),
        metric: z.object({
            key: z.string(),
            definition: z.string(),
        }),
        risks: z.array(z.string()),
    })),
    focusRecommendation: z.object({
        phase1: z.array(z.string()).min(3).max(5),
        phase2: z.array(z.string()),
    }),
});
function inferDomain(input) {
    const haystack = [
        input.config.project.project_name,
        input.config.project.north_star,
        ...input.marketGap.gapsToExploit.map((g) => g.gap),
        ...input.marketGap.commonComplaints.map((c) => c.theme),
    ]
        .join(" ")
        .toLowerCase();
    if (/\b(garden|gardening|gardener|plant|harvest|seed|soil|bed|companion planting)\b/.test(haystack)) {
        return "gardening";
    }
    return "generic";
}
function primaryDifferentiator(input) {
    return input.config.project.core_differentiators?.[0] ?? "opinionated workflows";
}
function buildGardeningFlywheel(input) {
    const differentiatedBy = primaryDifferentiator(input);
    const northStar = input.config.project.north_star;
    const hasExpo = input.repoInventory.summary.hasExpo;
    return {
        flywheel: [
            {
                loopName: "Outcome -> Trust -> Retention -> Referral Growth Loop",
                steps: [
                    "Verdant helps a gardener succeed with the right task at the right time.",
                    "Better garden outcomes build trust in Verdant's guidance.",
                    "Trusted guidance increases weekly retention and repeat check-ins.",
                    "Retained gardeners log more actions, photos, and results.",
                    "More outcome data improves personalization and recommendation quality.",
                    "Better results create more referrals, organic sharing, and new gardener acquisition.",
                ],
                trigger: "A first successful weekly recommendation or visible garden win",
                valueCreated: "Turns product outcomes into compounding retention, organic acquisition, and better recommendation quality.",
                metric: {
                    key: "retained_gardener_referral_rate",
                    definition: "Percent of retained weekly gardeners who invite, refer, or share a successful outcome that drives a new activated user.",
                },
                risks: [
                    "Users get value but do not naturally share or invite others.",
                    "Outcome data is too sparse to improve recommendations meaningfully.",
                    "The app creates utility without enough emotional payoff to trigger word of mouth.",
                ],
            },
            {
                loopName: "Weekly Garden Momentum Loop",
                steps: [
                    "A gardener opens the app to see what matters this week.",
                    "The app recommends 1-3 timely tasks based on season, garden setup, and plant stage.",
                    "The gardener completes a task and logs the outcome with one quick action.",
                    "The app updates the plan and surfaces the next best action.",
                    "Visible progress increases confidence and creates a reason to return next week.",
                ],
                trigger: "Start of week, weather shift, or plant-stage change",
                valueCreated: `Creates a repeatable weekly habit around ${northStar}.`,
                metric: {
                    key: "weekly_action_plan_completion_rate",
                    definition: "Percent of active gardeners who complete at least one recommended weekly task.",
                },
                risks: [
                    "Recommendations feel generic for local conditions.",
                    "Logging the outcome takes too many taps.",
                    "Too many tasks reduce trust and completion.",
                ],
            },
            {
                loopName: "Problem To Recovery Trust Loop",
                steps: [
                    "A gardener notices a pest, disease, or growth issue.",
                    "The app helps identify the likely problem and explains why it happened.",
                    "The app turns diagnosis into a short recovery workflow.",
                    "The gardener follows the plan and records whether symptoms improve.",
                    "Successful recoveries increase trust and future reliance on the app.",
                ],
                trigger: "Plant symptom, failed harvest expectation, or photo-based diagnosis request",
                valueCreated: "Turns anxiety into confidence by making issue resolution actionable instead of informational.",
                metric: {
                    key: "issue_recovery_workflow_completion_rate",
                    definition: "Percent of diagnosis sessions that progress to a completed recovery workflow.",
                },
                risks: [
                    "Advice lacks enough context to be credible.",
                    "Diagnosis accuracy is too low for repeated trust.",
                    "Recovery plans are too long or ambiguous.",
                ],
            },
            {
                loopName: "Garden Memory To Personalization Loop",
                steps: [
                    "The gardener records plants, beds, containers, or recent actions.",
                    "The app learns the garden layout, preferences, and care patterns.",
                    `Recommendations become more relevant and feel tailored by ${differentiatedBy}.`,
                    "Better recommendations lead to more logging because the value is obvious.",
                    "The app becomes the default system of record for future decisions.",
                ],
                trigger: "New plant added, first task completed, or first photo/log entry",
                valueCreated: "Compounds product value over time by making future guidance more personalized.",
                metric: {
                    key: "garden_profile_completeness",
                    definition: "Share of active gardeners with enough plant/location/history data to personalize recommendations.",
                },
                risks: [
                    "Initial setup feels like admin work.",
                    "Users do not understand why logging improves recommendations.",
                    hasExpo ? "Mobile capture is slower than notes/photos outside the app." : "Capture flow is slower than alternative tools.",
                ],
            },
        ],
        focusRecommendation: {
            phase1: [
                "Design the weekly action feed as the engine of retention, not just a feature.",
                "Make every completed task easy to log so outcome data improves future recommendations.",
                "Create shareable gardener wins or milestones that can drive organic acquisition.",
                "Make diagnosis resolve into a concrete recovery checklist, not just identification.",
                "Personalize recommendations using garden type, experience level, and current season from day one.",
            ],
            phase2: [
                "Layer in outcome-based learning to improve recommendations from real gardener success patterns.",
                "Add richer garden memory features like bed planning, yield tracking, and recurring seasonal planning.",
                "Expand social and referral mechanics once the weekly recommendation loop is consistently sticky.",
            ],
        },
    };
}
function buildGenericFlywheel(input) {
    const differentiatedBy = primaryDifferentiator(input);
    const topGap = input.marketGap.gapsToExploit[0]?.gap ?? "timely decision support";
    const topComplaint = input.marketGap.commonComplaints[0]?.theme ?? "high cognitive load";
    return {
        flywheel: [
            {
                loopName: "Outcome -> Retention -> Referral Loop",
                steps: [
                    "The product helps a user complete an important job successfully.",
                    "That success builds trust and increases repeat usage.",
                    "Repeat users generate more context and behavior data.",
                    "More context improves recommendation quality and relevance.",
                    "Better outcomes create referrals, social proof, and cheaper acquisition.",
                ],
                trigger: "First successful user outcome",
                valueCreated: "Compounds product success into stronger retention and lower-cost growth.",
                metric: {
                    key: "retained_user_referral_rate",
                    definition: "Percent of retained users who generate a referral, invite, or attributable organic conversion.",
                },
                risks: [
                    "Success is not visible enough to become shareable.",
                    "Users return but do not deepen engagement or contribute data.",
                    "Referral mechanics are added before the core value loop is strong.",
                ],
            },
            {
                loopName: "Guided Action Loop",
                steps: [
                    "A user arrives with a concrete job to do.",
                    "The app recommends the next best action immediately.",
                    "The user completes the action and sees a useful outcome.",
                    "The product learns from that action and improves the next recommendation.",
                    "Higher trust drives repeat usage and deeper setup over time.",
                ],
                trigger: "A recurring user need or decision point",
                valueCreated: `Transforms ${topGap.toLowerCase()} into repeatable product value.`,
                metric: {
                    key: "next_best_action_completion_rate",
                    definition: "Percent of sessions where the recommended next action is completed.",
                },
                risks: [
                    `Recommendations do not address ${topComplaint.toLowerCase()}.`,
                    "The user cannot see why the next action matters.",
                    "Setup cost is higher than first-session value.",
                ],
            },
            {
                loopName: "Trust And Personalization Loop",
                steps: [
                    "The user shares context or preferences.",
                    "The app adapts the workflow around that context.",
                    "Recommendations feel more relevant and save time.",
                    "The user contributes more data because the benefit is obvious.",
                    `The product compounds differentiation around ${differentiatedBy}.`,
                ],
                trigger: "First successful recommendation or workflow completion",
                valueCreated: "Makes the product harder to replace as relevance improves with use.",
                metric: {
                    key: "personalized_recommendation_acceptance_rate",
                    definition: "Percent of personalized recommendations accepted or completed by active users.",
                },
                risks: [
                    "The personalization model is too opaque.",
                    "Context collection feels intrusive or burdensome.",
                    "Users do not experience a clear before/after difference.",
                ],
            },
        ],
        focusRecommendation: {
            phase1: [
                "Build the shortest path from user trigger to a successful outcome that users will repeat.",
                "Make the retained-user loop measurable before expanding the surface area of the product.",
                "Explain every recommendation clearly enough to build trust and repeat use.",
                "Delay broad feature expansion until the core loop has repeat usage.",
            ],
            phase2: [
                "Use accumulated user context to deepen personalization.",
                "Add adjacent workflows that strengthen the primary repeat loop and referral potential.",
            ],
        },
    };
}
function buildReadme(output) {
    const phase1 = output.flywheel[0];
    const trigger = phase1.trigger.charAt(0).toLowerCase() + phase1.trigger.slice(1);
    const valueCreated = phase1.valueCreated.charAt(0).toLowerCase() + phase1.valueCreated.slice(1);
    const lines = [
        "# Flywheel Designer",
        "",
        `**Phase 1 flywheel:** ${phase1.loopName} starts when ${trigger}, moves through ${phase1.steps.length} steps, and ${valueCreated}. This should be treated as the main business loop to validate first.`,
        "",
        "## Metrics to track",
        "",
        ...output.flywheel.map((loop) => `- **${loop.metric.key}**: ${loop.metric.definition}`),
        "",
        "## Phase focus",
        "",
        ...output.focusRecommendation.phase1.map((item) => `- Phase 1: ${item}`),
        ...output.focusRecommendation.phase2.map((item) => `- Phase 2: ${item}`),
        "",
    ];
    return lines.join("\n");
}
export const flywheelDesignerStage = {
    name: "flywheel_designer",
    description: "Turn market gaps and repo context into concrete product flywheels and phased focus recommendations.",
    inputSchema: FlywheelInputSchema,
    outputSchema: FlywheelOutputSchema,
    async run(ctx, input) {
        const domain = inferDomain(input);
        const wedgeMoves = input.firstPrinciples?.wedge_moves ?? [];
        ctx.logger("[flywheel_designer] synthesizing", {
            project: input.config.project.project_name,
            domain,
            competitors: input.marketGap.competitors.length,
            gaps: input.marketGap.gapsToExploit.length,
            wedgeMoves: wedgeMoves.length,
        });
        const output = domain === "gardening" ? buildGardeningFlywheel(input) : buildGenericFlywheel(input);
        if (wedgeMoves.length > 0) {
            const wedgeFocus = wedgeMoves.slice(0, 3).map((w) => `${w.move} (${w.moat_vector} moat): ${w.why_it_wins}`);
            output.focusRecommendation.phase1 = [
                ...wedgeFocus,
                ...output.focusRecommendation.phase1.slice(0, 5 - wedgeFocus.length),
            ].slice(0, 5);
        }
        const validated = FlywheelOutputSchema.parse(output);
        await writeStageMarkdown(ctx, "flywheel_designer", "README.md", buildReadme(validated));
        return validated;
    },
};
