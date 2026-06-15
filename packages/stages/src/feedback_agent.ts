import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { writeStageMarkdown } from "@foundry/core/artifacts";
import {
  isAutoApprovedFeedback,
  resolveFeedbackOwnerEmails,
  type FeedbackImplementationApproval,
} from "@foundry/core/feedbackPolicy";
import { StageInputCompositionSchema, type StageInputComposition } from "@foundry/core/stageInputs";
import type { RunContext, Stage } from "@foundry/core/types";
import { z } from "zod";

import { sh } from "./_shared/exec.js";
import { CurrentStateAuditOutputSchema } from "./current_state_audit.js";
import { ProductDefinitionOutputSchema } from "./product_definition.js";

const MAX_TEXT_BYTES = 256 * 1024;
const FEEDBACK_LEDGER_FILENAME = "feedback-ledger.json";
const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "have",
  "has",
  "are",
  "was",
  "were",
  "been",
  "being",
  "not",
  "but",
  "can",
  "could",
  "would",
  "should",
  "when",
  "what",
  "which",
  "while",
  "into",
  "about",
  "your",
  "you",
  "our",
  "their",
  "they",
  "them",
  "its",
  "also",
  "just",
  "than",
  "then",
  "there",
  "here",
  "some",
  "any",
  "all",
  "will",
  "may",
  "might",
  "using",
  "use",
  "used",
]);

const FeedbackLedgerItemSchema = z.object({
  id: z.string(),
  type: z.enum(["bug", "feature_request", "complaint", "praise", "crash"]),
  summary: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  source: z.string(),
  relatedGap: z.string().optional(),
  relatedAC: z.string().optional(),
  timestamp: z.string().optional(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  seenCount: z.number().int().min(1),
  status: z.enum(["open", "resolved", "ignored"]),
  repoActionable: z.boolean(),
  shouldImplement: z.boolean(),
  submitterEmail: z.string().optional(),
  implementationApproval: z
    .enum(["auto", "pending", "approved", "declined", "postponed"])
    .optional(),
  implementationNote: z.string().optional(),
  presentInLatestCollection: z.boolean(),
});

const FeedbackLedgerSchema = z.object({
  updatedAt: z.string(),
  items: z.array(FeedbackLedgerItemSchema),
});
const MAX_FOUNDRY_LOG_RUN_DIRS = 6;
const GENERATED_FEEDBACK_SOURCE_PREFIXES = ["foundry:", "crash:"];

export const FeedbackAgentOutputSchema = z.object({
  collectedAt: z.string(),
  ledgerPath: z.string(),
  ledgerSummary: z.object({
    totalItems: z.number().int().min(0),
    openItems: z.number().int().min(0),
    implementNowItems: z.number().int().min(0),
    resolvedItems: z.number().int().min(0),
    ignoredItems: z.number().int().min(0),
  }),
  sources: z.array(
    z.object({
      name: z.string(),
      itemCount: z.number().int().min(0),
      available: z.boolean(),
    }),
  ),
  items: z.array(FeedbackLedgerItemSchema),
  patterns: z.array(
    z.object({
      theme: z.string(),
      count: z.number().int().min(1),
      severity: z.enum(["critical", "important", "minor"]),
      suggestedAction: z.string(),
    }),
  ),
  suggestions: z.array(z.string()),
  trends: z.object({
    totalFeedback: z.number().int().min(0),
    bugCount: z.number().int().min(0),
    featureRequestCount: z.number().int().min(0),
    previousRunBugCount: z.number().int().min(0).nullable(),
    trend: z.enum(["improving", "stable", "worsening", "no_prior_data"]),
  }),
  nextPipelineHints: z.object({
    prioritizeGaps: z.array(z.string()),
    skipAreas: z.array(z.string()),
    newFeatureRequests: z.array(z.string()),
  }),
});

export type FeedbackAgentOutput = z.infer<typeof FeedbackAgentOutputSchema>;
type FeedbackLedger = z.infer<typeof FeedbackLedgerSchema>;
type FeedbackItem = z.infer<typeof FeedbackLedgerItemSchema>;
type RawFeedbackItem = Pick<
  FeedbackItem,
  "id" | "type" | "summary" | "priority" | "source" | "relatedGap" | "relatedAC" | "timestamp"
> & {
  submitterEmail?: string;
};

function stableId(parts: string[]): string {
  const h = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12);
  return `fb-${h}`;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((w) => w.length >= 4 && !STOP.has(w));
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) {
    if (B.has(x)) inter++;
  }
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

async function readTextSafe(abs: string, maxBytes = MAX_TEXT_BYTES): Promise<string | undefined> {
  try {
    const s = await stat(abs);
    if (!s.isFile() || s.size > maxBytes) return undefined;
    return await readFile(abs, "utf8");
  } catch {
    return undefined;
  }
}

async function readRepoEnv(repoPath: string): Promise<Record<string, string>> {
  const candidates = [join(repoPath, ".env"), join(repoPath, ".env.local")];
  const out: Record<string, string> = {};
  for (const abs of candidates) {
    const raw = await readTextSafe(abs, 128 * 1024);
    if (!raw) continue;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  }
  return out;
}

function feedbackLedgerPath(repoPath: string): string {
  return join(repoPath, ".foundry", FEEDBACK_LEDGER_FILENAME);
}

async function readFeedbackLedger(repoPath: string): Promise<FeedbackLedger> {
  const abs = feedbackLedgerPath(repoPath);
  const raw = await readTextSafe(abs, 2 * 1024 * 1024);
  if (!raw) {
    return { updatedAt: "", items: [] };
  }
  try {
    const parsed = FeedbackLedgerSchema.safeParse(JSON.parse(raw) as unknown);
    if (parsed.success) return parsed.data;
  } catch {
    /* ignore invalid ledger and rebuild from sources */
  }
  return { updatedAt: "", items: [] };
}

async function writeFeedbackLedger(repoPath: string, ledger: FeedbackLedger): Promise<void> {
  const abs = feedbackLedgerPath(repoPath);
  await mkdir(join(repoPath, ".foundry"), { recursive: true });
  await writeFile(abs, JSON.stringify(ledger, null, 2), "utf8");
}

async function listRunDirectories(repoPath: string): Promise<string[]> {
  const outRoot = join(repoPath, ".foundry", "out");
  let names: string[];
  try {
    names = await readdir(outRoot);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const name of names) {
    const p = join(outRoot, name);
    try {
      if ((await stat(p)).isDirectory()) dirs.push(name);
    } catch {
      /* skip */
    }
  }
  dirs.sort((a, b) => b.localeCompare(a));
  return dirs;
}

async function findPrefixedStageOutput(runDir: string, stageSuffix: string): Promise<string | undefined> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(runDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name.endsWith(`_${stageSuffix}`)) {
      const p = join(runDir, e.name, "output.json");
      try {
        if ((await stat(p)).isFile()) return p;
      } catch {
        /* continue */
      }
    }
  }
  return undefined;
}

async function readPriorFeedbackOutput(
  repoPath: string,
  currentRunId: string,
): Promise<FeedbackAgentOutput | undefined> {
  const runs = await listRunDirectories(repoPath);
  for (const runId of runs) {
    if (runId === currentRunId) continue;
    const outPath = await findPrefixedStageOutput(join(repoPath, ".foundry", "out", runId), "feedback_agent");
    if (!outPath) continue;
    const raw = await readTextSafe(outPath, 2 * 1024 * 1024);
    if (!raw) continue;
    try {
      const j = JSON.parse(raw) as unknown;
      const parsed = FeedbackAgentOutputSchema.safeParse(j);
      if (parsed.success) return parsed.data;
    } catch {
      /* skip */
    }
  }
  return undefined;
}

function extractEmailFromContext(context: unknown): string | undefined {
  if (!context || typeof context !== "object") return undefined;
  const record = context as Record<string, unknown>;
  for (const key of ["email", "user_email", "submitter_email", "author_email"]) {
    if (typeof record[key] === "string" && record[key]) return record[key]!.trim().toLowerCase();
  }
  return undefined;
}

function extractSubmitterEmail(
  row: Record<string, unknown>,
  userEmailById: Map<string, string>,
): string | undefined {
  const fromContext = extractEmailFromContext(row.context);
  if (fromContext) return fromContext;
  if (typeof row.user_email === "string" && row.user_email) return row.user_email.trim().toLowerCase();
  if (typeof row.email === "string" && row.email) return row.email.trim().toLowerCase();
  const userId = typeof row.user_id === "string" ? row.user_id : undefined;
  if (userId && userEmailById.has(userId)) return userEmailById.get(userId);
  return undefined;
}

async function resolveAuthUserEmails(
  ctx: RunContext,
  url: string,
  key: string,
  userIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(userIds.filter(Boolean))].slice(0, 100);
  if (unique.length === 0) return map;

  const esc = (s: string) => s.replace(/'/g, `'\\''`);
  const base = url.replace(/\/$/, "");
  for (const userId of unique) {
    const endpoint = `${base}/auth/v1/admin/users/${userId}`;
    const cmd = `curl -sS '${esc(endpoint)}' -H 'apikey: ${esc(key)}' -H 'Authorization: Bearer ${esc(key)}'`;
    const res = await sh(cmd, ctx.repoPath, 15_000);
    if (res.exitCode !== 0) continue;
    try {
      const user = JSON.parse(res.stdout) as { email?: string };
      if (typeof user.email === "string" && user.email) {
        map.set(userId, user.email.trim().toLowerCase());
      }
    } catch {
      /* skip malformed auth response */
    }
  }
  return map;
}

async function collectSupabase(ctx: RunContext): Promise<{ items: RawFeedbackItem[]; available: boolean }> {
  const repoEnv = await readRepoEnv(ctx.repoPath);
  const url =
    process.env.SUPABASE_URL ??
    repoEnv.SUPABASE_URL ??
    process.env.EXPO_PUBLIC_SUPABASE_URL ??
    repoEnv.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? repoEnv.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return { items: [], available: false };
  }

  const esc = (s: string) => s.replace(/'/g, `'\\''`);
  const fetchRows = async (table: string): Promise<Record<string, unknown>[] | undefined> => {
    const endpoint = `${url.replace(/\/$/, "")}/rest/v1/${table}?select=*&order=created_at.desc.nullslast&limit=200`;
    const cmd = `curl -sS '${esc(endpoint)}' -H 'apikey: ${esc(key)}' -H 'Authorization: Bearer ${esc(key)}' -H 'Content-Type: application/json'`;
    const res = await sh(cmd, ctx.repoPath, 45_000);
    if (res.exitCode !== 0) {
      ctx.logger("[feedback_agent] Supabase curl failed", { table, stderr: res.stderr.slice(0, 500) });
      return undefined;
    }
    try {
      const rows = JSON.parse(res.stdout) as unknown;
      if (!Array.isArray(rows)) return [];
      return rows as Record<string, unknown>[];
    } catch {
      return undefined;
    }
  };

  const rows = (await fetchRows("feedback_events")) ?? (await fetchRows("feedback"));
  if (!rows) return { items: [], available: false };

  const userIds = rows
    .map((row) => (typeof row.user_id === "string" ? row.user_id : undefined))
    .filter((id): id is string => Boolean(id));
  const userEmailById = await resolveAuthUserEmails(ctx, url, key, userIds);

  const items: RawFeedbackItem[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const summary =
      (typeof row.text === "string" && row.text) ||
      (typeof row.message === "string" && row.message) ||
      (typeof row.body === "string" && row.body) ||
      (typeof row.summary === "string" && row.summary) ||
      JSON.stringify(row).slice(0, 500);

    const rawType = typeof row.type === "string" ? row.type.toLowerCase() : "";
    const rawSeverity = typeof row.severity === "string" ? row.severity.toLowerCase() : "";
    let type: FeedbackItem["type"] = "complaint";
    if (rawType.includes("crash") || rawSeverity.includes("crash") || rawSeverity.includes("fatal")) type = "crash";
    else if (rawType.includes("bug") || rawSeverity.includes("bug") || rawSeverity.includes("error")) type = "bug";
    else if (rawType.includes("feature") || rawType.includes("request") || rawSeverity.includes("idea")) type = "feature_request";
    else if (rawType.includes("praise") || rawType.includes("positive")) type = "praise";
    else if (rawType.includes("complaint")) type = "complaint";

    let priority: FeedbackItem["priority"] = "medium";
    if (
      type === "crash" ||
      rawSeverity.includes("high") ||
      rawSeverity.includes("critical") ||
      rawSeverity.includes("urgent")
    ) priority = "high";
    else if (rawSeverity.includes("low")) priority = "low";

    const route = (() => {
      const context = row.context;
      if (!context || typeof context !== "object") return "";
      const value = (context as Record<string, unknown>).route;
      return typeof value === "string" && value ? ` route=${value}` : "";
    })();

    const id =
      typeof row.id === "string"
        ? `supabase-${row.id}`
        : stableId(["supabase", String(i), summary.slice(0, 120)]);
    const ts =
      typeof row.created_at === "string"
        ? row.created_at
        : typeof row.updated_at === "string"
          ? row.updated_at
          : undefined;

    items.push({
      id,
      type,
      summary: `${summary.slice(0, 1800)}${route}`.slice(0, 2000),
      priority,
      source: "supabase",
      timestamp: ts,
      submitterEmail: extractSubmitterEmail(row, userEmailById),
    });
  }

  return { items, available: true };
}

function classifyFromText(text: string): { type: FeedbackItem["type"]; priority: FeedbackItem["priority"] } {
  const lower = text.toLowerCase();
  if (/\b(fatal|crash|sigsegv|native crash|exited unexpectedly)\b/i.test(lower)) {
    return { type: "crash", priority: "high" };
  }
  if (/\b(exception|stack trace|error:|uncaught)\b/i.test(lower) && /\b(at |\.tsx?:|native)\b/i.test(lower)) {
    return { type: "crash", priority: "high" };
  }
  if (/\b(bug|broken|doesn'?t work|not working|incorrect)\b/i.test(lower)) {
    return { type: "bug", priority: /\b(blocking|critical|severe)\b/i.test(lower) ? "high" : "medium" };
  }
  if (/\b(feature|wish|would love|please add|roadmap|enhancement)\b/i.test(lower)) {
    return { type: "feature_request", priority: "medium" };
  }
  if (/\b(love|great|awesome|thanks|excellent|perfect)\b/i.test(lower)) {
    return { type: "praise", priority: "low" };
  }
  if (/\b(slow|hate|terrible|annoying|frustrat|worst)\b/i.test(lower)) {
    return { type: "complaint", priority: "medium" };
  }
  return { type: "complaint", priority: "medium" };
}

/**
 * Repo-fixable compile / bundle / runtime errors that can appear inside EAS/Xcode build logs.
 * When these are present we want Cursor to treat the failure as actionable.
 */
const REPO_FIXABLE_BUILD_ERROR_RE =
  /(command not found|failed to read the app config|valid config plugin|config plugin|unexpected token|cannot find (module|name|type)|module not found|unable to resolve module|ts\d{4}:|type '\w+' is not assignable|syntaxerror|referenceerror|typeerror|undefined is not an object|\bld: symbol not found\b|duplicate symbol|undefined symbol|unrecognized selector|use of undeclared identifier|expected declaration|\bswift compiler error\b|expression was too complex|transform error|metro (has encountered|error)|babel.*error|invalid hook call|invariant violation|\bpod install\b.*(fail|error)|podfile.*(fail|error)|\bpackage\.json\b.*(invalid|error)|jest.*failed|test suite failed to run)/i;

/** Clearly external signals that the repo cannot fix on its own. */
const EXTERNAL_ONLY_SIGNAL_RE =
  /\b(provisioning|app store connect|apple developer|push notifications capability|aps-environment|credential|secret|service role|command unavailable|not available in the current shell|authentication required|agent login|must configure eas project|running 'eas init'|run eas init|shell_session_update)\b/i;

function inferImplementation(raw: RawFeedbackItem): Pick<FeedbackItem, "repoActionable" | "shouldImplement" | "implementationNote"> {
  const lower = raw.summary.toLowerCase();
  if (raw.type === "praise") {
    return {
      repoActionable: false,
      shouldImplement: false,
      implementationNote: "Praise signal only; not an implementation task.",
    };
  }
  if (EXTERNAL_ONLY_SIGNAL_RE.test(lower)) {
    return {
      repoActionable: false,
      shouldImplement: false,
      implementationNote: "External/tooling signal (certs/provisioning/auth); review separately from repo implementation work.",
    };
  }
  if (/\b(eas[- ]build|xcode_build_error|expo build|build failed|build command failed|app config|config plugin)\b/i.test(lower)) {
    if (REPO_FIXABLE_BUILD_ERROR_RE.test(lower)) {
      return {
        repoActionable: true,
        shouldImplement: true,
        implementationNote:
          "EAS/Xcode/Expo build log contains repo-fixable compile/bundle/runtime error — queued for Cursor.",
      };
    }
    return {
      repoActionable: true,
      shouldImplement: false,
      implementationNote:
        "EAS/Xcode/Expo build failed but the log did not match a known repo-fixable pattern; review the log manually and mark shouldImplement=true if it is actionable.",
    };
  }
  if (raw.type === "feature_request") {
    return {
      repoActionable: true,
      shouldImplement: false,
      implementationNote: "Feature request defaults to review before implementation.",
    };
  }
  if (raw.type === "complaint") {
    return {
      repoActionable: true,
      shouldImplement: false,
      implementationNote: "Complaint defaults to monitor until explicitly selected for implementation.",
    };
  }
  return {
    repoActionable: true,
    shouldImplement: true,
    implementationNote: "Repo-actionable bug/crash defaults to implementation.",
  };
}

function sortFeedbackItems(items: FeedbackItem[]): FeedbackItem[] {
  const priorityRank: Record<FeedbackItem["priority"], number> = { high: 0, medium: 1, low: 2 };
  const statusRank: Record<FeedbackItem["status"], number> = { open: 0, resolved: 1, ignored: 2 };
  return [...items].sort((a, b) => {
    const byStatus = statusRank[a.status] - statusRank[b.status];
    if (byStatus !== 0) return byStatus;
    const byImplement = Number(b.shouldImplement) - Number(a.shouldImplement);
    if (byImplement !== 0) return byImplement;
    const byPriority = priorityRank[a.priority] - priorityRank[b.priority];
    if (byPriority !== 0) return byPriority;
    return b.lastSeenAt.localeCompare(a.lastSeenAt);
  });
}

function resolveFeedbackImplementation(
  raw: RawFeedbackItem,
  prior: FeedbackItem | undefined,
  inferred: Pick<FeedbackItem, "repoActionable" | "shouldImplement" | "implementationNote">,
  ownerEmails: Set<string>,
): Pick<
  FeedbackItem,
  "repoActionable" | "shouldImplement" | "implementationNote" | "submitterEmail" | "implementationApproval"
> {
  const submitterEmail = raw.submitterEmail ?? prior?.submitterEmail;
  const autoApproved = isAutoApprovedFeedback(raw.source, submitterEmail, ownerEmails);

  if (autoApproved && raw.type !== "praise") {
    return {
      submitterEmail,
      repoActionable: true,
      shouldImplement: true,
      implementationApproval: "auto",
      implementationNote:
        prior?.implementationNote ??
        (raw.source.startsWith("manual:")
          ? "CLI/manual feedback — auto-approved for implementation."
          : "Owner feedback — auto-approved for implementation."),
    };
  }

  if (raw.source === "supabase" && !autoApproved) {
    const priorApproval = prior?.implementationApproval;
    if (priorApproval === "approved") {
      return {
        submitterEmail,
        repoActionable: true,
        shouldImplement: true,
        implementationApproval: "approved",
        implementationNote: prior?.implementationNote ?? inferred.implementationNote,
      };
    }
    if (priorApproval === "declined") {
      return {
        submitterEmail,
        repoActionable: inferred.repoActionable || prior?.repoActionable || false,
        shouldImplement: false,
        implementationApproval: "declined",
        implementationNote: prior?.implementationNote ?? "Declined during Foundry loop review.",
      };
    }
    return {
      submitterEmail,
      repoActionable: inferred.repoActionable || prior?.repoActionable || false,
      shouldImplement: false,
      implementationApproval: "pending",
      implementationNote:
        prior?.implementationNote ??
        `External feedback from ${submitterEmail ?? "unknown submitter"} — approve during Foundry loop to implement.`,
    };
  }

  const repoActionable = inferred.repoActionable ? (prior?.repoActionable ?? false) || true : prior?.repoActionable ?? false;
  let shouldImplement = inferred.shouldImplement;
  if (prior?.shouldImplement === true && (prior.implementationApproval === "approved" || prior.implementationApproval === "auto")) {
    shouldImplement = true;
  } else if (inferred.shouldImplement) {
    shouldImplement = (prior?.shouldImplement ?? false) || true;
  } else if (prior?.shouldImplement === true && prior.implementationApproval === "approved") {
    shouldImplement = true;
  } else {
    shouldImplement = false;
  }

  let implementationApproval: FeedbackImplementationApproval | undefined = prior?.implementationApproval;
  if (shouldImplement && !implementationApproval && inferred.shouldImplement) {
    implementationApproval = "approved";
  }

  return {
    submitterEmail,
    repoActionable,
    shouldImplement,
    implementationApproval,
    implementationNote: prior?.implementationNote ?? inferred.implementationNote,
  };
}

function mergeLedger(
  existing: FeedbackLedger,
  collected: RawFeedbackItem[],
  collectedAt: string,
  ownerEmails: Set<string>,
): FeedbackLedger {
  const priorById = new Map(existing.items.map((item) => [item.id, item]));
  const merged: FeedbackItem[] = [];
  const isGeneratedSource = (source: string): boolean =>
    GENERATED_FEEDBACK_SOURCE_PREFIXES.some((prefix) => source.startsWith(prefix));

  for (const raw of collected) {
    const prior = priorById.get(raw.id);
    const inferred = inferImplementation(raw);
    const resolved = resolveFeedbackImplementation(raw, prior, inferred, ownerEmails);
    const generatedPrior = prior ? isGeneratedSource(prior.source) : false;
    const sameGeneratedSignal = generatedPrior && prior?.summary === raw.summary;
    const status =
      prior?.status === "ignored"
        ? "ignored"
        : prior?.status === "resolved" && sameGeneratedSignal
          ? "resolved"
          : prior && generatedPrior
            ? "open"
            : (prior?.status ?? "open");
    const shouldRefreshNote =
      !prior?.implementationNote ||
      (!prior.shouldImplement && resolved.shouldImplement) ||
      (!prior.repoActionable && resolved.repoActionable) ||
      prior.implementationApproval !== resolved.implementationApproval;
    merged.push({
      id: raw.id,
      type: raw.type,
      summary: raw.summary,
      priority: raw.priority,
      source: raw.source,
      relatedGap: raw.relatedGap,
      relatedAC: raw.relatedAC,
      timestamp: raw.timestamp,
      firstSeenAt: prior?.firstSeenAt ?? collectedAt,
      lastSeenAt: collectedAt,
      seenCount: Math.max(1, (prior?.seenCount ?? 0) + 1),
      status,
      repoActionable: resolved.repoActionable,
      shouldImplement: resolved.shouldImplement,
      submitterEmail: resolved.submitterEmail,
      implementationApproval: resolved.implementationApproval,
      implementationNote: shouldRefreshNote ? resolved.implementationNote : prior?.implementationNote,
      presentInLatestCollection: true,
    });
  }

  for (const prior of existing.items) {
    if (merged.some((item) => item.id === prior.id)) continue;
    const staleGeneratedOpen = prior.status === "open" && isGeneratedSource(prior.source);
    let next: FeedbackItem = {
      ...prior,
      status: staleGeneratedOpen ? "resolved" : prior.status,
      implementationNote: staleGeneratedOpen
        ? [
            prior.implementationNote,
            "Auto-resolved because this generated log signal was absent from the latest collection.",
          ]
            .filter(Boolean)
            .join(" ")
        : prior.implementationNote,
      presentInLatestCollection: false,
    };
    if (
      isAutoApprovedFeedback(prior.source, prior.submitterEmail, ownerEmails) &&
      prior.status === "open" &&
      prior.type !== "praise"
    ) {
      next = {
        ...next,
        repoActionable: true,
        shouldImplement: true,
        implementationApproval: "auto",
      };
    }
    merged.push(next);
  }

  return {
    updatedAt: collectedAt,
    items: sortFeedbackItems(merged),
  };
}

async function collectManualFeedback(repoPath: string): Promise<RawFeedbackItem[]> {
  const dir = join(repoPath, ".foundry", "feedback");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const items: RawFeedbackItem[] = [];
  for (const name of names) {
    if (!/\.(json|txt)$/i.test(name)) continue;
    const abs = join(dir, name);
    const raw = await readTextSafe(abs);
    if (!raw) continue;

    if (name.toLowerCase().endsWith(".json")) {
      try {
        const j = JSON.parse(raw) as unknown;
        const pushOne = (obj: Record<string, unknown>, idx: number) => {
          const summary =
            (typeof obj.summary === "string" && obj.summary) ||
            (typeof obj.message === "string" && obj.message) ||
            (typeof obj.text === "string" && obj.text) ||
            "";
          if (!summary.trim()) return;
          const tRaw = typeof obj.type === "string" ? obj.type : "";
          let type: FeedbackItem["type"];
          if (tRaw === "feature_request" || tRaw === "feature") type = "feature_request";
          else if (tRaw === "bug") type = "bug";
          else if (tRaw === "praise") type = "praise";
          else if (tRaw === "complaint") type = "complaint";
          else if (tRaw === "crash") type = "crash";
          else {
            const c = classifyFromText(summary);
            type = c.type;
          }
          const pr = typeof obj.priority === "string" ? obj.priority : "";
          let priority: FeedbackItem["priority"] = "medium";
          if (pr === "high" || pr === "low" || pr === "medium") priority = pr;
          else priority = classifyFromText(summary).priority;
          items.push({
            id: stableId(["manual", name, String(idx), summary.slice(0, 80)]),
            type,
            summary: summary.slice(0, 2000),
            priority,
            source: `manual:${basename(name)}`,
            timestamp: typeof obj.timestamp === "string" ? obj.timestamp : undefined,
          });
        };

        if (Array.isArray(j)) {
          j.forEach((x, i) => {
            if (x && typeof x === "object") pushOne(x as Record<string, unknown>, i);
          });
        } else if (j && typeof j === "object") {
          const o = j as Record<string, unknown>;
          if (Array.isArray(o.items)) {
            (o.items as unknown[]).forEach((x, i) => {
              if (x && typeof x === "object") pushOne(x as Record<string, unknown>, i);
            });
          } else {
            pushOne(o, 0);
          }
        }
      } catch {
        const c = classifyFromText(raw);
        items.push({
          id: stableId(["manual", name, "raw"]),
          type: c.type,
          summary: raw.trim().slice(0, 2000),
          priority: c.priority,
          source: `manual:${basename(name)}`,
        });
      }
    } else {
      const c = classifyFromText(raw);
      items.push({
        id: stableId(["manual", name, "txt"]),
        type: c.type,
        summary: raw.trim().slice(0, 2000),
        priority: c.priority,
        source: `manual:${basename(name)}`,
      });
    }
  }

  return items;
}

const CRASH_LOG_CANDIDATES = [
  "expo-go.log",
  "metro.log",
  "yarn-error.log",
  "npm-debug.log",
  "pnpm-debug.log",
];

async function collectCrashLogs(repoPath: string, ctx: RunContext): Promise<RawFeedbackItem[]> {
  const items: RawFeedbackItem[] = [];
  const roots = [
    repoPath,
    join(repoPath, ".expo"),
    join(repoPath, "ios"),
    join(repoPath, "android"),
  ];

  const seen = new Set<string>();
  for (const root of roots) {
    for (const fname of CRASH_LOG_CANDIDATES) {
      const abs = join(root, fname);
      if (seen.has(abs)) continue;
      seen.add(abs);
      const text = await readTextSafe(abs, 512 * 1024);
      if (!text || text.length < 40) continue;
      if (!/\b(Error|Exception|FATAL|crash|SIG|fatal)\b/i.test(text)) continue;
      const snippet = text.split(/\r?\n/).slice(0, 24).join("\n").slice(0, 1500);
      items.push({
        id: stableId(["crashlog", abs]),
        type: "crash",
        summary: `Crash log (${basename(abs)}): ${snippet}`,
        priority: "high",
        source: `crash:${basename(abs)}`,
      });
    }
  }

  const expoDir = join(repoPath, ".expo");
  try {
    const expoFiles = await readdir(expoDir);
    for (const name of expoFiles) {
      if (!/\.log$/i.test(name)) continue;
      const abs = join(expoDir, name);
      const text = await readTextSafe(abs, 512 * 1024);
      if (!text || text.length < 40) continue;
      if (!/\b(Error|Exception|FATAL|crash)\b/i.test(text)) continue;
      const snippet = text.split(/\r?\n/).slice(0, 20).join("\n").slice(0, 1500);
      items.push({
        id: stableId(["crashlog", name]),
        type: "crash",
        summary: `Expo log (${name}): ${snippet}`,
        priority: "high",
        source: `crash:.expo/${name}`,
      });
    }
  } catch {
    /* no .expo */
  }

  if (items.length) {
    ctx.logger(`[feedback_agent] collected ${items.length} crash log signal(s)`);
  }
  return items;
}

/**
 * `expo-build-view.json` is the Foundry-persisted output of `eas build:view <id> --json`.
 * The real failure (JS/native/package error) lives inside the remote build record,
 * NOT the local `eas build` stdout. This extracts the actionable bits: status,
 * error.errorCode, error.message, logsUrl/artifacts URLs.
 */
function extractExpoBuildViewSummary(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  type ExpoBuildViewJson = {
    id?: unknown;
    status?: unknown;
    platform?: unknown;
    appVersion?: unknown;
    sdkVersion?: unknown;
    logFiles?: unknown;
    logsUrl?: unknown;
    logs?: unknown;
    artifacts?: { buildUrl?: unknown; xcodeBuildLogsUrl?: unknown } | null;
    error?: {
      errorCode?: unknown;
      code?: unknown;
      message?: unknown;
      docsUrl?: unknown;
    } | null;
  };

  const normalize = (input: unknown): ExpoBuildViewJson | null => {
    if (!input || typeof input !== "object") return null;
    const root = input as Record<string, unknown>;
    const candidate =
      Array.isArray(root)
        ? root[0]
        : root.data &&
            typeof root.data === "object" &&
            (root.data as Record<string, unknown>).builds &&
            typeof (root.data as Record<string, unknown>).builds === "object" &&
            ((root.data as Record<string, unknown>).builds as Record<string, unknown>).byId
          ? ((root.data as Record<string, unknown>).builds as Record<string, unknown>).byId
          : root;
    return candidate && typeof candidate === "object" ? (candidate as ExpoBuildViewJson) : null;
  };

  let parsed: ExpoBuildViewJson | null = null;
  const candidates = [trimmed];
  const stdoutMatch = text.match(/=== STDOUT ===\n([\s\S]*?)(?:\n===|$)/);
  if (stdoutMatch?.[1]) candidates.push(stdoutMatch[1].trim());
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      parsed = normalize(JSON.parse(candidate));
    } catch {
      parsed = null;
    }
    if (parsed) break;
  }
  if (!parsed) return null;

  const lines: string[] = [];
  const push = (label: string, v: unknown) => {
    if (v === null || v === undefined || v === "") return;
    lines.push(`${label}: ${String(v).slice(0, 2000)}`);
  };
  push("buildId", parsed.id);
  push("status", parsed.status);
  push("platform", parsed.platform);
  push("appVersion", parsed.appVersion);
  push("sdkVersion", parsed.sdkVersion);
  push("logsUrl", parsed.logsUrl ?? parsed.logs);
  if (Array.isArray(parsed.logFiles)) push("logFileCount", parsed.logFiles.length);
  if (parsed.artifacts && typeof parsed.artifacts === "object") {
    push("artifacts.buildUrl", parsed.artifacts.buildUrl);
    push("artifacts.xcodeBuildLogsUrl", parsed.artifacts.xcodeBuildLogsUrl);
  }
  if (parsed.error && typeof parsed.error === "object") {
    push("error.errorCode", parsed.error.errorCode ?? parsed.error.code);
    push("error.message", parsed.error.message);
    push("error.docsUrl", parsed.error.docsUrl);
  }
  const statusStr = typeof parsed.status === "string" ? parsed.status.toLowerCase() : "";
  const hasError = Boolean(parsed.error) || /errored|fail|cancelled/.test(statusStr);
  if (!hasError) return null;
  return `Expo build error — ${lines.join(" · ")}`;
}

async function collectFoundryLogs(repoPath: string, ctx: RunContext): Promise<RawFeedbackItem[]> {
  const files: string[] = [];
  const roots = [
    join(repoPath, ".foundry", "releases"),
    join(repoPath, ".foundry", "automation"),
  ];

  for (const root of roots) {
    try {
      let runDirs = await readdir(root);
      runDirs = [...runDirs].sort().reverse().slice(0, MAX_FOUNDRY_LOG_RUN_DIRS);
      for (const runId of runDirs) {
        const runDir = join(root, runId);
        let names: string[];
        try {
          names = await readdir(runDir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (/\.(log|txt|json)$/i.test(name)) files.push(join(runDir, name));
        }
      }
    } catch {
      /* no log root */
    }
  }

  const items: RawFeedbackItem[] = [];
  for (const abs of files) {
    const text = await readTextSafe(abs, 1024 * 1024);
    if (!text) continue;
    const base = basename(abs);
    const isExpoBuildView = /expo-build-view\.json$/i.test(base);
    if (
      !isExpoBuildView &&
      !/\b(crash|fatal|exception|error|build failed|build command failed|failed to read the app config|valid config plugin|unexpected token|xcode_build_error|app init error)\b/i.test(
        text,
      )
    ) continue;

    let snippet = text;
    if (isExpoBuildView) {
      const summary = extractExpoBuildViewSummary(text);
      if (!summary) continue;
      snippet = summary;
    } else if (/xcode_build_error|build failed|build command failed|eas[- ]build|app config|config plugin/i.test(text)) {
      const match = text.match(/"message":\s*"([^"]{20,4000})"/i);
      if (match?.[1]) {
        snippet = match[1];
      } else {
        const lines = text.split(/\r?\n/);
        const errorLineRe = /\b(error|exception|crash|fatal|command not found|failed to read the app config|valid config plugin|config plugin|unexpected token|cannot find|module not found|unable to resolve|ts\d{4}:|ld:|undefined symbol|swift compiler error|metro|invariant violation|pod install|podfile)\b/i;
        const errorLines: string[] = [];
        for (let i = 0; i < lines.length && errorLines.length < 40; i++) {
          if (errorLineRe.test(lines[i])) {
            const start = Math.max(0, i - 1);
            const end = Math.min(lines.length, i + 3);
            for (let j = start; j < end && errorLines.length < 40; j++) {
              errorLines.push(lines[j]);
            }
          }
        }
        snippet = errorLines.join("\n") || text.slice(-2000);
      }
    } else {
      snippet =
        text
          .split(/\r?\n/)
          .filter((line) => /\b(error|exception|crash|fatal)\b/i.test(line))
          .slice(0, 12)
          .join("\n") || text.slice(0, 1500);
    }

    if (/builder\.log$/i.test(base)) {
      if (
        /\[process-error\]|connection lost|reconnecting|retry attempt|shell_session_update|cursor agent produced reconnect-only/i.test(
          snippet,
        )
      ) {
        continue;
      }
      if (
        /^(## )?pass complete|primary slice complete|automation-log process/i.test(snippet.trim()) &&
        !/\b(apps|packages|supabase)\//.test(snippet)
      ) {
        continue;
      }
    }

    const kind = /release/i.test(abs) ? "release_log" : "automation_log";
    const isHighPriority =
      isExpoBuildView ||
      /push notifications capability|xcode_build_error|build failed|build command failed|app config|config plugin|unexpected token|app init error/i.test(snippet);
    items.push({
      id: stableId(["foundry-log", abs]),
      type: isExpoBuildView
        ? "bug"
        : /crash|app init error|errorboundary/i.test(snippet)
          ? "crash"
          : "bug",
      summary: `${kind}: ${basename(abs)} — ${snippet}`.slice(0, 2000),
      priority: isHighPriority ? "high" : "medium",
      source: `foundry:${basename(abs)}`,
    });
  }

  if (items.length) ctx.logger(`[feedback_agent] collected ${items.length} foundry log signal(s)`);
  return items;
}

function collectPipelineSignals(input: StageInputComposition): RawFeedbackItem[] {
  void input;
  return [];
}

function crossReference(
  items: RawFeedbackItem[],
  gaps: Array<{ description: string }>,
  acs: Array<{ id: string; description: string }>,
): RawFeedbackItem[] {
  return items.map((it) => {
    const tok = tokenize(it.summary);
    let bestGap: string | undefined;
    let bestG = 0;
    for (const g of gaps) {
      const score = jaccard(tok, tokenize(g.description));
      if (score > bestG && score >= 0.12) {
        bestG = score;
        bestGap = g.description;
      }
    }
    let bestAc: string | undefined;
    let bestA = 0;
    for (const a of acs) {
      const score = jaccard(tok, tokenize(a.description + " " + a.id));
      if (score > bestA && score >= 0.12) {
        bestA = score;
        bestAc = `${a.id}: ${a.description}`;
      }
    }
    return {
      ...it,
      relatedGap: bestGap,
      relatedAC: bestAc,
    };
  });
}

function buildPatterns(items: FeedbackItem[]): FeedbackAgentOutput["patterns"] {
  const buckets = new Map<string, FeedbackItem[]>();
  for (const it of items) {
    const words = tokenize(it.summary);
    const key = (words[0] ?? "general") + ":" + (words[1] ?? "issue");
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(it);
  }

  const patterns: FeedbackAgentOutput["patterns"] = [];
  for (const [theme, group] of buckets) {
    if (group.length < 2) continue;
    const hasCrash = group.some((g) => g.type === "crash");
    const bugN = group.filter((g) => g.type === "bug" || g.type === "crash").length;
    const severity: FeedbackAgentOutput["patterns"][number]["severity"] = hasCrash
      ? "critical"
      : bugN >= 2
        ? "important"
        : "minor";
    const readable = theme.replace(":", " — ");
    patterns.push({
      theme: readable,
      count: group.length,
      severity,
      suggestedAction:
        hasCrash || bugN > 0
          ? `Triage and reproduce the "${readable}" cluster; add tests and fix root cause before next release.`
          : `Review UX around "${readable}"; validate with a quick design pass or copy update.`,
    });
  }

  patterns.sort((a, b) => b.count - a.count);
  return patterns.slice(0, 20);
}

function buildNextHints(
  items: FeedbackItem[],
  gaps: Array<{ area: string; description: string }>,
): FeedbackAgentOutput["nextPipelineHints"] {
  const prioritizeGaps: string[] = [];
  for (const g of gaps) {
    const hit = items.some((it) => {
      if (!it.relatedGap || it.relatedGap !== g.description) return false;
      return it.type === "bug" || it.type === "crash" || it.type === "complaint";
    });
    if (hit) prioritizeGaps.push(`[${g.area}] ${g.description}`);
  }

  const noisyAreas = new Set<string>();
  for (const g of gaps) {
    const hit = items.some(
      (it) =>
        it.relatedGap === g.description &&
        (it.type === "bug" || it.type === "crash" || it.type === "complaint"),
    );
    if (hit) noisyAreas.add(g.area);
  }
  const allAreas = new Set(gaps.map((g) => g.area));
  const skipAreas = [...allAreas].filter((a) => !noisyAreas.has(a));

  const newFeatureRequests = items
    .filter((i) => i.type === "feature_request")
    .map((i) => i.summary.slice(0, 300));

  return {
    prioritizeGaps: [...new Set(prioritizeGaps)].slice(0, 25),
    skipAreas: skipAreas.slice(0, 12),
    newFeatureRequests: [...new Set(newFeatureRequests)].slice(0, 25),
  };
}

function computeTrends(
  items: FeedbackItem[],
  prior: FeedbackAgentOutput | undefined,
): FeedbackAgentOutput["trends"] {
  const bugCount = items.filter((i) => i.type === "bug" || i.type === "crash").length;
  const featureRequestCount = items.filter((i) => i.type === "feature_request").length;
  const totalFeedback = items.length;

  if (!prior) {
    return {
      totalFeedback,
      bugCount,
      featureRequestCount,
      previousRunBugCount: null,
      trend: "no_prior_data",
    };
  }

  const previousRunBugCount = prior.trends.bugCount;
  let trend: FeedbackAgentOutput["trends"]["trend"] = "stable";
  if (bugCount < previousRunBugCount) trend = "improving";
  else if (bugCount > previousRunBugCount) trend = "worsening";

  return {
    totalFeedback,
    bugCount,
    featureRequestCount,
    previousRunBugCount,
    trend,
  };
}

function buildReadme(output: FeedbackAgentOutput, projectName: string): string {
  const lines: string[] = [
    `# Feedback summary — ${projectName}`,
    "",
    `_Collected ${output.collectedAt}_`,
    "",
    `Ledger: \`${output.ledgerPath}\``,
    "",
    "## Sources",
    ...output.sources.map((s) => `- **${s.name}**: ${s.available ? `${s.itemCount} item(s)` : "unavailable"}`),
    "",
    "## Ledger summary",
    `- Total tracked items: **${output.ledgerSummary.totalItems}**`,
    `- Open items: **${output.ledgerSummary.openItems}**`,
    `- Marked \`shouldImplement: true\`: **${output.ledgerSummary.implementNowItems}**`,
    `- Resolved: **${output.ledgerSummary.resolvedItems}**`,
    `- Ignored: **${output.ledgerSummary.ignoredItems}**`,
    "",
    "## Highlights",
    `- Total items: **${output.trends.totalFeedback}** (bugs/crashes: **${output.trends.bugCount}**, feature requests: **${output.trends.featureRequestCount}**)`,
    `- Trend vs last run: **${output.trends.trend}**${
      output.trends.previousRunBugCount !== null
        ? ` (previous bug/crash count: ${output.trends.previousRunBugCount})`
        : ""
    }`,
    "",
    "## Top patterns",
  ];
  if (output.patterns.length === 0) {
    lines.push("_No repeated themes detected (need at least two similar items)._");
  } else {
    for (const p of output.patterns.slice(0, 10)) {
      lines.push(`- **${p.theme}** (${p.count}×, ${p.severity}): ${p.suggestedAction}`);
    }
  }
  lines.push("", "## Suggestions for the next run");
  if (output.suggestions.length === 0) lines.push("_None._");
  else for (const s of output.suggestions) lines.push(`- ${s}`);

  lines.push("", "## Actionable queue");
  const actionable = output.items.filter((it) => it.shouldImplement);
  if (actionable.length === 0) {
    lines.push("_No open ledger items are currently marked for implementation._");
  } else {
    for (const it of actionable.slice(0, 20)) {
      lines.push(`- [${it.type}/${it.priority}] ${it.summary.slice(0, 200)}${it.summary.length > 200 ? "…" : ""}`);
    }
  }

  lines.push("", "## Ledger workflow");
  lines.push("- Edit the ledger file to control feedback lifecycle.");
  lines.push("- Set `status` to `resolved` or `ignored` to remove an item from the active queue.");
  lines.push("- Set `shouldImplement` to `true` only for open items that should drive implementation work.");

  lines.push("", "## Pipeline hints");
  lines.push("### Prioritize gaps");
  if (output.nextPipelineHints.prioritizeGaps.length === 0) lines.push("_None._");
  else for (const g of output.nextPipelineHints.prioritizeGaps) lines.push(`- ${g}`);
  lines.push("", "### Skip or defer areas (low negative signal)");
  if (output.nextPipelineHints.skipAreas.length === 0) lines.push("_None._");
  else for (const a of output.nextPipelineHints.skipAreas) lines.push(`- ${a}`);
  lines.push("", "### New feature requests");
  if (output.nextPipelineHints.newFeatureRequests.length === 0) lines.push("_None._");
  else for (const f of output.nextPipelineHints.newFeatureRequests) lines.push(`- ${f}`);

  lines.push("", "## Sample items");
  for (const it of output.items.slice(0, 15)) {
    lines.push(
      `- [${it.type}/${it.priority}] [${it.status}] implement=${it.shouldImplement ? "yes" : "no"} ${it.summary.slice(0, 200)}${it.summary.length > 200 ? "…" : ""}`,
    );
  }
  if (output.items.length > 15) lines.push(`_…and ${output.items.length - 15} more._`);

  return lines.join("\n");
}

export const feedbackAgentStage: Stage<StageInputComposition, FeedbackAgentOutput> = {
  name: "feedback_agent",
  description:
    "Aggregate external feedback into a durable ledger; emit only open ledger items and implementation hints for the next run.",
  inputSchema: StageInputCompositionSchema,
  outputSchema: FeedbackAgentOutputSchema,
  async run(ctx, input) {
    const projectName = input.config.project.project_name;
    ctx.logger("[feedback_agent] collecting feedback", { project: projectName });

    const audit = CurrentStateAuditOutputSchema.safeParse(input.currentStateAudit);
    const gaps = audit.success ? audit.data.gaps : [];

    const pd = ProductDefinitionOutputSchema.safeParse(input.productDefinition);
    const acs = pd.success ? pd.data.acceptanceCriteria : [];

    const supa = await collectSupabase(ctx);
    const manual = await collectManualFeedback(ctx.repoPath);
    const crashItems = await collectCrashLogs(ctx.repoPath, ctx);
    const foundryLogs = await collectFoundryLogs(ctx.repoPath, ctx);

    let items: RawFeedbackItem[] = [...supa.items, ...manual, ...crashItems, ...foundryLogs];

    const seen = new Set<string>();
    items = items.filter((it) => {
      const k = `${it.type}|${it.summary.slice(0, 160)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    items = crossReference(items, gaps, acs);

    const collectedAt = new Date().toISOString();
    const ownerEmails = resolveFeedbackOwnerEmails(input.config.project.foundry);
    const ledger = mergeLedger(await readFeedbackLedger(ctx.repoPath), items, collectedAt, ownerEmails);
    await writeFeedbackLedger(ctx.repoPath, ledger);

    const activeItems = sortFeedbackItems(ledger.items.filter((it) => it.status === "open"));
    const actionableItems = activeItems.filter((it) => it.shouldImplement);

    const patterns = buildPatterns(actionableItems);

    const suggestions: string[] = [];
    for (const p of patterns.slice(0, 8)) {
      if (p.severity === "critical" || p.severity === "important") {
        suggestions.push(`Address recurring theme "${p.theme}" (${p.count} reports): ${p.suggestedAction}`);
      }
    }
    for (const it of actionableItems) {
      if (it.priority === "high" && (it.type === "bug" || it.type === "crash")) {
        suggestions.push(`Immediate attention: ${it.summary.slice(0, 200)}`);
      }
    }
    const deduped = [...new Set(suggestions)].slice(0, 25);

    const prior = await readPriorFeedbackOutput(ctx.repoPath, ctx.runId);
    const trends = computeTrends(activeItems, prior);
    const nextPipelineHints = buildNextHints(actionableItems, gaps);

    const sources: FeedbackAgentOutput["sources"] = [
      { name: "supabase", itemCount: supa.items.length, available: supa.available },
      { name: "manual_files", itemCount: manual.length, available: true },
      { name: "crash_logs", itemCount: crashItems.length, available: true },
      { name: "foundry_logs", itemCount: foundryLogs.length, available: true },
      { name: "ledger", itemCount: ledger.items.length, available: true },
    ];

    const output: FeedbackAgentOutput = {
      collectedAt,
      ledgerPath: feedbackLedgerPath(ctx.repoPath),
      ledgerSummary: {
        totalItems: ledger.items.length,
        openItems: ledger.items.filter((it) => it.status === "open").length,
        implementNowItems: ledger.items.filter((it) => it.status === "open" && it.shouldImplement).length,
        resolvedItems: ledger.items.filter((it) => it.status === "resolved").length,
        ignoredItems: ledger.items.filter((it) => it.status === "ignored").length,
      },
      sources,
      items: activeItems,
      patterns,
      suggestions: deduped,
      trends,
      nextPipelineHints,
    };

    await writeStageMarkdown(ctx, "feedback_agent", "README.md", buildReadme(output, projectName));

    return FeedbackAgentOutputSchema.parse(output);
  },
};
