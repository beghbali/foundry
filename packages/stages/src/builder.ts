import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { writeStageMarkdown } from "@foundry/core/artifacts";
import {
  annotateBriefLineWithId,
  briefIntentToken,
  mintBriefItemId,
  parseBriefIdComment,
  stripBriefIdComment,
  type BriefSection,
} from "@foundry/core/briefIntent";
import {
  GrandWizardOutputSchema,
  primaryBuildSpecSlice,
  type GrandWizardOutput,
} from "@foundry/core/buildSpec";
import {
  StageInputCompositionSchema,
  type InvestorRefinementContext,
  type StageInputComposition,
} from "@foundry/core/stageInputs";
import type { RunContext, Stage } from "@foundry/core/types";
import { z } from "zod";

import { runQualityChecks, tidyCode } from "./_shared/cleanup.js";
import {
  computeSatisfiedEdgeRateLimitPaths,
  computeSatisfiedPaywallGates,
  resolveAnalytics,
  resolveAuthGuards,
  resolveErrorBoundary,
  resolveInputValidation,
  resolveOfflineHandler,
  resolvePaywallGates,
  resolveRateLimiting,
  wireAnalyticsIntoScreens,
  wirePaywallIntoScreens,
  wireRateLimitIntoEdgeFunctions,
  type AnalyticsEventConfig,
  type FileAction,
  type GateConfig,
  type ScreenInfo,
} from "./_shared/codegen.js";
import * as git from "./_shared/git.js";

// ---------- schemas ----------

const AuditHint = z.object({
  detectedApp: z.object({
    mobileRoot: z.string().optional(),
    backendRoot: z.string().optional(),
    language: z.enum(["ts", "js", "mixed"]).optional(),
    packageManager: z.enum(["pnpm", "npm", "yarn"]).optional(),
  }).optional(),
  screens: z.array(z.object({
    name: z.string(),
    file: z.string(),
    purposeGuess: z.string(),
  })).optional(),
  apiSurface: z.object({
    edgeFunctions: z.array(z.object({ name: z.string(), path: z.string() })),
    endpoints: z.array(z.object({ function: z.string(), method: z.string(), route: z.string() })),
  }).optional(),
  gaps: z.array(z.object({
    area: z.enum(["ux", "api", "data", "reliability"]),
    description: z.string(),
    likelyFiles: z.array(z.string()).default([]),
  })).optional(),
});

const ProductDefHint = z.object({
  oneLiner: z.string().optional(),
  scope: z.object({
    mustShip: z.array(z.string()),
    shouldShip: z.array(z.string()).optional(),
    wontShip: z.array(z.string()).optional(),
  }),
  acceptanceCriteria: z.array(z.object({
    id: z.string(),
    description: z.string(),
    test: z.string(),
  })),
  coreWorkflows: z.array(z.object({
    name: z.string(),
    steps: z.array(z.string()),
    successMetric: z.string(),
  })).optional(),
});

const MonetizationHint = z.object({
  pricing: z.object({
    monthlyUsd: z.number(),
    yearlyUsd: z.number(),
    trialDays: z.number().optional(),
  }).optional(),
  gates: z.array(z.object({
    feature: z.string(),
    freeLimit: z.object({
      type: z.enum(["count", "rate"]),
      value: z.number(),
      period: z.enum(["month", "week", "day"]),
    }).optional(),
    requiresEntitlement: z.string().optional(),
    paywallMoment: z.string(),
  })).optional(),
  analyticsEvents: z.array(z.object({
    name: z.string(),
    when: z.string(),
    properties: z.array(z.string()),
  })).optional(),
});

const RepoHint = z.object({
  repoPath: z.string(),
  summary: z.object({
    repoTypeGuess: z.enum(["expo_rn", "node", "python", "unknown"]).optional(),
  }).optional(),
});

const FeedbackHint = z.object({
  items: z.array(z.object({
    type: z.enum(["bug", "feature", "feature_request", "complaint", "praise", "crash"]).optional(),
    summary: z.string(),
    priority: z.enum(["high", "medium", "low"]).optional(),
    status: z.enum(["open", "resolved", "ignored"]).optional(),
    shouldImplement: z.boolean().optional(),
    repoActionable: z.boolean().optional(),
  })).optional(),
  suggestions: z.array(z.string()).optional(),
});

const CommandEntry = z.object({ cmd: z.string(), ok: z.boolean(), exitCode: z.number().optional() });

export const BuilderOutputSchema = z.object({
  branchName: z.string(),
  baseBranch: z.string(),
  plan: z.object({
    goals: z.array(z.string()),
    filesToTouch: z.array(z.string()),
    gapsAddressed: z.array(z.string()),
    feedbackAddressed: z.array(z.string()),
    risksNoted: z.array(z.string()),
  }),
  commandsRun: z.array(CommandEntry),
  changes: z.object({
    filesCreated: z.array(z.string()),
    filesModified: z.array(z.string()),
    filesSkipped: z.array(z.string()),
  }),
  commit: z.object({ sha: z.string(), message: z.string() }).optional(),
  status: z.enum(["ok", "partial", "blocked", "failed"]),
  notes: z.array(z.string()),
});

export type BuilderOutput = z.infer<typeof BuilderOutputSchema>;

// ---------- file helpers ----------

async function fileExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function ensureFile(absPath: string, content: string): Promise<boolean> {
  if (await fileExists(absPath)) return false;
  await mkdir(join(absPath, ".."), { recursive: true });
  await writeFile(absPath, content, "utf8");
  return true;
}

// ---------- guardrails content ----------

const GUARDRAILS_CONTENT = `# Engineering Guardrails

1. **No broad rewrites.** Every change should be a small, testable diff.
2. **Lint before commit.** All committed code must pass \`lint\` and \`typecheck\`.
3. **Test the happy path.** Every new workflow needs at least one happy-path test.
4. **Respect the pipeline.** Do not bypass stage outputs; consume artifacts.
5. **Keep secrets out of code.** Use environment variables for all keys and tokens.
6. **Mobile-first performance.** Screens must render in under 2 seconds on mid-range hardware.
7. **Offline-aware.** Network calls must degrade gracefully when offline.
8. **Accessibility.** All interactive elements need accessible labels.
`;

const GOLDEN_PATH_CONTENT = `# Golden Path

This document describes the recommended path for making changes to this codebase.

## Before you start
1. Pull latest from the main branch.
2. Create a feature branch: \`git checkout -b feat/<short-name>\`.
3. Read the relevant stage artifacts in \`.foundry/out/\` for context.

## Making changes
1. Scope the change to the fewest files possible.
2. Run \`lint\` and \`typecheck\` before committing.
3. Write or update tests for new logic.
4. Commit with a descriptive message.

## Submitting
1. Push the branch and open a pull request.
2. Include a link to the relevant Foundry run if applicable.
3. Request review from a team member.
`;

// ---------- gap classification ----------

type ResolverName =
  | "error_boundary" | "offline_handler" | "rate_limiting"
  | "paywall" | "analytics"
  | "auth_guard" | "input_validation"
  | "paywall_wiring" | "analytics_wiring" | "rate_limit_wiring"
  | "docs" | "scripts" | "none";

interface GapAction {
  gap: string;
  area: string;
  resolver: ResolverName;
  likelyFiles: string[];
}

function classifyGaps(
  gaps: Array<{ area: string; description: string; likelyFiles: string[] }>,
): GapAction[] {
  return gaps.map((g) => {
    const desc = g.description.toLowerCase();

    if (/error\s*boundary/i.test(desc) || (g.area === "reliability" && /crash|unhandled/i.test(desc))) {
      return { gap: g.description, area: g.area, resolver: "error_boundary" as const, likelyFiles: g.likelyFiles };
    }
    if (/offline|network\s*status|netinfo/i.test(desc)) {
      return { gap: g.description, area: g.area, resolver: "offline_handler" as const, likelyFiles: g.likelyFiles };
    }
    if (/rate\s*limit/i.test(desc)) {
      return { gap: g.description, area: g.area, resolver: "rate_limit_wiring" as const, likelyFiles: g.likelyFiles };
    }
    if (/auth\s*guard|bypass\s*login|without\s*auth|deep\s*link.*bypass/i.test(desc)) {
      return { gap: g.description, area: g.area, resolver: "auth_guard" as const, likelyFiles: g.likelyFiles };
    }
    if (/validation|submit\s*bad\s*data|client.side\s*validation/i.test(desc)) {
      return { gap: g.description, area: g.area, resolver: "input_validation" as const, likelyFiles: g.likelyFiles };
    }
    return { gap: g.description, area: g.area, resolver: "none" as const, likelyFiles: g.likelyFiles };
  });
}

// ---------- feedback analysis ----------

interface FeedbackAction {
  summary: string;
  relatedResolver: string | null;
  priority: "high" | "medium" | "low";
  likelyFiles: string[];
}

type AdaptiveDirectiveSource =
  | "gap_unresolved"
  | "feedback_unresolved"
  | "brief_open_item"
  | "project_directive";

interface AdaptiveDirective {
  key: string;
  summary: string;
  domain: string;
  source: AdaptiveDirectiveSource;
  likelyFiles: string[];
  seenCount: number;
  firstSeenRunId: string;
  lastSeenRunId: string;
  resolved: boolean;
}

interface AdaptiveResolverMemory {
  updatedAt: string;
  lastRunId: string;
  directives: AdaptiveDirective[];
}

const ADAPTIVE_RESOLVER_MEMORY_REL = ".foundry/resolver-domains.json";
/**
 * Cursor now owns feature implementation loops. Keep deterministic builder side-effects minimal:
 * refresh planning artifacts only, do not mutate product code via resolvers/codegen.
 */
const ENABLE_DETERMINISTIC_RESOLVERS = false;

function guessFeedbackFiles(
  summary: string,
  screens: Array<{ name: string; file: string; purposeGuess: string }> | undefined,
  mobileRoot: string,
): string[] {
  const lower = summary.toLowerCase();
  const out = new Set<string>();
  const root = mobileRoot === "." ? "" : `${mobileRoot}/`;
  const allScreens = screens ?? [];
  const addMatchingScreens = (pattern: RegExp) => {
    for (const screen of allScreens) {
      const hay = `${screen.name} ${screen.file} ${screen.purposeGuess}`.toLowerCase();
      if (pattern.test(hay)) out.add(screen.file);
    }
  };

  if (/\b(upsell|trial|premium|pro|paywall|price|pricing|subscribe)\b/.test(lower)) {
    addMatchingScreens(/\b(pro|premium|paywall|pricing|subscribe)\b/);
    out.add(`${root}app/pro.tsx`);
  }
  if (/\b(shake|feedback|report bug|bug report)\b/.test(lower)) {
    out.add(`${root}src/hooks/useShakeToReport.ts`);
    out.add(`${root}src/hooks/useShakeToReport.js`);
    out.add(`${root}src/components/feedback/FeedbackModal.tsx`);
    out.add(`${root}src/components/feedback/FeedbackModal.jsx`);
  }
  if (/\b(task|this week|weekly|done|undone|expand|tap to see why|why and how|formatted|list)\b/.test(lower)) {
    addMatchingScreens(/\b(index|home|weekly|observe|task|feed)\b/);
    out.add(`${root}app/(tabs)/index.tsx`);
    out.add(`${root}app/(tabs)/observe.tsx`);
  }
  if (/\b(auth|login|sign in|guest onboarding|onboarding)\b/.test(lower)) {
    addMatchingScreens(/\b(auth|login|signin|onboarding)\b/);
    out.add(`${root}app/auth.tsx`);
  }
  if (/\b(eas|expo|app config|config plugin|valid config plugin|unexpected token)\b/.test(lower)) {
    out.add("app.json");
    out.add("app.config.js");
    out.add("app.config.ts");
    out.add("eas.json");
    out.add("package.json");
    out.add(`${root}app.json`);
    out.add(`${root}app.config.js`);
    out.add(`${root}app.config.ts`);
    out.add(`${root}package.json`);
  }

  return [...out];
}

function analyzeFeedback(
  feedback: z.infer<typeof FeedbackHint> | undefined,
  screens: Array<{ name: string; file: string; purposeGuess: string }> | undefined,
  mobileRoot: string,
): FeedbackAction[] {
  if (!feedback) return [];

  const actions: FeedbackAction[] = [];
  const items = (feedback.items ?? []).filter(
    (item) => (item.status ?? "open") === "open" && (item.shouldImplement ?? item.repoActionable ?? true),
  );
  const suggestions = feedback.suggestions ?? [];

  for (const item of items) {
    const lower = item.summary.toLowerCase();
    let relatedResolver: string | null = null;

    if (/app init|startup|boot|splash|launch|crash|error|broke|errorboundary/i.test(lower)) relatedResolver = "error_boundary";
    if (/offline|network|connect/i.test(lower)) relatedResolver = "offline_handler";
    if (/slow|timeout|rate/i.test(lower)) relatedResolver = "rate_limiting";
    if (/pay|price|upgrade|premium/i.test(lower)) relatedResolver = "paywall";
    if (/auth|login|sign in|session/i.test(lower) && relatedResolver === null) relatedResolver = "auth_guard";
    const likelyFiles = guessFeedbackFiles(item.summary, screens, mobileRoot);

    actions.push({ summary: item.summary, relatedResolver, priority: item.priority ?? "medium", likelyFiles });
  }

  for (const suggestion of suggestions) {
    actions.push({
      summary: suggestion,
      relatedResolver: null,
      priority: "medium",
      likelyFiles: guessFeedbackFiles(suggestion, screens, mobileRoot),
    });
  }

  return actions;
}

function normalizeDirectiveKey(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 160);
}

function inferDirectiveDomain(summary: string): string {
  const lower = summary.toLowerCase();
  if (/\b(llm|prompt|model|agent|ai)\b/.test(lower)) return "llm";
  if (/\b(auth|login|session|token|oauth)\b/.test(lower)) return "auth";
  if (/\b(payment|paywall|pricing|subscription|entitlement|purchase)\b/.test(lower)) return "monetization";
  if (/\b(scan|camera|barcode|ocr|image)\b/.test(lower)) return "scanning";
  if (/\b(search|ranking|recommend)\b/.test(lower)) return "search";
  if (/\b(notif|reminder|push)\b/.test(lower)) return "notifications";
  if (/\b(profile|account|settings)\b/.test(lower)) return "profile";
  if (/\b(sync|offline|network|cache)\b/.test(lower)) return "sync";
  if (/\b(analytics|event|funnel|telemetry)\b/.test(lower)) return "analytics";
  if (/\b(edge function|supabase|backend|api)\b/.test(lower)) return "backend";
  return "product";
}

function resolverFromText(summary: string): ResolverName | null {
  const lower = summary.toLowerCase();
  if (/error\s*boundary|crash|unhandled/.test(lower)) return "error_boundary";
  if (/offline|network\s*status|netinfo/.test(lower)) return "offline_handler";
  if (/rate\s*limit|throttle/.test(lower)) return "rate_limit_wiring";
  if (/auth\s*guard|bypass\s*login|without\s*auth|deep\s*link.*bypass|session/.test(lower)) return "auth_guard";
  if (/validation|submit\s*bad\s*data|invalid input/.test(lower)) return "input_validation";
  if (/pay|price|upgrade|premium|subscription|entitlement/.test(lower)) return "paywall";
  if (/analytics|event|funnel|track/.test(lower)) return "analytics";
  return null;
}

function isCoreFocusDirective(text: string): boolean {
  const lower = text.toLowerCase();
  return /\b(collapse|single wedge|core loop|focus|defer|simpl|simple|delight|retention|activation|one promise|one user)\b/.test(lower);
}

function shouldApplyCoreFocus(investorRefinement: InvestorRefinementContext | undefined): boolean {
  if (!investorRefinement) return false;
  return investorRefinement.directives.some((d) => isCoreFocusDirective(d));
}

function isSecondaryResolver(resolver: ResolverName): boolean {
  return resolver === "paywall" || resolver === "analytics" || resolver === "paywall_wiring" || resolver === "analytics_wiring";
}

/** Deterministic codegen resolvers that are not user-facing product work — defer while core brief is open. */
function isEdgeInfrastructureResolver(resolver: ResolverName): boolean {
  return resolver === "rate_limiting" || resolver === "rate_limit_wiring";
}

function isMonetizationInfrastructureResolver(resolver: ResolverName): boolean {
  return (
    resolver === "paywall" ||
    resolver === "analytics" ||
    resolver === "paywall_wiring" ||
    resolver === "analytics_wiring"
  );
}

function directiveAllowsSecondaryWork(summary: string): boolean {
  const lower = summary.toLowerCase();
  return /\b(paywall|pricing|subscription|entitlement|conversion|trial|analytics|event|funnel|retention metric)\b/.test(lower);
}

type OpenBriefItem = {
  section: "must" | "should" | "gaps" | "monetization" | "edge" | "runtime";
  text: string;
};

async function readOpenTrackedBriefItems(briefPath: string): Promise<OpenBriefItem[]> {
  let raw = "";
  try {
    raw = await readFile(briefPath, "utf8");
  } catch {
    return [];
  }

  const out: OpenBriefItem[] = [];
  let section: "must" | "should" | "gaps" | "monetization" | "edge" | "runtime" | "other" = "other";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "### Must Ship (Phase 1)") section = "must";
    else if (trimmed === "### Should Ship (stretch)") section = "should";
    else if (trimmed === "## Unresolved Gaps (Cursor should fix these)") section = "gaps";
    else if (trimmed === "## Monetization Integration") section = "monetization";
    else if (trimmed === "## Edge Function Rate Limiting") section = "edge";
    else if (trimmed === "## Runtime Failures To Fix First") section = "runtime";
    else if (trimmed.startsWith("## ") || trimmed.startsWith("### ")) section = "other";

    if (!trimmed.startsWith("- [ ]")) continue;
    if (section === "other") continue;
    out.push({
      section,
      text: stripBriefIdComment(trimmed.replace(/^- \[ \]\s*/, "").trim()),
    });
  }
  return out;
}

async function loadAdaptiveResolverMemory(repoPath: string): Promise<AdaptiveResolverMemory> {
  const abs = join(repoPath, ADAPTIVE_RESOLVER_MEMORY_REL);
  try {
    const raw = await readFile(abs, "utf8");
    const parsed = JSON.parse(raw) as AdaptiveResolverMemory;
    if (!parsed || !Array.isArray(parsed.directives)) throw new Error("invalid");
    return parsed;
  } catch {
    return {
      updatedAt: new Date(0).toISOString(),
      lastRunId: "",
      directives: [],
    };
  }
}

async function saveAdaptiveResolverMemory(repoPath: string, memory: AdaptiveResolverMemory): Promise<void> {
  const abs = join(repoPath, ADAPTIVE_RESOLVER_MEMORY_REL);
  await mkdir(join(repoPath, ".foundry"), { recursive: true });
  await writeFile(abs, JSON.stringify(memory, null, 2) + "\n", "utf8");
}

function buildAdaptiveResolverMemoryMd(memory: AdaptiveResolverMemory): string {
  const lines: string[] = [
    "# Adaptive Resolver Domains",
    "",
    `Updated: ${memory.updatedAt}`,
    `Last run: ${memory.lastRunId}`,
    "",
    "| Domain | Source | Seen | Summary |",
    "| --- | --- | ---: | --- |",
  ];
  for (const d of memory.directives.filter((item) => !item.resolved).slice(0, 50)) {
    lines.push(`| ${d.domain} | ${d.source} | ${d.seenCount} | ${d.summary.replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

interface AdaptiveDirectiveInput {
  summary: string;
  source: AdaptiveDirectiveSource;
  likelyFiles: string[];
}

function mergeLikelyFiles(current: string[], incoming: string[]): string[] {
  return [...new Set([...current, ...incoming].filter(Boolean))].slice(0, 24);
}

async function upsertAdaptiveDirectives(
  repoPath: string,
  runId: string,
  inputs: AdaptiveDirectiveInput[],
): Promise<AdaptiveResolverMemory> {
  const memory = await loadAdaptiveResolverMemory(repoPath);
  const byKey = new Map(memory.directives.map((d) => [d.key, d] as const));
  const seenThisRun = new Set<string>();

  for (const item of inputs) {
    const summary = item.summary.trim();
    if (!summary) continue;
    const key = normalizeDirectiveKey(summary);
    if (!key) continue;
    seenThisRun.add(key);
    const existing = byKey.get(key);
    if (existing) {
      existing.summary = summary;
      existing.likelyFiles = mergeLikelyFiles(existing.likelyFiles, item.likelyFiles);
      existing.lastSeenRunId = runId;
      existing.seenCount += 1;
      existing.resolved = false;
      existing.source = item.source;
      existing.domain = inferDirectiveDomain(summary);
      continue;
    }
    byKey.set(key, {
      key,
      summary,
      domain: inferDirectiveDomain(summary),
      source: item.source,
      likelyFiles: [...new Set(item.likelyFiles.filter(Boolean))].slice(0, 24),
      seenCount: 1,
      firstSeenRunId: runId,
      lastSeenRunId: runId,
      resolved: false,
    });
  }

  for (const directive of byKey.values()) {
    if (!seenThisRun.has(directive.key) && directive.lastSeenRunId !== runId) {
      // Auto-resolve directives that no longer appear in current unresolved signals.
      if (directive.source !== "project_directive") {
        directive.resolved = true;
      }
    }
  }

  memory.updatedAt = new Date().toISOString();
  memory.lastRunId = runId;
  memory.directives = [...byKey.values()].sort((a, b) => b.seenCount - a.seenCount);
  await saveAdaptiveResolverMemory(repoPath, memory);
  return memory;
}

// ---------- plan builder ----------

interface BuildPlan {
  goals: string[];
  filesToTouch: string[];
  gapsAddressed: string[];
  feedbackAddressed: string[];
  risksNoted: string[];
  resolversToRun: Set<string>;
}

function buildPlan(
  gapActions: GapAction[],
  feedbackActions: FeedbackAction[],
  adaptiveDirectives: AdaptiveDirective[],
  hasMonetization: boolean,
  monetizationNeedsResolverPass: boolean,
  hasEdgeFunctions: boolean,
  edgeNeedsResolverPass: boolean,
  isNode: boolean,
  opts?: {
    coreFocusMode?: boolean;
    investorDirectives?: string[];
    /** When false, skip edge rate-limit codegen while core product brief items are open (unless Edge section has items). */
    allowEdgeInfrastructureResolvers?: boolean;
    /** When false, skip paywall/analytics codegen while core product brief items are open (unless Monetization section has items). */
    allowMonetizationInfrastructureResolvers?: boolean;
  },
): BuildPlan {
  const goals: string[] = [];
  const filesToTouch: string[] = [];
  const gapsAddressed: string[] = [];
  const feedbackAddressed: string[] = [];
  const risksNoted: string[] = [];
  const resolversToRun = new Set<string>();
  const goalSeen = new Set<string>();
  const riskSeen = new Set<string>();
  const pushGoal = (goal: string) => {
    if (goalSeen.has(goal)) return;
    goalSeen.add(goal);
    goals.push(goal);
  };
  const pushRisk = (risk: string) => {
    if (riskSeen.has(risk)) return;
    riskSeen.add(risk);
    risksNoted.push(risk);
  };
  const coreFocusMode = opts?.coreFocusMode === true;
  const investorDirectives = opts?.investorDirectives ?? [];
  const allowEdgeInfra = opts?.allowEdgeInfrastructureResolvers !== false;
  const allowMonetInfra = opts?.allowMonetizationInfrastructureResolvers !== false;

  for (const ga of gapActions) {
    if (ga.resolver !== "none") {
      if (!allowEdgeInfra && isEdgeInfrastructureResolver(ga.resolver)) {
        pushRisk(`Deferred edge resolver (core product brief open): [${ga.area}] ${ga.gap.slice(0, 100)}`);
        continue;
      }
      resolversToRun.add(ga.resolver);
      gapsAddressed.push(`[${ga.area}] ${ga.gap}`);
      pushGoal(`Fix gap: ${ga.gap.slice(0, 100)}`);
    } else {
      pushRisk(`Unresolvable gap: ${ga.gap.slice(0, 100)}`);
    }
  }

  for (const fa of feedbackActions) {
    feedbackAddressed.push(fa.summary);
    pushGoal(`Implement selected feedback: ${fa.summary.slice(0, 100)}`);
    filesToTouch.push(...fa.likelyFiles);
    if (fa.relatedResolver) {
      if (!allowEdgeInfra && isEdgeInfrastructureResolver(fa.relatedResolver as ResolverName)) {
        pushRisk(`Deferred edge resolver (core product brief open): ${fa.summary.slice(0, 100)}`);
      } else if (!allowMonetInfra && isMonetizationInfrastructureResolver(fa.relatedResolver as ResolverName)) {
        pushRisk(`Deferred monetization resolver (core product brief open): ${fa.summary.slice(0, 100)}`);
      } else {
        resolversToRun.add(fa.relatedResolver);
      }
    }
    if (fa.priority === "high") {
      pushGoal(`Fix high-priority feedback: ${fa.summary.slice(0, 100)}`);
    }
  }

  for (const directive of adaptiveDirectives) {
    const inferred = resolverFromText(directive.summary);
    if (inferred && !allowEdgeInfra && isEdgeInfrastructureResolver(inferred)) {
      pushRisk(`Deferred adaptive edge work (core product brief open): ${directive.summary.slice(0, 120)}`);
      continue;
    }
    if (inferred && !allowMonetInfra && isMonetizationInfrastructureResolver(inferred)) {
      pushRisk(`Deferred adaptive monetization work (core product brief open): ${directive.summary.slice(0, 120)}`);
      continue;
    }
    pushGoal(`Adaptive domain (${directive.domain}): ${directive.summary.slice(0, 100)}`);
    filesToTouch.push(...directive.likelyFiles);
    if (inferred) {
      const allowSecondary =
        !coreFocusMode ||
        !isSecondaryResolver(inferred) ||
        directive.source === "project_directive" ||
        directiveAllowsSecondaryWork(directive.summary);
      if (allowSecondary) {
        resolversToRun.add(inferred);
      } else {
        pushRisk(`Core-focus mode deferred secondary resolver work: ${directive.summary.slice(0, 120)}`);
      }
    } else {
      pushRisk(`Adaptive directive pending Cursor implementation: ${directive.summary.slice(0, 120)}`);
    }
  }

  const investorWantsMonetizationPass =
    investorDirectives.some((d) => directiveAllowsSecondaryWork(d));
  if (
    hasMonetization &&
    monetizationNeedsResolverPass &&
    (!coreFocusMode || investorWantsMonetizationPass) &&
    allowMonetInfra
  ) {
    resolversToRun.add("paywall");
    resolversToRun.add("analytics");
    resolversToRun.add("paywall_wiring");
    resolversToRun.add("analytics_wiring");
    pushGoal("Create paywall gate definitions from monetization_architect");
    pushGoal("Wire paywall gates into actual app screens");
    pushGoal("Create analytics event tracking from monetization_architect");
    pushGoal("Wire analytics events into relevant screens");
  }

  if (hasEdgeFunctions && edgeNeedsResolverPass && allowEdgeInfra) {
    resolversToRun.add("rate_limiting");
    resolversToRun.add("rate_limit_wiring");
    pushGoal("Create rate limiting utility and wire into edge functions");
  }

  pushGoal("Ensure engineering guardrails and golden-path docs exist");
  filesToTouch.push("docs/engineering/guardrails.md", "docs/golden-path.md");

  if (isNode) {
    pushGoal("Ensure quality scripts (lint, typecheck) are present");
    filesToTouch.push("package.json");
  }

  pushGoal("Run quality checks and tidy code");
  if (coreFocusMode) {
    pushGoal("Core-focus mode: prioritize investor core-loop directives over secondary expansion.");
  }

  return { goals, filesToTouch, gapsAddressed, feedbackAddressed, risksNoted, resolversToRun };
}

// ---------- safe infrastructure ----------

async function applySafeInfrastructure(
  repoPath: string,
  isNode: boolean,
  logger: (msg: string) => void,
): Promise<{ actions: FileAction[]; commandsRun: Array<{ cmd: string; ok: boolean; exitCode?: number }> }> {
  const actions: FileAction[] = [];
  const commandsRun: Array<{ cmd: string; ok: boolean; exitCode?: number }> = [];

  if (await ensureFile(join(repoPath, "docs", "engineering", "guardrails.md"), GUARDRAILS_CONTENT)) {
    actions.push({ file: "docs/engineering/guardrails.md", action: "created", description: "Engineering guardrails" });
    logger("[builder] created docs/engineering/guardrails.md");
  }
  if (await ensureFile(join(repoPath, "docs", "golden-path.md"), GOLDEN_PATH_CONTENT)) {
    actions.push({ file: "docs/golden-path.md", action: "created", description: "Developer golden path" });
    logger("[builder] created docs/golden-path.md");
  }

  if (isNode) {
    const pkgPath = join(repoPath, "package.json");
    if (await fileExists(pkgPath)) {
      try {
        const raw = await readFile(pkgPath, "utf8");
        const pkg = JSON.parse(raw) as Record<string, unknown>;
        const scripts = (pkg.scripts ?? {}) as Record<string, string>;
        let changed = false;

        if (!scripts.lint && !scripts["lint:fix"]) {
          scripts.lint = "echo 'no linter configured'";
          changed = true;
        }
        if (!scripts.typecheck) {
          scripts.typecheck = "tsc --noEmit 2>/dev/null || echo 'typecheck not configured'";
          changed = true;
        }

        if (changed) {
          pkg.scripts = scripts;
          await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
          actions.push({ file: "package.json", action: "modified", description: "Added missing lint/typecheck scripts" });
          logger("[builder] added missing scripts to package.json");
        }
      } catch {
        commandsRun.push({ cmd: "add scripts to package.json", ok: false, exitCode: 1 });
      }
    }
  }

  const qualityResults = await runQualityChecks(repoPath);
  for (const r of qualityResults) {
    commandsRun.push(r);
    logger(`[builder] ${r.cmd}: ${r.ok ? "passed" : "failed"} (exit ${r.exitCode})`);
  }

  const tidyResults = await tidyCode(repoPath);
  for (const r of tidyResults) {
    commandsRun.push(r);
    logger(`[builder] ${r.cmd}: ${r.ok ? "ok" : "failed"} (exit ${r.exitCode})`);
  }

  return { actions, commandsRun };
}

// ---------- implementation plan ----------

function generateImplementationPlan(
  plan: BuildPlan,
  allActions: FileAction[],
  projectName: string,
  baseBranch: string,
  baseSha: string,
): string {
  const lines = [
    `# Implementation Plan — ${projectName}`,
    "",
    `**Base:** ${baseBranch} (\`${baseSha}\`)`,
    `**Generated by:** Foundry builder`,
    "",
    "## Goals",
    "",
    ...plan.goals.map((g, i) => `${i + 1}. ${g}`),
    "",
  ];

  if (plan.gapsAddressed.length > 0) {
    lines.push("## Gaps Addressed", "");
    for (const g of plan.gapsAddressed) {
      lines.push(`- ${g}`);
    }
    lines.push("");
  }

  if (plan.feedbackAddressed.length > 0) {
    lines.push("## Feedback Addressed", "");
    for (const f of plan.feedbackAddressed) {
      lines.push(`- ${f}`);
    }
    lines.push("");
  }

  lines.push("## Files Changed", "");
  const created = allActions.filter((a) => a.action === "created");
  const modified = allActions.filter((a) => a.action === "modified");
  const skipped = allActions.filter((a) => a.action === "skipped");

  if (created.length > 0) {
    lines.push("### Created", "");
    for (const a of created) lines.push(`- \`${a.file}\` — ${a.description}`);
    lines.push("");
  }
  if (modified.length > 0) {
    lines.push("### Modified", "");
    for (const a of modified) lines.push(`- \`${a.file}\` — ${a.description}`);
    lines.push("");
  }
  if (skipped.length > 0) {
    lines.push("### Skipped (already present)", "");
    for (const a of skipped) lines.push(`- \`${a.file}\` — ${a.description}`);
    lines.push("");
  }

  if (plan.risksNoted.length > 0) {
    lines.push("## Risks / Unresolved", "");
    for (const r of plan.risksNoted) lines.push(`- ${r}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------- build summary ----------

function generateSummary(
  output: BuilderOutput,
  projectName: string,
  baseBranch: string,
  baseSha: string,
): string {
  const lines = [
    `# Build Summary — ${projectName}`,
    "",
    `**Branch:** \`${output.branchName}\` (from ${baseBranch} @ \`${baseSha}\`)`,
    `**Status:** ${output.status}`,
    "",
  ];

  if (output.plan.gapsAddressed.length > 0) {
    lines.push("## Gaps Fixed", "");
    for (const g of output.plan.gapsAddressed) lines.push(`- ${g}`);
    lines.push("");
  }

  if (output.plan.feedbackAddressed.length > 0) {
    lines.push("## Feedback Applied", "");
    for (const f of output.plan.feedbackAddressed) lines.push(`- ${f}`);
    lines.push("");
  }

  const { filesCreated, filesModified } = output.changes;
  if (filesCreated.length + filesModified.length > 0) {
    lines.push("## Changes", "");
    if (filesCreated.length > 0) {
      lines.push("**Created:**", ...filesCreated.map((f) => `- \`${f}\``), "");
    }
    if (filesModified.length > 0) {
      lines.push("**Modified:**", ...filesModified.map((f) => `- \`${f}\``), "");
    }
  }

  if (output.commandsRun.length > 0) {
    lines.push("## Quality Checks", "");
    for (const c of output.commandsRun) {
      lines.push(`- ${c.ok ? "PASS" : "FAIL"} \`${c.cmd}\` (exit ${c.exitCode ?? "?"})`);
    }
    lines.push("");
  }

  if (output.commit) {
    lines.push(`## Commit`, "", `\`${output.commit.sha}\`: ${output.commit.message}`, "");
  }

  lines.push("## Next Steps", "");
  lines.push("1. Review the changes: `git diff HEAD~1`");
  lines.push("2. Install any new dependencies (e.g. `npx expo install @react-native-community/netinfo`)");
  lines.push("3. Run the app and verify new components work");
  lines.push("4. Run the pipeline again after making feedback observations");
  lines.push("");

  if (output.notes.length > 0) {
    lines.push("## Notes", "", ...output.notes.map((n) => `- ${n}`), "");
  }

  return lines.join("\n");
}

// ---------- cursor brief ----------

/** Auto `[x]` hints: gates/paths already wired in repo so the brief does not re-open the inner loop. */
type CursorBriefAutos = {
  paywallGatesDone: Set<string>;
  edgeRatePathsDone: Set<string>;
};

type BriefChecklistSection = BriefSection;

/**
 * Stable identity for prior `[x]` lines: an ID minted from `(section, intent token)`.
 * Lines stamped with `<!-- id:bf-... -->` are matched directly; older briefs
 * without IDs are auto-upgraded by recomputing the same intent-derived ID.
 */
type BriefChecklistState = {
  checkedIds: Set<string>;
};

async function readBriefChecklistState(briefPath: string): Promise<BriefChecklistState> {
  let raw = "";
  try {
    raw = await readFile(briefPath, "utf8");
  } catch {
    return { checkedIds: new Set<string>() };
  }

  const checkedIds = new Set<string>();
  let section: BriefChecklistSection | "other" = "other";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "## Investor panel refinement (priority)") section = "investor";
    else if (trimmed === "### Must Ship (Phase 1)") section = "must";
    else if (trimmed === "### Should Ship (stretch)") section = "should";
    else if (trimmed === "## Unresolved Gaps (Cursor should fix these)") section = "gaps";
    else if (trimmed === "## Runtime Failures To Fix First") section = "runtime";
    else if (trimmed === "## Monetization Integration") section = "monetization";
    else if (trimmed === "## Edge Function Rate Limiting") section = "edge";
    else if (trimmed.startsWith("## ") || trimmed.startsWith("### ")) section = "other";

    if (section === "other") continue;
    if (!trimmed.startsWith("- [x]")) continue;
    const body = trimmed.replace(/^- \[x\]\s*/, "").trim();
    const explicit = parseBriefIdComment(body);
    if (explicit) {
      checkedIds.add(explicit);
      continue;
    }
    // Back-compat: brief written before ID stamping. Reconstruct the same ID
    // we would mint today from the human-readable text so old `[x]` lines stay checked.
    const cleanText = stripBriefIdComment(body);
    if (briefIntentToken(cleanText) === "" && cleanText === "") continue;
    checkedIds.add(mintBriefItemId(section, cleanText));
  }
  return { checkedIds };
}

function generateCursorBriefFromBuildSpec(
  projectName: string,
  buildSpec: GrandWizardOutput,
  audit: z.infer<typeof AuditHint> | undefined,
  feedback: z.infer<typeof FeedbackHint> | undefined,
  investorRefinement?: InvestorRefinementContext,
  previousChecklist?: BriefChecklistState,
): string {
  const checkbox = (section: BriefChecklistSection, text: string, defaultChecked = false): string => {
    const cleanText = stripBriefIdComment(text);
    const id = mintBriefItemId(section, cleanText);
    const checked = defaultChecked || (previousChecklist?.checkedIds.has(id) ?? false);
    return annotateBriefLineWithId(`- [${checked ? "x" : " "}] ${cleanText}`, id);
  };

  const primary = primaryBuildSpecSlice(buildSpec);
  const lines: string[] = [
    `# Cursor Implementation Brief — ${projectName}`,
    "",
    "This brief is driven by **`.foundry/BUILD_SPEC.json`** (Grand Wizard).",
    "Implement **only the concrete tasks** below — do not widen scope to deferred items or restate vague directives.",
    "",
    `**Cycle theme:** ${buildSpec.cycleTheme}`,
    "",
    "---",
    "",
  ];

  if (buildSpec.diagnostics.directivesWithoutTasks.length > 0) {
    lines.push(
      "> **Wizard diagnostic:** the following directives could NOT be decomposed to concrete tasks this cycle and are deferred:",
      "",
      ...buildSpec.diagnostics.directivesWithoutTasks.map((d) => `> - ${d}`),
      "",
    );
  }

  if (investorRefinement) {
    lines.push(
      "## Investor panel refinement (priority)",
      "",
      `Round ${investorRefinement.round} — address these in the primary slice:`,
      "",
      ...investorRefinement.directives.map((d) => checkbox("investor", d)),
      "",
    );
  }

  lines.push(
    `## Primary slice — ${primary.title}`,
    "",
    `**User story:** ${primary.userStory}`,
    "",
  );

  if (primary.tasks.length > 0) {
    lines.push("### Concrete tasks (decomposed)", "");
    for (const task of primary.tasks) {
      const filesNote = task.files.length > 0 ? ` — files: ${task.files.map((f) => `\`${f}\``).join(", ")}` : "";
      lines.push(checkbox("must", `${task.task}${filesNote}`));
      lines.push(`  - verify: ${task.verification}`);
      if (task.decomposedFrom.length > 0) {
        lines.push(`  - addresses: ${task.decomposedFrom.join(", ")}`);
      }
    }
    lines.push("");
  } else {
    lines.push("### Must ship (this cycle)", "", ...primary.acceptance.map((a) => checkbox("must", a)), "");
  }

  if (buildSpec.parentDirectives.length > 0) {
    lines.push(
      "### Parent directives (each closes when all its child tasks are checked)",
      "",
      ...buildSpec.parentDirectives.map(
        (p) => `- **${p.id}** (${p.source}) — ${p.text}\n  - children: ${p.childTaskIds.join(", ") || "_none yet_"}`,
      ),
      "",
    );
  }

  if (buildSpec.definitionOfDone.length > 0) {
    lines.push("### Definition of done", "");
    for (const item of buildSpec.definitionOfDone) {
      lines.push(checkbox("must", item));
    }
    lines.push("");
  }

  if (primary.files.length > 0) {
    lines.push("### Target files", "", ...primary.files.map((f) => `- \`${f}\``), "");
  }

  if (audit?.screens && audit.screens.length > 0) {
    lines.push("## Existing screens (modify, don't duplicate)", "");
    lines.push("| Screen | File | Purpose |");
    lines.push("| --- | --- | --- |");
    for (const s of audit.screens) {
      lines.push(`| ${s.name} | \`${s.file}\` | ${s.purposeGuess} |`);
    }
    lines.push("");
  }

  const urgentFeedback = (feedback?.items ?? [])
    .filter(
      (item) =>
        (item.status ?? "open") === "open" &&
        (item.shouldImplement ?? item.repoActionable ?? true) &&
        (item.priority ?? "medium") === "high" &&
        /crash|bug|error/i.test(`${item.type ?? ""} ${item.summary}`),
    )
    .slice(0, 6);
  if (urgentFeedback.length > 0) {
    lines.push("## Runtime failures (fix before slice if blocking)", "");
    for (const item of urgentFeedback) {
      lines.push(checkbox("runtime", item.summary));
    }
    lines.push("");
  }

  if (primary.outOfScope.length > 0 || buildSpec.deferred.length > 0) {
    lines.push("## Deferred (do not implement this pass)", "");
    for (const item of [...primary.outOfScope, ...buildSpec.deferred].slice(0, 16)) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  lines.push(
    "---",
    "",
    "## How to use",
    "",
    "1. Read `.foundry/BUILD_SPEC.md` for full context",
    "2. Implement the primary slice acceptance criteria in product code",
    "3. Mark items `- [x]` only when implemented and tested",
    "",
  );

  return lines.join("\n");
}

function generateCursorBrief(
  projectName: string,
  audit: z.infer<typeof AuditHint> | undefined,
  productDef: z.infer<typeof ProductDefHint> | undefined,
  monetization: z.infer<typeof MonetizationHint> | undefined,
  plan: BuildPlan,
  allActions: FileAction[],
  feedback: z.infer<typeof FeedbackHint> | undefined,
  autos?: CursorBriefAutos,
  investorRefinement?: InvestorRefinementContext,
  previousChecklist?: BriefChecklistState,
): string {
  const checkbox = (section: BriefChecklistSection, text: string, defaultChecked = false): string => {
    const cleanText = stripBriefIdComment(text);
    const id = mintBriefItemId(section, cleanText);
    // Cross-cycle preservation: same intent → same id, even if upstream rephrased the line.
    const checked = defaultChecked || (previousChecklist?.checkedIds.has(id) ?? false);
    return annotateBriefLineWithId(`- [${checked ? "x" : " "}] ${cleanText}`, id);
  };
  const lines: string[] = [
    `# Cursor Implementation Brief — ${projectName}`,
    "",
    "This file is generated by the Foundry pipeline. Open this file in Cursor",
    "and ask: **\"Implement the next feature from this brief.\"**",
    "",
    "Cursor will read the context below and know exactly what to build, which",
    "files to modify, and what the acceptance criteria are.",
    "",
    "---",
    "",
  ];

  if (investorRefinement) {
    lines.push(
      "## Investor panel refinement (priority)",
      "",
      `Round ${investorRefinement.round} — do these before other checklist items:`,
      "",
      ...investorRefinement.directives.map((d) => checkbox("investor", d)),
      "",
      "```text",
      investorRefinement.investorSummaries.trim() || "(no summaries)",
      "```",
      "",
    );
  }

  // What was already built by the automated builder
  const created = allActions.filter((a) => a.action === "created");
  if (created.length > 0) {
    lines.push("## Already Built (by Foundry builder)", "");
    for (const a of created) lines.push(`- [x] \`${a.file}\` — ${a.description}`);
    lines.push("");
  }

  // Remaining features from product definition
  if (productDef) {
    lines.push("## Features to Implement", "");
    lines.push("### Must Ship (Phase 1)", "");
    for (const item of productDef.scope.mustShip) {
      lines.push(checkbox("must", item));
    }
    lines.push("");

    if (productDef.scope.shouldShip && productDef.scope.shouldShip.length > 0) {
      lines.push("### Should Ship (stretch)", "");
      for (const item of productDef.scope.shouldShip) {
        lines.push(checkbox("should", item));
      }
      lines.push("");
    }

    lines.push("### Core Workflows", "");
    if (productDef.coreWorkflows) {
      for (const wf of productDef.coreWorkflows) {
        lines.push(`#### ${wf.name}`, "");
        wf.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
        lines.push("", `**Success metric:** ${wf.successMetric}`, "");
      }
    }

    lines.push("### Acceptance Criteria", "");
    for (const ac of productDef.acceptanceCriteria) {
      lines.push(`- **${ac.id}:** ${ac.description}`);
      lines.push(`  - _Test:_ ${ac.test}`);
    }
    lines.push("");
  }

  // Screens and files from audit
  if (audit?.screens && audit.screens.length > 0) {
    lines.push("## Existing Screens (modify these, don't create new ones)", "");
    lines.push("| Screen | File | Purpose |");
    lines.push("| --- | --- | --- |");
    for (const s of audit.screens) {
      lines.push(`| ${s.name} | \`${s.file}\` | ${s.purposeGuess} |`);
    }
    lines.push("");
  }

  // Unresolved gaps for Cursor to fix
  if (plan.risksNoted.length > 0) {
    lines.push("## Unresolved Gaps (Cursor should fix these)", "");
    for (const r of plan.risksNoted) {
      if (r.startsWith("Unresolvable gap:")) {
        lines.push(checkbox("gaps", r.replace("Unresolvable gap: ", "")));
      }
    }
    lines.push("");
  }

  const urgentFeedback = (feedback?.items ?? [])
    .filter(
      (item) =>
        (item.status ?? "open") === "open" &&
        (item.shouldImplement ?? item.repoActionable ?? true) &&
        (item.priority ?? "medium") === "high" &&
        /crash|bug|error/i.test(`${item.type ?? ""} ${item.summary}`),
    )
    .slice(0, 10);
  if (urgentFeedback.length > 0) {
    lines.push("## Runtime Failures To Fix First", "");
    for (const item of urgentFeedback) {
      lines.push(checkbox("runtime", item.summary));
    }
    lines.push("");
  }

  // Monetization: full checklist only while something is still unwired; once verified, stop
  // re-printing the same paywall work every pipeline run (reduces diff churn and Cursor thrash).
  if (monetization?.gates && monetization.gates.length > 0) {
    const allPaywallVerified =
      !!autos && monetization.gates.every((g) => autos.paywallGatesDone.has(g.feature));
    lines.push("## Monetization Integration", "");
    if (allPaywallVerified) {
      lines.push(
        "_All monetization gates are verified wired in repo (pattern scan on target screens). No open paywall checklist — change gates in `monetization_architect` / product config if you add new ones._",
        "",
      );
    } else {
      lines.push("The builder created `src/lib/paywall.ts` with gate definitions and");
      lines.push("`src/lib/analytics.ts` with event tracking. Wire them into the app:", "");
      for (const gate of monetization.gates) {
        const done = autos?.paywallGatesDone.has(gate.feature) ?? false;
        lines.push(checkbox("monetization", `**${gate.feature.replace(/_/g, " ")}**: ${gate.paywallMoment}`, done));
      }
      lines.push("");
      lines.push("Import `shouldShowPaywall` from `@/lib/paywall` and `track` from `@/lib/analytics`");
      lines.push("to enforce gates and fire events at the moments described above.");
      lines.push("");
    }
  }

  // Edge function rate limiting wiring (skip `_shared`: not a deployed handler; satisfaction
  // is only computed for real functions — listing `_shared/index.ts` caused perpetual open items.)
  const edgeFnsForRateLimit = (audit?.apiSurface?.edgeFunctions ?? []).filter((fn) => fn.name !== "_shared");
  if (edgeFnsForRateLimit.length > 0) {
    const allEdgeRlVerified =
      !!autos &&
      edgeFnsForRateLimit.every((fn) => autos.edgeRatePathsDone.has(`${fn.path}/index.ts`));
    lines.push("## Edge Function Rate Limiting", "");
    if (allEdgeRlVerified) {
      lines.push(
        "_Rate limiting verified on all deployed edge handlers. No open wiring checklist._",
        "",
      );
    } else {
      lines.push("The builder created `supabase/functions/_shared/rate-limit.ts`.");
      lines.push("Import `rateLimit` and `rateLimitResponse` in each edge function:", "");
      for (const fn of edgeFnsForRateLimit) {
        const rel = `${fn.path}/index.ts`;
        const done = autos?.edgeRatePathsDone.has(rel) ?? false;
        lines.push(checkbox("edge", `\`${rel}\` — add rate limit check at the top of the handler`, done));
      }
      lines.push("");
      lines.push("```typescript");
      lines.push("import { rateLimit, rateLimitResponse } from '../_shared/rate-limit.ts';");
      lines.push("");
      lines.push("// At the top of your serve() handler:");
      lines.push("const clientIp = req.headers.get('x-forwarded-for') ?? 'unknown';");
      lines.push("const rl = rateLimit(clientIp, 30, 60_000); // 30 req/min");
      lines.push("if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);");
      lines.push("```");
      lines.push("");
    }
  }

  // How to use this file
  lines.push("---", "");
  lines.push("## How to use this brief in Cursor", "");
  lines.push("1. Open this file in the Verdant project in Cursor");
  lines.push("2. Say: **\"Implement [feature name] from this brief\"**");
  lines.push("3. Or: **\"Fix the next unresolved gap from CURSOR_BRIEF.md\"**");
  lines.push("4. Or: **\"Wire the paywall gates into the existing screens\"**");
  lines.push("5. After each change, run the Foundry pipeline again to re-evaluate gaps");
  lines.push("");

  return lines.join("\n");
}

function summarizeResolverActions(actions: FileAction[]): { created: number; modified: number; skipped: number } {
  return {
    created: actions.filter((a) => a.action === "created").length,
    modified: actions.filter((a) => a.action === "modified").length,
    skipped: actions.filter((a) => a.action === "skipped").length,
  };
}

// ---------- stage ----------

export const builderStage: Stage<StageInputComposition, BuilderOutput> = {
  name: "builder",
  description: "Consume pipeline outputs, generate code to fix gaps, integrate monetization, and apply improvements.",
  inputSchema: StageInputCompositionSchema,
  outputSchema: BuilderOutputSchema,
  async run(ctx: RunContext, input: StageInputComposition): Promise<BuilderOutput> {
    const projectName = input.config.project.project_name;
    const repoPath = ctx.repoPath;
    const notes: string[] = [];
    const allCommandsRun: Array<{ cmd: string; ok: boolean; exitCode?: number }> = [];
    const allFileActions: FileAction[] = [];

    ctx.logger("[builder] starting", { project: projectName, repoPath });

    // ---- 1. Git check ----
    const gitStatus = await git.status(repoPath);
    ctx.logger("[builder] git", { clean: gitStatus.clean, branch: gitStatus.branch, head: gitStatus.headSha });

    if (gitStatus.hasOnlyGeneratedChanges) {
      notes.push("Ignoring dirty Foundry-generated artifacts in `.foundry/` (ledger/cache/release metadata only).");
    }

    if (!gitStatus.clean) {
      notes.push(
        "Foundry detected existing non-generated working-tree changes and will adopt them into the Foundry branch commit instead of blocking.",
      );
    }

    // ---- 2. Parse all upstream stage outputs ----
    const repoParsed = RepoHint.safeParse(input.repoInventory);
    const auditParsed = AuditHint.safeParse(input.currentStateAudit);
    const pdParsed = ProductDefHint.safeParse(input.productDefinition);
    const monParsed = MonetizationHint.safeParse(input.monetizationConfig);
    const feedbackParsed = FeedbackHint.safeParse(input.feedback);
    const gwParsed = GrandWizardOutputSchema.safeParse(input.grandWizard);

    const audit = auditParsed.success ? auditParsed.data : undefined;
    const monetization = monParsed.success ? monParsed.data : undefined;
    const feedback = feedbackParsed.success ? feedbackParsed.data : undefined;

    const mobileRoot = audit?.detectedApp?.mobileRoot ?? ".";
    const backendRoot = audit?.detectedApp?.backendRoot;
    const edgeFunctions = audit?.apiSurface?.edgeFunctions ?? [];
    const gaps = audit?.gaps ?? [];

    const isNode =
      (repoParsed.success && (repoParsed.data.summary?.repoTypeGuess === "node" || repoParsed.data.summary?.repoTypeGuess === "expo_rn")) ||
      (await fileExists(join(repoPath, "package.json")));

    ctx.logger("[builder] context", {
      mobileRoot,
      backendRoot,
      gaps: gaps.length,
      edgeFunctions: edgeFunctions.length,
      hasMonetization: !!monetization?.gates?.length,
      hasFeedback: !!feedback?.items?.length,
      isNode,
    });

    // ---- 3. Classify gaps & analyze feedback ----
    const gapActions = classifyGaps(gaps);
    const feedbackActions = analyzeFeedback(feedback, audit?.screens, mobileRoot);
    const briefPath = join(repoPath, ".foundry", "CURSOR_BRIEF.md");
    const openBriefItems = await readOpenTrackedBriefItems(briefPath);
    const previousChecklist = await readBriefChecklistState(briefPath);
    const configuredDirectives = input.config.project.builder?.directives ?? [];

    const adaptiveMemory = await upsertAdaptiveDirectives(
      repoPath,
      ctx.runId,
      [
        ...gapActions
          .filter((g) => g.resolver === "none")
          .map((g) => ({ summary: g.gap, source: "gap_unresolved" as const, likelyFiles: g.likelyFiles })),
        ...feedbackActions
          .filter((f) => !f.relatedResolver)
          .map((f) => ({ summary: f.summary, source: "feedback_unresolved" as const, likelyFiles: f.likelyFiles })),
        ...openBriefItems
          .filter((item) => item.section !== "monetization" && item.section !== "edge")
          .map((item) => ({
          summary: item.text,
          source: "brief_open_item" as const,
          likelyFiles: guessFeedbackFiles(item.text, audit?.screens, mobileRoot),
        })),
        ...configuredDirectives.map((d) => ({
          summary: [d.description, d.notes].filter(Boolean).join(" — "),
          source: "project_directive" as const,
          likelyFiles: d.files,
        })),
      ],
    );
    const activeAdaptiveDirectives = adaptiveMemory.directives.filter((d) => !d.resolved);
    const adaptiveDirectives = activeAdaptiveDirectives.slice(0, 20);
    await writeStageMarkdown(ctx, "builder", "ADAPTIVE_RESOLVER_DOMAINS.md", buildAdaptiveResolverMemoryMd(adaptiveMemory));
    notes.push(
      `Adaptive resolver memory updated: ${activeAdaptiveDirectives.length} active (${adaptiveDirectives.length} loaded this run) tracked in ${ADAPTIVE_RESOLVER_MEMORY_REL}.`,
    );

    const screens = (audit?.screens ?? []) as ScreenInfo[];
    const paywallLibPath = join(repoPath, mobileRoot === "." ? "src/lib/paywall.ts" : `${mobileRoot}/src/lib/paywall.ts`);
    const analyticsLibPath = join(repoPath, mobileRoot === "." ? "src/lib/analytics.ts" : `${mobileRoot}/src/lib/analytics.ts`);
    const paywallLibReady = await fileExists(paywallLibPath);
    const analyticsLibReady = await fileExists(analyticsLibPath);
    const paywallGatesDone =
      monetization?.gates && screens.length > 0
        ? await computeSatisfiedPaywallGates(repoPath, screens, monetization.gates as GateConfig[])
        : new Set<string>();
    const edgeFunctionsDeployable = edgeFunctions.filter((f) => f.name !== "_shared");
    const edgeRatePathsDone = await computeSatisfiedEdgeRateLimitPaths(repoPath, edgeFunctions);
    const monetizationNeedsResolverPass = Boolean(
      monetization?.gates?.length &&
      (!paywallLibReady ||
        !analyticsLibReady ||
        (screens.length > 0 && paywallGatesDone.size < (monetization.gates as GateConfig[]).length)),
    );
    const edgeNeedsResolverPass = Boolean(
      edgeFunctionsDeployable.length > 0 && edgeRatePathsDone.size < edgeFunctionsDeployable.length,
    );

    const coreProductBriefOpen = openBriefItems.filter(
      (i) => i.section === "must" || i.section === "should" || i.section === "gaps" || i.section === "runtime",
    ).length;
    const monetizationBriefOpen = openBriefItems.filter((i) => i.section === "monetization").length;
    const edgeBriefOpen = openBriefItems.filter((i) => i.section === "edge").length;
    /** Run infra/codegen resolvers only when those sections are explicitly open in CURSOR_BRIEF. */
    const allowEdgeInfrastructureResolvers = edgeBriefOpen > 0;
    const allowMonetizationInfrastructureResolvers = monetizationBriefOpen > 0;

    const coreFocusMode = shouldApplyCoreFocus(input.investorRefinement);
    let plan = buildPlan(
      gapActions,
      feedbackActions,
      adaptiveDirectives,
      !!(monetization?.gates?.length),
      monetizationNeedsResolverPass,
      edgeFunctions.length > 0,
      edgeNeedsResolverPass,
      isNode,
      {
        coreFocusMode,
        investorDirectives: input.investorRefinement?.directives ?? [],
        allowEdgeInfrastructureResolvers,
        allowMonetizationInfrastructureResolvers,
      },
    );

    if (!ENABLE_DETERMINISTIC_RESOLVERS) {
      if (plan.resolversToRun.size > 0) {
        notes.push(
          `Deterministic resolvers disabled for Cursor-first loop: deferred ${plan.resolversToRun.size} resolver(s) to Cursor implementation.`,
        );
      }
      plan = { ...plan, resolversToRun: new Set() };
    }

    if (input.investorRefinement) {
      const ir = input.investorRefinement;
      plan = {
        ...plan,
        goals: [
          ...ir.directives.map((d) => `[Investor r${ir.round}] ${d}`),
          ...plan.goals,
        ],
      };
    }

    ctx.logger("[builder] plan", {
      resolvers: [...plan.resolversToRun],
      gapsAddressed: plan.gapsAddressed.length,
      feedbackAddressed: plan.feedbackAddressed.length,
      adaptiveDirectivesLoaded: adaptiveDirectives.length,
      adaptiveDirectivesActiveTotal: activeAdaptiveDirectives.length,
      monetizationNeedsResolverPass,
      edgeNeedsResolverPass,
      coreFocusMode,
      coreProductBriefOpen,
      edgeBriefOpen,
      monetizationBriefOpen,
      allowEdgeInfrastructureResolvers,
      allowMonetizationInfrastructureResolvers,
    });

    if (!allowEdgeInfrastructureResolvers) {
      notes.push(
        "Builder deferred edge rate-limit codegen: no open items exist under ## Edge Function Rate Limiting in CURSOR_BRIEF.",
      );
    }
    if (!allowMonetizationInfrastructureResolvers) {
      notes.push(
        "Builder deferred paywall/analytics codegen: no open items exist under ## Monetization Integration in CURSOR_BRIEF.",
      );
    }

    // ---- 4. Create or reuse branch for changes ----
    const stableBranch = input.config.project.foundry?.builder_branch?.trim();
    const branchName =
      stableBranch && stableBranch.length > 0 ? stableBranch : `foundry/${ctx.runId}`;
    const branchReady = await git.ensureBranch(repoPath, branchName);
    if (!branchReady.ok) {
      throw new Error(`Could not create or checkout builder branch '${branchName}'.`);
    }
    const branchCreated = branchReady.created;
    const stableReleaseBranch = Boolean(stableBranch && stableBranch.length > 0);
    if (branchCreated) {
      notes.push(
        stableReleaseBranch
          ? `Created stable release branch ${branchName} from ${gitStatus.branch} (${gitStatus.headSha}).`
          : `Created branch ${branchName} from ${gitStatus.branch} (${gitStatus.headSha}).`,
      );
    } else {
      notes.push(
        stableReleaseBranch
          ? `Reusing stable release branch ${branchName} (work continues here until release merge to main).`
          : `Using existing builder branch ${branchName}.`,
      );
    }

    // ---- 5. Run resolvers ----
    const recordResolver = (name: string, actions: FileAction[], meta?: Record<string, unknown>) => {
      allFileActions.push(...actions);
      const summary = summarizeResolverActions(actions);
      ctx.logger(`[builder] resolved: ${name}`, {
        ...(meta ?? {}),
        created: summary.created,
        modified: summary.modified,
        skipped: summary.skipped,
      });
    };

    if (plan.resolversToRun.has("error_boundary")) {
      const actions = await resolveErrorBoundary(repoPath, mobileRoot);
      recordResolver("error_boundary", actions);
    }

    if (plan.resolversToRun.has("offline_handler")) {
      const actions = await resolveOfflineHandler(repoPath, mobileRoot);
      recordResolver("offline_handler", actions);
    }

    if (plan.resolversToRun.has("rate_limiting")) {
      const actions = await resolveRateLimiting(repoPath, edgeFunctions, backendRoot);
      recordResolver("rate_limiting", actions);
    }

    if (plan.resolversToRun.has("paywall") && monetization?.gates) {
      const gates = monetization.gates as GateConfig[];
      const actions = await resolvePaywallGates(repoPath, mobileRoot, gates, projectName);
      recordResolver("paywall", actions, { gates: gates.length });
    }

    if (plan.resolversToRun.has("analytics") && monetization?.analyticsEvents) {
      const events = monetization.analyticsEvents as AnalyticsEventConfig[];
      const actions = await resolveAnalytics(repoPath, mobileRoot, events, projectName);
      recordResolver("analytics", actions, { events: events.length });
    }

    // ---- 5b. Screen-level wiring resolvers ----

    if (plan.resolversToRun.has("auth_guard")) {
      const authGapFiles = gapActions
        .filter((g) => g.resolver === "auth_guard")
        .flatMap((g) => g.likelyFiles);
      if (authGapFiles.length > 0) {
        const actions = await resolveAuthGuards(repoPath, authGapFiles);
        recordResolver("auth_guard", actions, { files: authGapFiles.length });
      }
    }

    if (plan.resolversToRun.has("input_validation")) {
      const validationFiles = gapActions
        .filter((g) => g.resolver === "input_validation")
        .flatMap((g) => g.likelyFiles);
      if (validationFiles.length > 0) {
        const actions = await resolveInputValidation(repoPath, validationFiles);
        recordResolver("input_validation", actions, { files: validationFiles.length });
      }
    }

    if (plan.resolversToRun.has("paywall_wiring") && monetization?.gates && screens.length > 0) {
      const gates = monetization.gates as GateConfig[];
      const actions = await wirePaywallIntoScreens(repoPath, screens, gates);
      recordResolver("paywall_wiring", actions, { gates: gates.length, screens: screens.length });
    }

    if (plan.resolversToRun.has("analytics_wiring") && monetization?.analyticsEvents && screens.length > 0) {
      const events = monetization.analyticsEvents as AnalyticsEventConfig[];
      const actions = await wireAnalyticsIntoScreens(repoPath, screens, events);
      recordResolver("analytics_wiring", actions, { events: events.length, screens: screens.length });
    }

    if (plan.resolversToRun.has("rate_limit_wiring") && edgeFunctions.length > 0) {
      const actions = await wireRateLimitIntoEdgeFunctions(repoPath, edgeFunctions);
      recordResolver("rate_limit_wiring", actions, { functions: edgeFunctions.length });
    }

    // ---- 6. Keep deterministic builder non-invasive in Cursor-first mode ----
    if (ENABLE_DETERMINISTIC_RESOLVERS) {
      const { actions: infraActions, commandsRun: infraCmds } = await applySafeInfrastructure(repoPath, isNode, ctx.logger);
      allFileActions.push(...infraActions);
      allCommandsRun.push(...infraCmds);

      // ---- 6b. Auto-fix lint/typecheck/format (up to 3 passes) ----
      const maxFixPasses = 3;
      for (let pass = 1; pass <= maxFixPasses; pass++) {
        const fixResults = await tidyCode(repoPath);
        const anyFixed = fixResults.some((r) => r.ok);
        for (const r of fixResults) {
          allCommandsRun.push(r);
          ctx.logger(`[builder] auto-fix pass ${pass}: ${r.cmd} ${r.ok ? "ok" : "failed"} (exit ${r.exitCode})`);
        }
        if (!anyFixed) break;

        const checkResults = await runQualityChecks(repoPath);
        const allPassing = checkResults.every((r) => r.ok);
        for (const r of checkResults) {
          allCommandsRun.push(r);
          ctx.logger(`[builder] post-fix check pass ${pass}: ${r.cmd} ${r.ok ? "passed" : "failed"} (exit ${r.exitCode})`);
        }
        if (allPassing) {
          notes.push(`Auto-fix pass ${pass}: all quality checks passing.`);
          break;
        }
        if (pass === maxFixPasses) {
          notes.push(`Auto-fix: ${maxFixPasses} passes complete, some checks still failing. QA will assess.`);
        }
      }
    } else {
      notes.push("Deterministic infrastructure/autofix passes skipped (Cursor-first loop).");
    }

    // ---- 7. Write implementation plan + cursor brief ----
    const planMd = generateImplementationPlan(plan, allFileActions, projectName, gitStatus.branch, gitStatus.headSha);
    await writeStageMarkdown(ctx, "builder", "IMPLEMENTATION_PLAN.md", planMd);

    const cursorBrief = gwParsed.success
      ? generateCursorBriefFromBuildSpec(
          projectName,
          gwParsed.data,
          audit,
          feedback,
          input.investorRefinement,
          previousChecklist,
        )
      : generateCursorBrief(
          projectName,
          audit,
          pdParsed.success ? pdParsed.data : undefined,
          monetization,
          plan,
          allFileActions,
          feedback,
          { paywallGatesDone, edgeRatePathsDone },
          input.investorRefinement,
          previousChecklist,
        );
    await writeStageMarkdown(ctx, "builder", "CURSOR_BRIEF.md", cursorBrief);

    await mkdir(join(repoPath, ".foundry"), { recursive: true });
    await writeFile(briefPath, cursorBrief, "utf8");
    notes.push(
      gwParsed.success
        ? "Wrote .foundry/CURSOR_BRIEF.md from BUILD_SPEC (Grand Wizard) — template must-ship regen skipped."
        : "Wrote .foundry/CURSOR_BRIEF.md — open this in Cursor to implement features.",
    );

    // ---- 8. Determine status ----
    const created = allFileActions.filter((a) => a.action === "created").map((a) => a.file);
    const modified = allFileActions.filter((a) => a.action === "modified").map((a) => a.file);
    const skipped = allFileActions.filter((a) => a.action === "skipped").map((a) => a.file);

    let finalStatus: "ok" | "partial" | "blocked" | "failed" = "ok";
    const unresolved = gapActions.filter((g) => g.resolver === "none");
    if (unresolved.length > 0 && created.length + modified.length === 0) {
      finalStatus = "partial";
      notes.push(
        "No deterministic resolver matched the remaining gaps. Handoff to Cursor via .foundry/CURSOR_BRIEF.md or add builder.directives in project.yaml for custom implementation.",
      );
    } else if (unresolved.length > 0) {
      finalStatus = "partial";
      notes.push(`${unresolved.length} gap(s) could not be automatically resolved. See IMPLEMENTATION_PLAN.md.`);
    }

    if (allCommandsRun.some((c) => !c.ok)) {
      notes.push("Some quality checks failed. Review commands for details.");
    }

    // ---- 9. Git commit ----
    const diffResult = await git.diff(repoPath);
    const totalChanges = diffResult.filesAdded.length + diffResult.filesChanged.length + diffResult.filesDeleted.length;

    let commitResult: { sha: string; message: string } | undefined;
    if (totalChanges > 0) {
      const goal = plan.goals[0]?.replace(/\.$/, "") ?? "refine product and quality";
      const commitMsg = `foundry: ${projectName} — ${goal}`;
      const added = await git.addRelevant(repoPath);
      if (!added) {
        throw new Error("Builder could not stage relevant repo changes for commit.");
      }
      const cr = await git.commit(repoPath, commitMsg);
      if (!cr.ok || !cr.sha) {
        throw new Error("Builder made repo changes but could not create a git commit.");
      }
      commitResult = { sha: cr.sha, message: commitMsg };
      notes.push(`Committed ${totalChanges} change(s) as ${cr.sha}.`);
      ctx.logger("[builder] committed", { sha: cr.sha, files: totalChanges });

      const pushed = await git.pushBranch(repoPath, branchName);
      if (!pushed) {
        throw new Error(`Builder committed changes on '${branchName}' but could not push the branch to origin.`);
      }
      notes.push(`Pushed branch '${branchName}' to origin.`);
    } else {
      notes.push("No files changed; everything was already present.");
    }

    // ---- 10. Stay on the branch (don't switch back) ----
    if (branchCreated) {
      notes.push(
        `Changes are on branch '${branchName}'. ` +
        `Review with 'git diff ${gitStatus.branch}...${branchName}'. Foundry promotion merges this branch into main and pushes main during release approval.`,
      );
    }

    // ---- 11. Build output ----
    const output: BuilderOutput = {
      branchName,
      baseBranch: gitStatus.branch,
      plan: {
        goals: plan.goals,
        filesToTouch: [...new Set([...plan.filesToTouch, ...created, ...modified])],
        gapsAddressed: plan.gapsAddressed,
        feedbackAddressed: plan.feedbackAddressed,
        risksNoted: plan.risksNoted,
      },
      commandsRun: allCommandsRun,
      changes: { filesCreated: created, filesModified: modified, filesSkipped: skipped },
      commit: commitResult,
      status: finalStatus,
      notes,
    };

    const validated = BuilderOutputSchema.parse(output);

    await writeStageMarkdown(
      ctx,
      "builder",
      "README.md",
      generateSummary(validated, projectName, gitStatus.branch, gitStatus.headSha),
    );

    return validated;
  },
};
