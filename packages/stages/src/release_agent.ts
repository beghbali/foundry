import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { writeStageMarkdown } from "@foundry/core/artifacts";
import { stripBriefIdComment } from "@foundry/core/briefIntent";
import { StageInputCompositionSchema, type StageInputComposition } from "@foundry/core/stageInputs";
import type { RunContext, Stage } from "@foundry/core/types";
import { z } from "zod";

import { sh } from "./_shared/exec.js";
import { BuilderOutputSchema } from "./builder.js";
import { IndependentQaOutputSchema } from "./independent_qa.js";
import { RepoInventoryOutputSchema } from "./repo_inventory.js";

const ReleaseChecklistItemSchema = z.object({
  item: z.string(),
  status: z.enum(["done", "pending", "blocked", "deferred", "interactive"]),
  notes: z.string().optional(),
});

const ReleaseNotesSchema = z.object({
  headline: z.string(),
  bullets: z.array(z.string()),
});

export const ReleaseAgentOutputSchema = z.object({
  status: z.enum([
    "approved",
    "awaiting_approval",
    "auto_approved",
    "blocked_by_qa",
    /** QA recommends ship but brief/builder (or other pre-approval) gates are not satisfied. */
    "blocked_pre_release",
  ]),
  qaScore: z.number(),
  qaRecommendation: z.string(),
  gatesChecked: z.array(z.string()),
  manualApprovalRequired: z.boolean(),
  approvalFile: z.string(),
  releaseChecklist: z.array(ReleaseChecklistItemSchema),
  version: z.string().optional(),
  easAvailable: z.boolean(),
  manualSteps: z.array(z.string()),
  releaseNotes: ReleaseNotesSchema,
  notes: z.array(z.string()),
  /** Human-readable open `- [ ]` lines (tracked sections); mirrors `.foundry/OPEN_TRACKED_BRIEF.md`. */
  openTrackedBriefLines: z.array(z.string()),
});

export type ReleaseAgentOutput = z.infer<typeof ReleaseAgentOutputSchema>;

type BriefTrackedSummary = {
  openTrackedItems: number;
  briefPath: string;
  /** Lines like `[Must ship] …` for console and OPEN_TRACKED_BRIEF.md */
  openTrackedLines: string[];
};

function labelForBriefSection(section: "must" | "should" | "gaps" | "monetization" | "edge" | "runtime"): string {
  switch (section) {
    case "must":
      return "Must ship";
    case "should":
      return "Should ship";
    case "gaps":
      return "Gaps";
    case "monetization":
      return "Monetization";
    case "edge":
      return "Edge";
    case "runtime":
      return "Runtime first";
    default:
      return section;
  }
}

async function scanOpenTrackedBriefItems(repoPath: string): Promise<BriefTrackedSummary> {
  const briefPath = join(repoPath, ".foundry", "CURSOR_BRIEF.md");

  // Source of truth: BUILD_SPEC + BUILD_SPEC_LEDGER. The brief markdown's
  // checkboxes don't survive cycle regenerations, so the release gate now
  // looks at the wizard spec — a task is "open" iff it isn't in the ledger.
  try {
    const [specRaw, ledgerRaw] = await Promise.all([
      readFile(join(repoPath, ".foundry", "BUILD_SPEC.json"), "utf8"),
      readFile(join(repoPath, ".foundry", "BUILD_SPEC_LEDGER.json"), "utf8").catch(() => ""),
    ]);
    type SpecShape = { slices?: Array<{ tasks?: Array<{ id?: string; task?: string }> }> };
    type LedgerShape = { tasks?: Record<string, unknown> };
    const spec = JSON.parse(specRaw) as SpecShape;
    const ledger = ledgerRaw ? (JSON.parse(ledgerRaw) as LedgerShape) : { tasks: {} };
    const tasks = spec.slices?.[0]?.tasks ?? [];
    const closed = ledger.tasks ?? {};
    const open = tasks.filter((t) => !t.id || !(t.id in closed));
    const openTrackedLines = open.slice(0, 40).map((t) => {
      const text = (t.task ?? "").replace(/\s+/g, " ").trim();
      const truncated = text.length > 280 ? `${text.slice(0, 279)}…` : text;
      return `[BUILD_SPEC ${t.id ?? "?"}] ${truncated}`;
    });
    return { openTrackedItems: open.length, briefPath, openTrackedLines };
  } catch {
    /* fall through to legacy brief markdown scan when no spec exists */
  }

  let raw = "";
  try {
    raw = await readFile(briefPath, "utf8");
  } catch {
    return { openTrackedItems: 0, briefPath, openTrackedLines: [] };
  }

  let openTrackedItems = 0;
  const openTrackedLines: string[] = [];
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
    const itemText = stripBriefIdComment(trimmed.replace(/^- \[ \]\s*/, "").trim());
    if (!itemText) continue;
    openTrackedItems++;
    if (openTrackedLines.length < 40) {
      const oneLine = itemText.replace(/\s+/g, " ").trim();
      const truncated = oneLine.length > 280 ? `${oneLine.slice(0, 279)}…` : oneLine;
      openTrackedLines.push(`[${labelForBriefSection(section)}] ${truncated}`);
    }
  }
  return { openTrackedItems, briefPath, openTrackedLines };
}

async function writeOpenTrackedBriefMirror(repoPath: string, summary: BriefTrackedSummary): Promise<void> {
  const outPath = join(repoPath, ".foundry", "OPEN_TRACKED_BRIEF.md");
  await mkdir(dirname(outPath), { recursive: true });
  const lines: string[] = [
    "# Open tracked checklist items (`- [ ]` in CURSOR_BRIEF.md)",
    "",
    "These lines are unchecked boxes under **tracked** sections (Must ship, Should ship, Gaps, Monetization, Edge, Runtime first).",
    "Release needs them addressed after **independent_qa** is ship with zero blockers.",
    "",
    `**Edit the source file:** \`${summary.briefPath}\` (check off \`- [x]\` there).`,
    "",
    `**Open count:** ${summary.openTrackedItems}`,
    "",
  ];
  if (summary.openTrackedLines.length === 0) {
    lines.push("_None — every tracked checklist line is checked._", "");
  } else {
    lines.push("## List (same order as scanned top-to-bottom)", "");
    if (summary.openTrackedItems > summary.openTrackedLines.length) {
      lines.push(
        `_Showing first ${summary.openTrackedLines.length} of ${summary.openTrackedItems} — open \`${summary.briefPath}\` for the full list._`,
        "",
      );
    }
    for (const L of summary.openTrackedLines) lines.push(`- ${L}`);
    lines.push("");
  }
  lines.push("---", "", "_Regenerated by Foundry `release_agent` each run — do not hand-edit for long-term notes._", "");
  await writeFile(outPath, lines.join("\n"), "utf8");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function isReleaseAgentGate(gate: string): boolean {
  return gate.startsWith("release_agent.");
}

function releaseAgentGatesFromConfig(requireHumanApproval: string[]): string[] {
  return requireHumanApproval.filter(isReleaseAgentGate);
}


async function readVersionFromConfigFile(abs: string): Promise<string | undefined> {
  const base = abs.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (base === "app.json" || base === "app.config.json") {
    try {
      const raw = await readFile(abs, "utf8");
      const j = JSON.parse(raw) as { expo?: { version?: string }; version?: string };
      const v = j.expo?.version ?? j.version;
      if (typeof v === "string" && v.trim()) return v.trim();
    } catch {
      return undefined;
    }
  }
  if (base === "app.config.ts" || base === "app.config.js" || base === "app.config.mjs" || base === "app.config.cjs") {
    try {
      const raw = await readFile(abs, "utf8");
      const m =
        raw.match(/version\s*:\s*['"]([^'"]+)['"]/) ??
        raw.match(/"version"\s*:\s*"([^"]+)"/) ??
        raw.match(/'version'\s*:\s*'([^']+)'/);
      if (m?.[1]) return m[1].trim();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function readExpoVersion(repoPath: string, input: StageInputComposition): Promise<string | undefined> {
  const candidates: string[] = [];
  const inv = RepoInventoryOutputSchema.safeParse(input.repoInventory);
  if (inv.success) {
    for (const p of inv.data.keyFiles.expoConfigPaths) {
      candidates.push(join(repoPath, p));
    }
  }
  candidates.push(
    join(repoPath, "app.json"),
    join(repoPath, "app.config.json"),
    join(repoPath, "app.config.ts"),
    join(repoPath, "app.config.js"),
    join(repoPath, "app.config.mjs"),
    join(repoPath, "app.config.cjs"),
  );

  const seen = new Set<string>();
  for (const abs of candidates) {
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (!(await fileExists(abs))) continue;
    const v = await readVersionFromConfigFile(abs);
    if (v) return v;
  }

  return undefined;
}

function isExpoProject(input: StageInputComposition): boolean {
  const configuredRepoType = input.config.project.repo_type.toLowerCase();
  if (/^(web_data_platform|web_app|node|python|enterprise)/i.test(configuredRepoType)) return false;
  const inv = RepoInventoryOutputSchema.safeParse(input.repoInventory);
  if (inv.success) {
    return inv.data.summary.hasExpo || inv.data.summary.repoTypeGuess === "expo_rn";
  }
  return false;
}

async function checkEasAvailable(repoPath: string): Promise<boolean> {
  const r = await sh("eas --version", repoPath, 15_000);
  return r.exitCode === 0;
}

async function computeApprovalToken(
  repoPath: string,
  builder: z.infer<typeof BuilderOutputSchema> | undefined,
  qa: z.infer<typeof IndependentQaOutputSchema> | undefined,
  version: string | undefined,
): Promise<string> {
  const head = await sh("git rev-parse HEAD", repoPath, 10_000);
  const status = await sh("git status --porcelain=1", repoPath, 10_000);
  const blob = [
    `head=${head.stdout.trim()}`,
    `status=${status.stdout.trim()}`,
    `builder_commit=${builder?.commit?.sha ?? ""}`,
    `builder_files_created=${builder?.changes.filesCreated.join(",") ?? ""}`,
    `builder_files_modified=${builder?.changes.filesModified.join(",") ?? ""}`,
    `qa_score=${qa?.score ?? 0}`,
    `qa_recommendation=${qa?.recommendation ?? "unknown"}`,
    `version=${version ?? ""}`,
  ].join("\n");
  return createHash("sha256").update(blob).digest("hex").slice(0, 16);
}

function approvalFileRelative(approvalToken: string): string {
  return `.foundry/approvals/${approvalToken}.approved`;
}

function humanizeReleaseItem(text: string): string {
  const lower = text.toLowerCase();
  if (/upsell|trial|premium|paywall|price/.test(lower)) {
    return "Refined premium upgrade messaging and purchase flow clarity.";
  }
  if (/shake|feedback/.test(lower)) {
    return "Improved in-app feedback capture and reporting reliability.";
  }
  if (/task|this week|weekly|done|undone|why and how|formatted|list/.test(lower)) {
    return "Polished weekly plan interactions and content readability.";
  }
  if (/auth|login|sign in|onboarding/.test(lower)) {
    return "Improved onboarding and sign-in flow reliability.";
  }
  if (/offline|network/.test(lower)) {
    return "Improved offline handling and network resilience.";
  }
  if (/rate limit|api/.test(lower)) {
    return "Strengthened backend request handling and reliability.";
  }
  if (/error boundary|crash|stability|reliability/.test(lower)) {
    return "Fixed stability issues and improved overall reliability.";
  }
  return text
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/^Fix gap:\s*/i, "")
    .replace(/\.$/, "")
    .replace(/^./, (c) => c.toUpperCase()) + ".";
}

function buildReleaseNotes(
  projectName: string,
  builder: z.infer<typeof BuilderOutputSchema> | undefined,
): z.infer<typeof ReleaseNotesSchema> {
  const candidates = [
    ...(builder?.plan.feedbackAddressed ?? []),
    ...(builder?.plan.gapsAddressed ?? []),
  ];
  const bullets = [...new Set(candidates.map(humanizeReleaseItem))].slice(0, 4);
  if (bullets.length === 0) {
    bullets.push(
      `Performance and polish improvements across ${projectName}.`,
      "Minor reliability improvements and bug fixes.",
      "General UX refinements for a smoother experience.",
    );
  }
  return {
    headline: `${projectName} update`,
    bullets,
  };
}

function buildManualReleaseSteps(
  repoPath: string,
  approvalRel: string,
  easAvailable: boolean,
  version: string | undefined,
): string[] {
  return [
    `Approve the release snapshot: mkdir -p ${join(repoPath, ".foundry", "approvals")} && touch ${join(repoPath, approvalRel)}`,
    "When Foundry prompts after approval, choose whether to spend an EAS build and/or submit to TestFlight.",
    easAvailable
      ? "Verify EAS auth is still valid (`eas whoami`) if you plan to build or submit."
      : "Install and authenticate EAS CLI (`npm install -g eas-cli`, then `eas login`).",
    version
      ? `Review the iOS version/build metadata before submission (current version: ${version}).`
      : "Review the iOS version/build metadata before submission.",
    "If submitting to TestFlight, confirm App Store Connect has the app record for this bundle identifier and that EAS submit auth is available.",
    "After TestFlight submission starts, finish the human steps in App Store Connect: wait for processing, review the build, add testers/internal groups, and send release notes.",
  ];
}

async function writeApprovalRequiredMd(
  repoPath: string,
  approvalToken: string,
  runId: string,
  projectName: string,
  builder: z.infer<typeof BuilderOutputSchema> | undefined,
  qa: z.infer<typeof IndependentQaOutputSchema> | undefined,
  version: string | undefined,
  easPlan?: { enabled: boolean; profile?: string; platform?: string },
  manualSteps?: string[],
  releaseNotes?: z.infer<typeof ReleaseNotesSchema>,
): Promise<void> {
  const rel = approvalFileRelative(approvalToken);
  await mkdir(join(repoPath, ".foundry", "approvals"), { recursive: true });

  const lines: string[] = [
    `# Release Ready: ${projectName}`,
    "",
    `**Version:** ${version ?? "not detected"}`,
    `**QA Score:** ${qa?.score ?? "?"}/100`,
    `**Tests:** ${qa?.testsRan ? (qa.testsPassed ? "all passing" : "FAILING") : "not run"}`,
    `**Run:** \`${runId}\``,
    `**Approval token:** \`${approvalToken}\``,
    "",
    "---",
    "",
  ];

  // Changes summary
  if (builder) {
    const created = [...new Set(builder.changes.filesCreated)];
    const modified = [...new Set(builder.changes.filesModified)];
    const total = created.length + modified.length;

    lines.push("## Changes", "");
    if (total === 0) {
      lines.push("No file changes in this run.", "");
    } else {
      if (created.length > 0) {
        lines.push(`**${created.length} file(s) created:**`);
        for (const f of created) lines.push(`- \`${f}\``);
        lines.push("");
      }
      if (modified.length > 0) {
        lines.push(`**${modified.length} file(s) modified:**`);
        for (const f of modified) lines.push(`- \`${f}\``);
        lines.push("");
      }
    }

    if (builder.plan.gapsAddressed.length > 0) {
      lines.push("## Gaps Fixed", "");
      for (const g of builder.plan.gapsAddressed) lines.push(`- ${g}`);
      lines.push("");
    }

    if (builder.commit) {
      lines.push("## Commit", "");
      lines.push(`\`${builder.commit.sha.slice(0, 7)}\` — ${builder.commit.message}`, "");
    }
  }

  // Impact
  lines.push("## Impact", "");
  lines.push("- All automated tests passing");
  if (qa?.autoFixable && qa.autoFixable.length > 0) {
    lines.push(`- ${qa.autoFixable.length} auto-fixable issue(s) were handled by the builder`);
  }
  if (qa?.warnings && qa.warnings.length > 0) {
    lines.push(`- ${qa.warnings.length} non-blocking warning(s) noted`);
  }
  lines.push(
    "- Optional Cursor session notes: `.foundry/CURSOR_BUILDER_REPORT.md` and `.foundry/CURSOR_QA_REPORT.md` (ship decision is from `independent_qa` only)",
  );
  if (easPlan?.enabled) {
    lines.push("- After approval, Foundry will merge the latest builder branch into `main` and push `main` to `origin`");
    lines.push(`- After branch promotion, Foundry will ask whether to run \`eas build --platform ${easPlan.platform ?? "ios"} --profile ${easPlan.profile ?? "preview"}\``);
    lines.push("- Foundry will also ask whether to submit an iOS build to TestFlight");
  }
  lines.push("");

  if (releaseNotes) {
    lines.push("## App Store Release Notes", "");
    lines.push(releaseNotes.headline, "");
    for (const bullet of releaseNotes.bullets) lines.push(`- ${bullet}`);
    lines.push("");
  }

  if (manualSteps?.length) {
    lines.push("## Manual Steps To Finish TestFlight", "");
    for (const step of manualSteps) lines.push(`- ${step}`);
    lines.push("");
  }

  // Approve
  lines.push(
    "## Approve",
    "",
    "```bash",
    `mkdir -p .foundry/approvals && touch ${rel}`,
    "```",
    "",
    "This approval is tied to the current release snapshot, so it remains valid across loop cycles until the code changes.",
    "",
  );

  await writeFile(join(repoPath, ".foundry", "APPROVAL_REQUIRED.md"), lines.join("\n"), "utf8");
}

function buildReadmeMarkdown(projectName: string, out: ReleaseAgentOutput): string {
  const statusLine =
    out.status === "approved"
      ? "Manual approval on file — proceeding."
      : out.status === "awaiting_approval"
        ? "Waiting for `.foundry/approvals/<runId>.approved`."
        : out.status === "auto_approved"
          ? "No manual gates configured for `release_agent.*`."
          : out.status === "blocked_pre_release"
            ? "QA recommends ship; finish brief/builder/checklist gates before approval (not a QA failure)."
            : out.status === "blocked_by_qa"
              ? "Release blocked — independent_qa did not certify ship; see checklist + notes."
              : "Release is blocked; see checklist + notes.";

  const lines: string[] = [
    `# Release agent — ${projectName}`,
    "",
    `**Status:** \`${out.status}\``,
    "",
    statusLine,
    "",
    `**QA score:** ${out.qaScore}/100 · **Recommendation:** \`${out.qaRecommendation}\``,
    "",
    `**Manual approval required:** ${out.manualApprovalRequired ? "yes" : "no"}`,
    "",
    `**Approval file:** \`${out.approvalFile}\``,
    "",
    `**EAS CLI available:** ${out.easAvailable ? "yes" : "no"}`,
    "",
    out.version ? `**App version (config):** \`${out.version}\`` : "**App version:** _not detected_",
    "",
    "## Gates checked",
    "",
    out.gatesChecked.length ? out.gatesChecked.map((g) => `- \`${g}\``).join("\n") : "_None matching `release_agent.*`._",
    "",
    "## Release checklist",
    "",
    "| Item | Status | Notes |",
    "|------|--------|-------|",
    ...out.releaseChecklist.map((c) => {
      const n = c.notes ? c.notes.replace(/\|/g, "\\|") : "";
      return `| ${c.item.replace(/\|/g, "\\|")} | ${c.status} | ${n} |`;
    }),
    "",
    "## Open tracked CURSOR_BRIEF checklist (`- [ ]`)",
    "",
    out.openTrackedBriefLines.length
      ? out.openTrackedBriefLines.map((l) => `- ${l.replace(/\|/g, "\\|")}`).join("\n")
      : "_None — all tracked checklist items are checked._",
    "",
    "See also `.foundry/OPEN_TRACKED_BRIEF.md` (regenerated each run).",
    "",
    "## Notes",
    "",
    out.notes.length ? out.notes.map((n) => `- ${n}`).join("\n") : "_None._",
    "",
    "## Manual steps",
    "",
    out.manualSteps.length ? out.manualSteps.map((step) => `- ${step}`).join("\n") : "_None._",
    "",
    "## App Store release notes",
    "",
    out.releaseNotes.headline,
    "",
    ...out.releaseNotes.bullets.map((bullet) => `- ${bullet}`),
    "",
    "---",
    "",
    "_Generated by Foundry `release_agent` stage._",
  ];
  return lines.join("\n");
}

export const releaseAgentStage: Stage<StageInputComposition, ReleaseAgentOutput> = {
  name: "release_agent",
  description:
    "Prepare a release after independent QA: checklist, manual approval gate, EAS/version checks, and repo markers.",
  inputSchema: StageInputCompositionSchema,
  outputSchema: ReleaseAgentOutputSchema,
  async run(ctx: RunContext, input: StageInputComposition): Promise<ReleaseAgentOutput> {
    const repoPath = ctx.repoPath;
    const runId = ctx.runId;
    const projectName = input.config.project.project_name;
    ctx.logger("[release_agent] starting", { project: projectName, repoPath, runId });

    const notes: string[] = [];
    const gatesChecked = releaseAgentGatesFromConfig(input.config.gates.require_human_approval);
    const manualApprovalRequired = gatesChecked.length > 0;

    const qaParsed = IndependentQaOutputSchema.safeParse(input.independentQa);
    const qa: z.infer<typeof IndependentQaOutputSchema> | undefined = qaParsed.success ? qaParsed.data : undefined;

    if (!qaParsed.success) {
      notes.push("independent_qa output missing or invalid — treating as not releasable.");
    }

    const qaScore = qa?.score ?? 0;
    const qaRecommendation = qa?.recommendation ?? "unknown";
    const builderParsed = BuilderOutputSchema.safeParse(input.builder);
    const builder = builderParsed.success ? builderParsed.data : undefined;
    const builderReady = builder?.status === "ok" || builder?.status === "partial";
    const qaCertified = Boolean(qa && qa.recommendation === "ship");
    const briefSummary = await scanOpenTrackedBriefItems(repoPath);
    await writeOpenTrackedBriefMirror(repoPath, briefSummary);
    const briefReady = briefSummary.openTrackedItems === 0;
    const qaBlockers = qa?.blockers ?? [];
    /** Ship recommendation with zero pipeline QA blockers (tests, Maestro, etc.). */
    const qaCleanForShip = qaCertified && qaBlockers.length === 0;
    // Release is gated on clean QA + builder readiness + tracked brief completion.
    const releasable = Boolean(qaCleanForShip && builderReady && briefReady);

    const expo = isExpoProject(input);
    const easAvailable = expo ? await checkEasAvailable(repoPath) : false;
    if (expo && !easAvailable) {
      notes.push("Expo project detected but `eas --version` did not succeed — install EAS CLI for store builds.");
    } else if (!expo) {
      notes.push("EAS CLI check skipped — not detected as an Expo project.");
    }

    const version = await readExpoVersion(repoPath, input);
    if (expo && !version) {
      notes.push("Could not read app version from app.json / app.config — verify Expo config paths.");
    }

    const approvalToken = await computeApprovalToken(repoPath, builder, qa, version);
    const approvalRel = approvalFileRelative(approvalToken);
    const approvalAbs = join(repoPath, ".foundry", "approvals", `${approvalToken}.approved`);
    const approvalOnDisk = await fileExists(approvalAbs);
    const releaseNotes = buildReleaseNotes(projectName, builder);
    const manualSteps = buildManualReleaseSteps(repoPath, approvalRel, easAvailable, version);

    const releaseChecklist: ReleaseAgentOutput["releaseChecklist"] = [];

    releaseChecklist.push({
      item: "Independent QA recommends shipping",
      status: qaCleanForShip ? "done" : "blocked",
      notes: qa
        ? `recommendation=${qa.recommendation}, score=${qa.score}${qaBlockers.length ? ` · ${qaBlockers.length} blocker(s)` : ""}`
        : "QA artifact missing",
    });
    releaseChecklist.push({
      item: "Builder stage is ready for promotion",
      status: builderReady ? "done" : "blocked",
      notes: builder ? `builder_status=${builder.status}` : "Builder output unavailable",
    });
    releaseChecklist.push({
      item: "Tracked CURSOR_BRIEF items are complete",
      status: briefReady ? "done" : !qaCleanForShip ? "deferred" : "blocked",
      notes: briefReady
        ? "No tracked open items remaining"
        : !qaCleanForShip
          ? `${briefSummary.openTrackedItems} open in ${briefSummary.briefPath} — gate after QA is ship + 0 blockers. Exact lines: .foundry/OPEN_TRACKED_BRIEF.md and ship gate below.`
          : `${briefSummary.openTrackedItems} open in ${briefSummary.briefPath} — see .foundry/OPEN_TRACKED_BRIEF.md and ship gate listing.`,
    });

    if (builderParsed.success) {
      const b = builderParsed.data;
      const needsBump =
        b.status === "ok" &&
        (b.changes.filesCreated.length > 0 || b.changes.filesModified.length > 0);
      releaseChecklist.push({
        item: "Review version bump for store submission",
        status: needsBump ? "pending" : "done",
        notes: version ? `current: ${version}` : "version not detected in Expo config",
      });
      releaseChecklist.push({
        item: "Promote builder branch into main and push origin/main",
        status: !qaCleanForShip
          ? "deferred"
          : builderReady && briefReady
            ? "pending"
            : "blocked",
        notes: b.branchName
          ? !qaCleanForShip
            ? `${b.branchName} -> main -> origin/main — deferred until QA is ship with 0 blockers and brief is complete.`
            : `${b.branchName} -> main -> origin/main${!briefReady ? ` (blocked: ${briefSummary.openTrackedItems} brief item(s) still open)` : ""}`
          : "Builder branch metadata unavailable",
      });
      releaseChecklist.push({
        item: expo ? "Choose EAS build and/or TestFlight submission" : "Choose deployment action",
        status: !expo ? "done" : !qaCleanForShip || !releasable ? "deferred" : "interactive",
        notes:
          !expo
            ? "Not an Expo project — EAS/TestFlight release actions are disabled."
            : !qaCleanForShip || !releasable
            ? "Deferred until independent_qa has zero blockers and pre-release gates pass; then `foundry ship` / `foundry loop` prompt in your terminal for EAS/TestFlight and release approval."
            : "`foundry ship` / `foundry loop` prompt for EAS/TestFlight in this terminal, then ask for release approval; builds/submits run only after you approve and merge.",
      });
    } else {
      releaseChecklist.push({
        item: "Review version bump for store submission",
        status: "pending",
        notes: "Builder output unavailable",
      });
      releaseChecklist.push({
        item: "Promote builder branch into main and push origin/main",
        status: "pending",
        notes: "Builder output unavailable",
      });
      releaseChecklist.push({
        item: expo ? "Choose EAS build and/or TestFlight submission" : "Choose deployment action",
        status: !expo ? "done" : !qaCleanForShip || !releasable ? "deferred" : "interactive",
        notes:
          !expo
            ? "Not an Expo project — EAS/TestFlight release actions are disabled."
            : !qaCleanForShip || !releasable
            ? "Deferred until independent_qa has zero blockers and pre-release gates pass; then `foundry ship` / `foundry loop` prompt in your terminal for EAS/TestFlight and release approval."
            : "`foundry ship` / `foundry loop` prompt for EAS/TestFlight in this terminal, then ask for release approval; builds/submits run only after you approve and merge.",
      });
    }

    releaseChecklist.push({
      item: "Manual approval (release_agent gates)",
      status: !manualApprovalRequired ? "done" : approvalOnDisk ? "done" : "pending",
      notes: manualApprovalRequired
        ? gatesChecked.join(", ")
        : "No `release_agent.*` entries in gates.require_human_approval",
    });

    releaseChecklist.push({
      item: "EAS CLI available (Expo)",
      status: !expo ? "done" : easAvailable ? "done" : "pending",
      notes: expo ? undefined : "Not an Expo project — skipped",
    });

    let status: ReleaseAgentOutput["status"];

    if (!releasable) {
      if (!qaCleanForShip) {
        status = "blocked_by_qa";
        if (qa?.recommendation !== "ship") {
          notes.push(
            "independent_qa did not recommend ship — fix reported issues and re-run the pipeline. Optional Cursor agents may help implement fixes.",
          );
        } else if (qaBlockers.length > 0) {
          notes.push(
            `independent_qa recommends ship but lists ${qaBlockers.length} blocker(s) — clear them (e.g. Maestro, failing tests) before release.`,
          );
        }
        if (builder && !builderReady) {
          notes.push(
            `Builder status is "${builder.status}" — Foundry will not mark this release ready until the repo is clean enough for builder work or the builder completes successfully.`,
          );
        }
        if (!briefReady) {
          notes.push(
            `CURSOR_BRIEF has ${briefSummary.openTrackedItems} tracked open item(s) — finish after QA is ship with zero blockers, then close items in ${briefSummary.briefPath} for release.`,
          );
        }
      } else {
        status = "blocked_pre_release";
        notes.push(
          "QA is clean (ship + no blockers), but pre-release gates are still blocked (tracked brief, builder readiness, or checklist). Finish those before approval.",
        );
        if (builder && !builderReady) {
          notes.push(
            `Builder status is "${builder.status}" — Foundry will not mark this release ready until the repo is clean enough for builder work or the builder completes successfully.`,
          );
        }
        if (!briefReady) {
          notes.push(
            `CURSOR_BRIEF still has ${briefSummary.openTrackedItems} tracked open item(s) — complete/check off tracked items in ${briefSummary.briefPath} before release approval.`,
          );
        }
      }
    } else if (!manualApprovalRequired) {
      status = "auto_approved";
    } else if (approvalOnDisk) {
      status = "approved";
    } else {
      // QA has certified — NOW ask the human for release approval
      status = "awaiting_approval";
      await writeApprovalRequiredMd(repoPath, approvalToken, runId, projectName, builder, qa, version, {
        enabled: input.config.project.release_automation?.eas?.build_on_approval ?? false,
        profile: input.config.project.release_automation?.eas?.profile,
        platform: input.config.project.release_automation?.eas?.platform,
      }, manualSteps, releaseNotes);
      notes.push(`QA certified (score=${qaScore}). Awaiting manual approval: touch ${approvalRel}`);
    }

    const output: ReleaseAgentOutput = {
      status,
      qaScore,
      qaRecommendation,
      gatesChecked,
      manualApprovalRequired,
      approvalFile: approvalRel,
      releaseChecklist,
      version,
      easAvailable,
      manualSteps,
      releaseNotes,
      notes,
      openTrackedBriefLines: briefSummary.openTrackedLines,
    };

    const md = buildReadmeMarkdown(projectName, output);
    await writeStageMarkdown(ctx, "release_agent", "README.md", md);

    ctx.logger("[release_agent] done", { status, manualApprovalRequired, easAvailable, expo });
    return ReleaseAgentOutputSchema.parse(output);
  },
};
