import { writeStageMarkdown } from "@foundry/core/artifacts";
import { StageInputCompositionSchema, type StageInputComposition } from "@foundry/core/stageInputs";
import type { RunContext, Stage } from "@foundry/core/types";
import { z } from "zod";

const RepoHintSchema = z.object({
  summary: z
    .object({
      repoTypeGuess: z.enum(["expo_rn", "node", "python", "unknown"]).optional(),
      hasSupabase: z.boolean().optional(),
      hasExpo: z.boolean().optional(),
    })
    .optional(),
});

const MarketGapHintSchema = z.object({
  competitors: z
    .array(z.object({ name: z.string(), focus: z.string() }))
    .optional(),
  commonComplaints: z
    .array(z.object({ theme: z.string(), whyItMatters: z.string(), userImpact: z.string() }))
    .optional(),
  gapsToExploit: z
    .array(z.object({ gap: z.string(), whyNow: z.string(), howWeWin: z.string() }))
    .optional(),
});

export const FirstPrinciplesOutputSchema = z.object({
  assumptions_to_break: z.array(
    z.object({
      assumption: z.string(),
      why_outdated_now: z.string(),
      new_capability: z.string(),
      implication_for_product: z.string(),
    }),
  ),
  wedge_moves: z.array(
    z.object({
      move: z.string(),
      why_it_wins: z.string(),
      moat_vector: z.enum(["data", "workflow", "distribution", "engineering"]),
      minimum_viable_proof: z.string(),
    }),
  ),
  moat_hypotheses: z.array(
    z.object({
      hypothesis: z.string(),
      mechanism: z.string(),
      leading_indicators: z.array(z.string()),
      time_to_prove: z.enum(["2w", "6w", "12w"]),
    }),
  ),
  kill_list: z.array(z.string()),
});

export type FirstPrinciplesOutput = z.infer<typeof FirstPrinciplesOutputSchema>;

type Domain = "gardening" | "generic";

function inferDomain(input: StageInputComposition): Domain {
  const project = input.config.project;
  const haystack = [
    project.project_name,
    project.north_star,
    ...(project.constraints ?? []),
    ...(project.core_differentiators ?? []),
  ]
    .join(" ")
    .toLowerCase();

  if (
    /\b(garden|gardening|gardener|plant care|plants|vegetable bed|harvest|seed|soil)\b/.test(
      haystack,
    )
  ) {
    return "gardening";
  }
  return "generic";
}

function buildGardening(
  input: StageInputComposition,
  hasExpo: boolean,
  hasSupabase: boolean,
  complaints: Array<{ theme: string }>,
  gaps: Array<{ gap: string; howWeWin: string }>,
): FirstPrinciplesOutput {
  const topComplaints = complaints.slice(0, 3).map((c) => c.theme);
  const topGaps = gaps.slice(0, 3);

  return {
    assumptions_to_break: [
      {
        assumption: "Gardeners need a plant encyclopedia to get started.",
        why_outdated_now:
          "Encyclopedic content is free on YouTube, Reddit, and Google. Users drown in reference; they lack actionable, contextual guidance.",
        new_capability:
          "On-device context (location, season, garden setup) can generate personalized weekly action plans without encyclopedic browsing.",
        implication_for_product:
          "Ship a weekly action feed first. Delay library content until the core decision loop is sticky.",
      },
      {
        assumption: "Plant identification is the hard problem to solve.",
        why_outdated_now:
          "ID models (PictureThis, Google Lens) are increasingly commoditized. Identification alone does not retain users.",
        new_capability:
          "The value gap is downstream: turning diagnosis into a recovery workflow with concrete next steps, not just a species label.",
        implication_for_product:
          "Pair every diagnosis with a recovery plan rather than competing on ID accuracy alone.",
      },
      {
        assumption: "Gardeners will manually log everything if the UI is good enough.",
        why_outdated_now:
          "Manual journaling apps (Gardenize) see drop-off after the novelty fades. Logging must create visible value immediately.",
        new_capability:
          "Infer state from quick actions, photos, and reminders so the garden profile improves without explicit data entry.",
        implication_for_product:
          "Minimize required input. Treat every tap as a signal that improves recommendations.",
      },
      {
        assumption: "A broad feature set wins the gardening market.",
        why_outdated_now:
          `Competitors (${complaints.length ? topComplaints.join(", ") : "see market gap analysis"}) spread thin across planning, care, social, and commerce. None own the weekly decision moment.`,
        new_capability:
          "A narrow, opinionated product that owns 'what should I do this week' can outperform broader tools on retention and habit.",
        implication_for_product:
          "Resist feature sprawl. Win the weekly check-in before expanding surface area.",
      },
    ],
    wedge_moves: [
      {
        move: "Weekly personalized garden action plan",
        why_it_wins:
          "No competitor delivers a curated, season-aware weekly to-do that adapts to the gardener's actual setup. This creates the repeat visit.",
        moat_vector: "workflow" as const,
        minimum_viable_proof:
          "50 gardeners use the weekly plan for 4 consecutive weeks with >60% task completion rate.",
      },
      {
        move: "Diagnosis-to-recovery workflow",
        why_it_wins:
          "Competitors stop at identification. A recovery plan with steps, timeline, and follow-up check turns a panic moment into long-term trust.",
        moat_vector: "workflow" as const,
        minimum_viable_proof:
          "30 gardeners complete a recovery workflow; >50% report the issue improved within the suggested timeframe.",
      },
      {
        move: hasSupabase
          ? "Outcome data loop via Supabase-backed garden profiles"
          : "Outcome data loop from lightweight garden profiles",
        why_it_wins:
          "Every logged outcome improves future recommendations for the user and the cohort. This compounds into a data moat competitors cannot replicate without the same engagement.",
        moat_vector: "data" as const,
        minimum_viable_proof:
          "Average garden profile has 5+ logged events after 4 weeks; recommendation acceptance rate trends upward.",
      },
      {
        move: hasExpo
          ? "Mobile-first contextual capture (photo, quick-log, location)"
          : "Low-friction contextual capture at the point of action",
        why_it_wins:
          "Gardening happens outdoors and in motion. Capturing state at the moment of action is harder to replicate than desktop dashboards.",
        moat_vector: "engineering" as const,
        minimum_viable_proof:
          "Median time to log an action is <10 seconds; >70% of logs happen within 1 hour of the task.",
      },
    ],
    moat_hypotheses: [
      {
        hypothesis:
          "Localized outcome data creates a compounding recommendation advantage that new entrants cannot bootstrap.",
        mechanism:
          "Each gardener's logged outcomes (what worked, what failed, in which season/zone) feed a model that improves recommendations for similar gardeners. More users = better guidance = more users.",
        leading_indicators: [
          "Week-over-week increase in logged outcomes per active gardener.",
          "Recommendation acceptance rate trending upward over 6 weeks.",
          "New-gardener activation rate improves as cohort data grows.",
        ],
        time_to_prove: "12w" as const,
      },
      {
        hypothesis:
          "Owning the weekly decision moment creates a workflow lock-in that encyclopedic competitors cannot displace.",
        mechanism:
          "When gardeners build a weekly habit around Verdant's action plan, switching costs rise because their garden state, history, and personalized plan live in the app.",
        leading_indicators: [
          "4-week retention rate for weekly-plan users vs. non-users.",
          "Percent of active users who open the app at least once per week.",
          "Self-reported reliance on the app for garden decisions (survey).",
        ],
        time_to_prove: "6w" as const,
      },
      {
        hypothesis:
          "Recovery workflows drive trust that converts free users to paid.",
        mechanism:
          "Anxiety moments (sick plant, pest outbreak) are high-intent. Delivering a concrete fix builds outsized trust and willingness to pay for premium guidance.",
        leading_indicators: [
          "Conversion rate from free to paid among users who completed a recovery workflow.",
          "NPS or satisfaction score after recovery vs. general usage.",
        ],
        time_to_prove: "6w" as const,
      },
    ],
    kill_list: [
      "Do not build a social feed or community feature until weekly retention exceeds 50%.",
      "Do not build a plant marketplace or shopping integration in Phase 1.",
      "Do not invest in AR/camera-based garden planning before the weekly action loop is proven.",
      "Do not add gamification badges that are not tied to real garden outcomes.",
      "Do not build desktop or web until mobile engagement is sticky.",
    ],
  };
}

function buildGeneric(
  input: StageInputComposition,
  hasExpo: boolean,
  hasSupabase: boolean,
  complaints: Array<{ theme: string }>,
  gaps: Array<{ gap: string; howWeWin: string }>,
): FirstPrinciplesOutput {
  const northStar = input.config.project.north_star;
  const topGap = gaps[0]?.gap ?? "core user job";
  const topComplaint = complaints[0]?.theme ?? "high cognitive load";

  return {
    assumptions_to_break: [
      {
        assumption: "Users need a full feature set before the product is useful.",
        why_outdated_now:
          "Modern successful products ship one tight loop first and expand from retention, not from breadth.",
        new_capability:
          "A narrow product that solves one job exceptionally builds stronger word-of-mouth than a broad but shallow one.",
        implication_for_product:
          `Focus entirely on ${topGap.toLowerCase()} before adding adjacent features.`,
      },
      {
        assumption: "Users will configure the product to fit their needs.",
        why_outdated_now:
          `The top complaint is "${topComplaint.toLowerCase()}". Users abandon products that require upfront setup.`,
        new_capability:
          "Opinionated defaults and progressive disclosure can deliver value before users invest effort.",
        implication_for_product:
          "Ship strong defaults. Let personalization emerge from usage, not from settings screens.",
      },
      {
        assumption: "Growth comes from marketing spend.",
        why_outdated_now:
          "Products with strong outcome loops generate organic referrals that outperform paid channels at scale.",
        new_capability:
          "If the core loop delivers a visible, shareable win, users become the acquisition channel.",
        implication_for_product:
          "Design for shareable outcomes before investing in paid acquisition.",
      },
    ],
    wedge_moves: [
      {
        move: `Single-session value for ${topGap.toLowerCase()}`,
        why_it_wins:
          "Users who see value in the first session are far more likely to return. Competing products require too much setup.",
        moat_vector: "workflow" as const,
        minimum_viable_proof:
          "50 new users complete the core job in session one; >40% return within 7 days.",
      },
      {
        move: hasSupabase
          ? "User-context data loop via Supabase-backed profiles"
          : "User-context data loop from lightweight profiles",
        why_it_wins:
          "Every interaction improves future recommendations. This compounds into a data advantage.",
        moat_vector: "data" as const,
        minimum_viable_proof:
          "Recommendation acceptance rate trends upward over 4 weeks of active usage.",
      },
      {
        move: hasExpo
          ? "Mobile-native contextual capture"
          : "Low-friction capture at the point of action",
        why_it_wins:
          "Capturing user context at the moment of need is an engineering moat that dashboard products cannot replicate.",
        moat_vector: "engineering" as const,
        minimum_viable_proof:
          "Median interaction time for the core action is under 15 seconds.",
      },
    ],
    moat_hypotheses: [
      {
        hypothesis: "Usage data creates a compounding recommendation advantage.",
        mechanism:
          "Each user action feeds a model that improves guidance for similar users. More users = better product = more users.",
        leading_indicators: [
          "Week-over-week increase in actions per active user.",
          "Recommendation acceptance rate trending upward.",
        ],
        time_to_prove: "12w" as const,
      },
      {
        hypothesis: "Owning the core decision moment creates workflow lock-in.",
        mechanism:
          "When users build a habit around the product's core loop, their history and context make switching costly.",
        leading_indicators: [
          "4-week retention rate.",
          "Percent of active users who return at least weekly.",
        ],
        time_to_prove: "6w" as const,
      },
    ],
    kill_list: [
      "Do not add social features before the core value loop has >40% weekly retention.",
      "Do not build integrations or plugins before the primary workflow is validated.",
      "Do not invest in growth marketing before organic referral signals appear.",
      "Do not expand surface area until the core loop is sticky.",
    ],
  };
}

function buildReadme(output: FirstPrinciplesOutput, projectName: string): string {
  const lines = [
    "# First Principles Analysis",
    "",
    `**Project:** ${projectName}`,
    "",
    "## Assumptions to break",
    "",
    ...output.assumptions_to_break.map(
      (a, i) =>
        `${i + 1}. **${a.assumption}**\n   - Why outdated: ${a.why_outdated_now}\n   - New capability: ${a.new_capability}\n   - Implication: ${a.implication_for_product}`,
    ),
    "",
    "## Top wedge moves (Phase 1)",
    "",
    ...output.wedge_moves.map(
      (w, i) =>
        `${i + 1}. **${w.move}** _(${w.moat_vector})_\n   - Why it wins: ${w.why_it_wins}\n   - MVP proof: ${w.minimum_viable_proof}`,
    ),
    "",
    "## Moat hypotheses + leading indicators",
    "",
    ...output.moat_hypotheses.map(
      (m) =>
        `- **${m.hypothesis}** _(prove in ${m.time_to_prove})_\n  - Mechanism: ${m.mechanism}\n  - Indicators: ${m.leading_indicators.join("; ")}`,
    ),
    "",
    "## Kill list",
    "",
    ...output.kill_list.map((k) => `- ${k}`),
    "",
  ];

  return lines.join("\n");
}

export const firstPrinciplesStage: Stage<StageInputComposition, FirstPrinciplesOutput> = {
  name: "first_principles",
  description:
    "Derive assumptions to break, wedge moves, moat hypotheses, and a kill list from market gaps and repo context.",
  inputSchema: StageInputCompositionSchema,
  outputSchema: FirstPrinciplesOutputSchema,
  async run(ctx: RunContext, input: StageInputComposition): Promise<FirstPrinciplesOutput> {
    const domain = inferDomain(input);

    const repoHints = RepoHintSchema.safeParse(input.repoInventory);
    const hasExpo = repoHints.success ? repoHints.data?.summary?.hasExpo ?? false : false;
    const hasSupabase = repoHints.success ? repoHints.data?.summary?.hasSupabase ?? false : false;

    const mgParsed = MarketGapHintSchema.safeParse(input.marketGap);
    const complaints = mgParsed.success ? mgParsed.data?.commonComplaints ?? [] : [];
    const gaps = mgParsed.success ? mgParsed.data?.gapsToExploit ?? [] : [];

    ctx.logger("[first_principles] analyzing", {
      project: input.config.project.project_name,
      domain,
      hasExpo,
      hasSupabase,
      complaints: complaints.length,
      gaps: gaps.length,
    });

    const output =
      domain === "gardening"
        ? buildGardening(input, hasExpo, hasSupabase, complaints, gaps)
        : buildGeneric(input, hasExpo, hasSupabase, complaints, gaps);

    const validated = FirstPrinciplesOutputSchema.parse(output);

    await writeStageMarkdown(
      ctx,
      "first_principles",
      "README.md",
      buildReadme(validated, input.config.project.project_name),
    );

    return validated;
  },
};
