import { writeStageMarkdown } from "@foundry/core/artifacts";
import { ProjectDomainSchema } from "@foundry/core/config";
import { getDomainKeyUserActions, getDomainPrimaryMetric, getDomainPrimaryUserAction, getDomainSuccessExamples, getDomainVocabulary, hasDomain, } from "@foundry/core/projectDomain";
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
            domain: ProjectDomainSchema.optional(),
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
function clip(s, max) {
    const t = s.trim().replace(/\s+/g, " ");
    if (t.length <= max)
        return t;
    return `${t.slice(0, max - 1)}…`;
}
function slugMetricPrefix(projectName) {
    const slug = projectName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "")
        .slice(0, 24);
    return slug || "product";
}
function primaryDifferentiator(input) {
    return input.config.project.core_differentiators?.[0]?.trim() || "a sharply scoped core workflow";
}
function userNoun(input) {
    const hay = `${input.config.project.north_star} ${input.config.project.project_name}`.toLowerCase();
    if (/\b(b2b|enterprise|team|org|company|business|operator|clinic|practice)\b/.test(hay))
        return "teams";
    if (/\b(consumer|shopper|family|parent|patient|traveler|driver)\b/.test(hay))
        return "people";
    return "users";
}
function productSurface(input) {
    if (input.repoInventory.summary.hasExpo)
        return "the mobile experience";
    if (input.repoInventory.summary.repoTypeGuess === "node")
        return "the product surface";
    return "the product";
}
function firstCompetitorName(input) {
    const c = input.marketGap.competitors[0]?.name?.trim();
    return c && c.length > 0 ? c : "generic alternatives";
}
function buildProjectContextualFlywheel(input) {
    const project = input.config.project;
    const brand = clip(project.project_name.trim() || "This product", 48);
    const north = clip(project.north_star, 160);
    // Domain block (optional) lets us anchor copy on the actual product instead
    // of generic "the primary job customers still struggle to complete" text.
    const domainPresent = hasDomain(project);
    const domainPrimary = getDomainPrimaryUserAction(project);
    const domainActions = getDomainKeyUserActions(project);
    const domainExamples = getDomainSuccessExamples(project);
    const domainVocab = getDomainVocabulary(project);
    const domainMetric = getDomainPrimaryMetric(project);
    const diff = clip(primaryDifferentiator(input), 140);
    const gap1 = clip(input.marketGap.gapsToExploit[0]?.gap ?? "the primary job customers still struggle to complete", 160);
    const gap2 = clip(input.marketGap.gapsToExploit[1]?.gap ??
        input.marketGap.gapsToExploit[0]?.howWeWin ??
        "proving you win on speed, clarity, or outcomes versus the status quo", 160);
    const gapHow = clip(input.marketGap.gapsToExploit[0]?.howWeWin ?? "evidence and iteration on the core loop", 140);
    const complaint1 = clip(input.marketGap.commonComplaints[0]?.theme ?? "fragmented tools and unclear next steps", 130);
    const complaint2 = clip(input.marketGap.commonComplaints[1]?.theme ??
        input.marketGap.commonComplaints[0]?.whyItMatters ??
        "trust erodes when promises outrun what the product can demonstrate", 130);
    const competitor = firstCompetitorName(input);
    const users = userNoun(input);
    const surface = productSurface(input);
    const mp = slugMetricPrefix(input.config.project.project_name);
    return {
        flywheel: [
            {
                loopName: `${brand} — outcome, retention, and advocacy`,
                steps: [
                    `${brand} helps ${users} finish a job that matters: ${gap1}.`,
                    `Visible progress is tied to the north star: ${north}.`,
                    `Each successful run builds habit and makes switching back to ${competitor} feel costly.`,
                    `Retained ${users} generate richer behavioral signals that improve guidance inside ${surface}.`,
                    `Advocacy happens when the win is easy to describe and share without diluting the story.`,
                ],
                trigger: `First session where ${users} complete the core path and see a tangible result`,
                valueCreated: `Compounds trust in ${brand} into lower churn, clearer word-of-mouth, and cheaper acquisition than ${competitor}.`,
                metric: {
                    key: `${mp}_core_outcome_to_repeat_rate`,
                    definition: `Share of new ${users} who complete the primary outcome within 7 days and return within 14 days.`,
                },
                risks: [
                    `The outcome is real but not legible — ${users} cannot tell why ${brand} beat ${competitor}.`,
                    `Retention looks fine while power ${users} quietly churn to spreadsheets or incumbents.`,
                    "Referral or invite mechanics ship before the core loop is reliably excellent.",
                ],
            },
            {
                loopName: `${brand} — guided next action on the north-star job`,
                steps: [
                    `${users} arrive with intent shaped by market pain: ${complaint1}.`,
                    `${surface} recommends the smallest next action that advances ${gap2}.`,
                    `Completing that action produces proof aligned with ${north}.`,
                    `The product records what worked and tightens the next recommendation.`,
                    `Trust rises because guidance feels specific to their situation, not generic tips.`,
                ],
                trigger: `Any moment ${complaint2.toLowerCase()} would otherwise send ${users} to five different tabs`,
                valueCreated: `Turns ${gap1} into a repeatable cadence instead of one-off heroics.`,
                metric: {
                    key: `${mp}_next_best_action_completion_rate`,
                    definition: `Percent of sessions where the top recommended action is completed and advances the north star.`,
                },
                risks: [
                    `Recommendations ignore the lived reality behind ${complaint1}.`,
                    "The next action is correct but too heavy for the session context.",
                    "Onboarding explains features instead of sequencing the winning path.",
                ],
            },
            {
                loopName: `${brand} — proof, clarity, and differentiation`,
                steps: [
                    `${brand} anchors the story on ${diff}.`,
                    `Evidence (metrics, demos, artifacts) shows how you win on ${gapHow}.`,
                    `Clarity beats breadth: fewer promises, each one tied to observable behavior in ${surface}.`,
                    `${users} compare you to ${competitor} using those proofs, not marketing claims.`,
                    `Each proof artifact makes the next sale or activation conversation shorter.`,
                ],
                trigger: `When ${users} evaluate ${brand} against ${competitor} during a high-intent task`,
                valueCreated: "Converts ambiguous interest into conviction by making differentiation falsifiable.",
                metric: {
                    key: `${mp}_proof_asset_to_activation_rate`,
                    definition: `Percent of activations where ${users} consumed a proof artifact (demo, benchmark, case) before committing.`,
                },
                risks: [
                    "Proof is anecdotal or stale versus what incumbents ship weekly.",
                    "Differentiation language drifts from what the repo actually ships.",
                    "Too many proof points — none of them memorable.",
                ],
            },
            {
                loopName: `${brand} — context compounding and personalization`,
                steps: [
                    `${users} contribute context because the immediate payoff is obvious on the next screen.`,
                    `${surface} adapts defaults, copy, and sequencing using that context.`,
                    `Personalization stays explainable — ${users} know why the product changed.`,
                    `Better fit increases completion on ${gap1} and reduces support load on ${complaint1}.`,
                    `Over time ${brand} becomes the system of record for that workflow.`,
                ],
                trigger: `Second successful session after ${users} save preferences, history, or goals`,
                valueCreated: `Makes switching away costly because accumulated context improves outcomes tied to ${north}.`,
                metric: {
                    key: `${mp}_contextual_recommendation_acceptance_rate`,
                    definition: `Percent of personalized suggestions accepted or completed by active ${users} each week.`,
                },
                risks: [
                    "Data capture feels like admin instead of a fair trade for speed.",
                    "Personalization is opaque and erodes trust when a recommendation misfires.",
                    input.repoInventory.summary.hasExpo
                        ? "Mobile capture latency or camera flows break the habit loop."
                        : "Cross-device gaps make context feel inconsistent.",
                ],
            },
        ],
        focusRecommendation: {
            phase1: domainPresent && (domainPrimary || domainActions.length > 0)
                ? [
                    ...(domainPrimary ? [`Ship the primary moment: ${domainPrimary}.`] : []),
                    ...domainActions.slice(0, 3).map((a) => `Cover key ${domainVocab.noun}: ${a}`),
                    ...(domainMetric ? [`Instrument and surface ${domainMetric} so it's visible in-app.`] : []),
                    ...(domainExamples.length > 0
                        ? [`Reproduce ${Math.min(domainExamples.length, 3)} success example(s) end-to-end before adding new features.`]
                        : []),
                ].slice(0, 5)
                : [
                    `Instrument the shortest path from first open to the first proof of ${clip(north, 90)}.`,
                    `Ship copy and UX that explicitly defeat ${complaint1} without expanding scope.`,
                    `Make one head-to-head story versus ${competitor} that ${users} can repeat in one sentence.`,
                    `Tie analytics events to the flywheel metrics above, not vanity counts.`,
                    `Gate expansion features until the primary loop hits the north star weekly for active ${users}.`,
                ],
            phase2: domainPresent
                ? [
                    `Cover the long tail of ${domainVocab.noun}s once the primary moment is reliable.`,
                    `Personalize ${domainVocab.outcome}s using accumulated context (history, preferences).`,
                    input.repoInventory.summary.hasSupabase
                        ? "Use Supabase-backed history for cross-device continuity once Phase 1 ships."
                        : "Add durable history storage once Phase 1 ships.",
                    "Open partner or ecosystem hooks only after the primary loop hits the configured metric weekly.",
                ]
                : [
                    `Layer adjacent workflows that deepen ${gap2} without reopening positioning confusion.`,
                    `Use cohort learning to tune recommendations from successful ${users}, not averages alone.`,
                    input.repoInventory.summary.hasSupabase
                        ? "Exploit durable Supabase-backed history for cross-session personalization and audit trails."
                        : "Add durable history storage so personalization survives reinstalls and new devices.",
                    "Introduce partner or ecosystem hooks only after retention on the core loop is proven.",
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
        "_Flywheels are synthesized from `project.yaml`, `market_gap_analysis`, `repo_inventory`, and optional `first_principles` wedge moves — not a fixed vertical template._",
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
    description: "Turn project config, market gaps, repo signals, and wedge moves into business-specific flywheels and phased focus.",
    inputSchema: FlywheelInputSchema,
    outputSchema: FlywheelOutputSchema,
    async run(ctx, input) {
        const wedgeMoves = input.firstPrinciples?.wedge_moves ?? [];
        ctx.logger("[flywheel_designer] synthesizing", {
            project: input.config.project.project_name,
            mode: "project_contextual",
            competitors: input.marketGap.competitors.length,
            gaps: input.marketGap.gapsToExploit.length,
            wedgeMoves: wedgeMoves.length,
        });
        const output = buildProjectContextualFlywheel(input);
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
