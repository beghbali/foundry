import { writeStageMarkdown } from "@foundry/core/artifacts";
import { StageInputCompositionSchema, type StageInputComposition } from "@foundry/core/stageInputs";
import type { RunContext, Stage } from "@foundry/core/types";
import { z } from "zod";

const RepoInventoryHintSchema = z.object({
  summary: z
    .object({
      repoTypeGuess: z.enum(["expo_rn", "node", "python", "unknown"]).optional(),
      hasSupabase: z.boolean().optional(),
      hasExpo: z.boolean().optional(),
    })
    .optional(),
});

export const MarketGapOutputSchema = z.object({
  competitors: z.array(
    z.object({
      name: z.string(),
      focus: z.string(),
    }),
  ),
  commonComplaints: z.array(
    z.object({
      theme: z.string(),
      whyItMatters: z.string(),
      userImpact: z.string(),
    }),
  ),
  gapsToExploit: z.array(
    z.object({
      gap: z.string(),
      whyNow: z.string(),
      howWeWin: z.string(),
    }),
  ),
  mustNotDo: z.array(z.string()),
});

export type MarketGapOutput = z.infer<typeof MarketGapOutputSchema>;

type CompetitorSeed = { name: string; focus: string };

type Domain =
  | "gardening"
  | "nutrition"
  | "generic";

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

  if (/\b(nutrition|ingredient|food|grocery|health score|wellness)\b/.test(haystack)) {
    return "nutrition";
  }

  return "generic";
}

function normalizeCompetitors(
  fromConfig: Array<string | { name: string; focus?: string }> | undefined,
  projectName: string,
  domain: Domain,
): CompetitorSeed[] {
  if (fromConfig && fromConfig.length > 0) {
    return fromConfig.map((c) => {
      if (typeof c === "string") {
        return { name: c, focus: "Adjacent solution in this category" };
      }
      return {
        name: c.name,
        focus: c.focus ?? "Adjacent solution in this category",
      };
    });
  }

  if (domain === "gardening") {
    return [
      {
        name: "Planta",
        focus: "Plant care reminders, diagnosis, and guided care plans for home gardeners",
      },
      {
        name: "Gardenize",
        focus: "Garden journaling, plant tracking, and photo-based organization for ongoing garden management",
      },
      {
        name: "From Seed to Spoon",
        focus: "Kitchen garden planning, companion planting, and crop-specific growing guidance",
      },
      {
        name: "PictureThis",
        focus: "Plant identification and problem diagnosis with broad consumer reach",
      },
    ];
  }

  const p = projectName.toLowerCase();
  if (p.includes("gutcheck") || domain === "nutrition") {
    return [
      { name: "Yuka", focus: "Ingredient transparency and product scoring for health-conscious shoppers" },
      { name: "Olive", focus: "Personalized health guidance and better-for-you product recommendations" },
    ];
  }

  return [
    {
      name: `${projectName} Incumbent`,
      focus: "General-purpose category leader with broad but less opinionated workflows",
    },
    {
      name: `${projectName} Lightweight`,
      focus: "Low-friction alternative optimized for quick setup over deep insight",
    },
  ];
}

function pickDifferentiatorHints(differentiators: string[] | undefined): string[] {
  if (!differentiators || differentiators.length === 0) {
    return ["opinionated workflows", "faster insight loops", "clear trust signals"];
  }
  return differentiators.slice(0, 3);
}

function buildOutput(input: StageInputComposition): MarketGapOutput {
  const project = input.config.project;
  const projectName = project.project_name;
  const domain = inferDomain(input);
  const diffs = pickDifferentiatorHints(project.core_differentiators);
  const competitors = normalizeCompetitors(project.market?.competitors, projectName, domain);

  const parsedRepoHints = RepoInventoryHintSchema.safeParse(input.repoInventory);
  const repoHints = parsedRepoHints.success ? parsedRepoHints.data : undefined;
  const hasSupabase = repoHints?.summary?.hasSupabase ?? false;
  const hasExpo = repoHints?.summary?.hasExpo ?? false;

  const commonComplaints =
    domain === "gardening"
      ? [
          {
            theme: "Advice is too generic for climate, season, and garden setup",
            whyItMatters:
              "Garden outcomes depend heavily on location, seasonality, sun exposure, and whether the user is growing in beds, containers, or indoors.",
            userImpact:
              "Users lose trust when recommendations do not match what they can actually plant or do this week.",
          },
          {
            theme: "Logging and garden planning takes too much effort",
            whyItMatters:
              "Gardeners need lightweight capture during busy moments like planting, watering, pruning, and harvest.",
            userImpact:
              "Users stop tracking after the first few sessions, which breaks habit loops and reduces retention.",
          },
          {
            theme: "Diagnosis stops at identification instead of next-best action",
            whyItMatters:
              "Gardeners need confidence about what to do next, not just what a pest, deficiency, or symptom might be.",
            userImpact:
              "Users still leave the app to search forums, YouTube, or Reddit before taking action.",
          },
          {
            theme: "No strong week-by-week guidance for what matters now",
            whyItMatters:
              "Gardening is seasonal and task-driven, so users need timely recommendations rather than static reference content.",
            userImpact:
              "Engagement fades between planting moments because the app does not create a recurring rhythm.",
          },
          {
            theme: "Garden tools feel fragmented across planning, care, and harvest",
            whyItMatters:
              "Users want one place to decide what to plant, track what exists, and respond to problems as they arise.",
            userImpact:
              "They juggle notes, reminders, photos, and external communities instead of building habit inside the app.",
          },
        ]
      : [
    {
      theme: "High cognitive load before first value",
      whyItMatters: "Most users decide in the first session whether a product is worth revisiting.",
      userImpact: "Drop-off before onboarding completion and weak week-1 retention.",
    },
    {
      theme: "Insights feel generic rather than contextual",
      whyItMatters: "Users trust recommendations when they match their specific goals and constraints.",
      userImpact: "Advice gets ignored, reducing habit formation and referral potential.",
    },
    {
      theme: "Poor explainability for recommendations",
      whyItMatters: "People adopt behavior changes when they understand the rationale behind a score or warning.",
      userImpact: "Lower confidence, fewer repeat sessions, and lower conversion to paid plans.",
    },
    {
      theme: "Slow loop from action to visible improvement",
      whyItMatters: "Short feedback loops are required for sustained weekly engagement.",
      userImpact: "Users churn before seeing measurable outcomes.",
    },
    {
      theme: "Fragmented workflow across multiple tools",
      whyItMatters: "Context switching creates friction and kills momentum.",
      userImpact: "Lower daily active usage and incomplete task execution.",
    },
  ];

  const gapsToExploit =
    domain === "gardening"
      ? [
          {
            gap: "What should I do in my garden this week?",
            whyNow:
              "Most gardening apps skew toward reference content or care reminders, but gardeners return for timely, seasonal decisions.",
            howWeWin:
              "Anchor the product around a weekly action feed personalized by garden type, season, and current plant stage.",
          },
          {
            gap: "Decision support tailored to the gardener's style and experience level",
            whyNow:
              "Beginners need confidence and simplification, while experienced gardeners want nuance without losing speed.",
            howWeWin:
              `Use gardener profile + context to adapt recommendations, tone, and defaults around ${diffs[0]}.`,
          },
          {
            gap: "From problem detection to concrete recovery plan",
            whyNow:
              "Plant diagnosis is increasingly commoditized; execution guidance is where trust and retention are earned.",
            howWeWin:
              "Turn every issue into a short recovery workflow with likely causes, immediate steps, follow-up checks, and expected timeline.",
          },
          {
            gap: "Simple garden system of record that does not feel like data entry",
            whyNow:
              "Gardeners will log if it directly improves recommendations, but abandon apps that feel like admin work.",
            howWeWin:
              "Capture state through quick actions, photos, and inferred events so the app gets smarter with minimal effort.",
          },
          {
            gap: hasSupabase
              ? "Fast learning loop from gardener outcomes back into recommendations"
              : "Fast learning loop from gardener outcomes back into the roadmap",
            whyNow:
              "Winning products compound from localized, repeated user outcomes rather than static care libraries.",
            howWeWin:
              "Track which recommendations led to success, failure, or follow-up questions, then tune weekly guidance around real outcomes.",
          },
        ]
      : [
    {
      gap: `Decision assistant built around ${diffs[0]}`,
      whyNow: hasExpo
        ? "Mobile users expect instant, contextual recommendations at the point of action."
        : "Users now prefer guided workflows over dashboards that require manual interpretation.",
      howWeWin: "Ship narrow, high-confidence recommendations with clear next action and expected outcome.",
    },
    {
      gap: "Trust-first scoring with transparent evidence",
      whyNow: "Skepticism toward black-box scoring is rising across consumer and prosumer products.",
      howWeWin: `Explain every recommendation with concrete evidence and map to ${diffs[1]}.`,
    },
    {
      gap: "Weekly progress loops tied to the north star",
      whyNow: "Retention depends on visible improvement in a short timeframe, not long-term promises.",
      howWeWin: "Convert the north star into weekly milestones and proactive nudges after each decision.",
    },
    {
      gap: "Opinionated defaults for first-session outcomes",
      whyNow: "Users abandon flexible systems that require too much initial setup.",
      howWeWin: `Preconfigure workflows around ${diffs[2]} and remove optionality until value is proven.`,
    },
    {
      gap: hasSupabase
        ? "Closed-loop quality pipeline from user feedback to fast iteration"
        : "Closed-loop quality pipeline from user feedback to roadmap updates",
      whyNow: "Products that iterate weekly on concrete user pain now outcompete feature-heavy incumbents.",
      howWeWin: "Instrument complaints by theme, rank by user impact, and ship fixes in short release cycles.",
    },
  ];

  const mustNotDo =
    domain === "gardening"
      ? [
          "Do not ship a generic plant encyclopedia without a strong this-week decision loop.",
          "Do not force gardeners to manually enter every plant, task, and condition before the app becomes useful.",
          "Do not give one-size-fits-all advice that ignores climate, season, and garden setup.",
          "Do not stop at identification when users actually need confidence about the next best action.",
        ]
      : [
    "Do not clone incumbent feature breadth before nailing the core decision loop.",
    "Do not hide recommendation logic behind opaque scores.",
    "Do not optimize for vanity metrics over weekly retention and repeated usage.",
    "Do not require heavy setup before users can test one real scenario.",
  ];

  return {
    competitors,
    commonComplaints,
    gapsToExploit,
    mustNotDo,
  };
}

function buildReadme(output: MarketGapOutput, projectName: string): string {
  const lines: string[] = [
    "# Market Gap Analysis (Mode A)",
    "",
    `Project: **${projectName}**`,
    "",
    "## Competitor set",
    "",
  ];

  for (const c of output.competitors) {
    lines.push(`- **${c.name}** - ${c.focus}`);
  }

  lines.push("", "## Top 5 gaps for builders", "");
  output.gapsToExploit.slice(0, 5).forEach((g, idx) => {
    lines.push(`${idx + 1}. **${g.gap}**`);
    lines.push(`   - Why now: ${g.whyNow}`);
    lines.push(`   - Build move: ${g.howWeWin}`);
  });

  lines.push("", "## Guardrails (must not do)", "");
  for (const m of output.mustNotDo) {
    lines.push(`- ${m}`);
  }

  return lines.join("\n") + "\n";
}

export const marketGapAnalysisStage: Stage<StageInputComposition, MarketGapOutput> = {
  name: "market_gap_analysis",
  description:
    "Mode A (default): deterministic market gap synthesis from project config, differentiators, and local repo signals.",
  inputSchema: StageInputCompositionSchema,
  outputSchema: MarketGapOutputSchema,
  async run(ctx: RunContext, input: StageInputComposition): Promise<MarketGapOutput> {
    const configuredCompetitors = input.config.project.market?.competitors?.length ?? 0;
    const domain = inferDomain(input);
    ctx.logger("[market_gap_analysis] mode_a", {
      project: input.config.project.project_name,
      domain,
      configuredCompetitors,
      fallbackUsed: configuredCompetitors === 0,
    });

    // Mode B (future): call connectors/web.ts when enabled by config.
    const output = buildOutput(input);
    const validated = MarketGapOutputSchema.parse(output);

    await writeStageMarkdown(
      ctx,
      "market_gap_analysis",
      "README.md",
      buildReadme(validated, input.config.project.project_name),
    );

    return validated;
  },
};
