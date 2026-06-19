import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { writeStageMarkdown } from "@foundry/core/artifacts";
import { StageInputCompositionSchema, type StageInputComposition } from "@foundry/core/stageInputs";
import type { RunContext, Stage } from "@foundry/core/types";
import { z } from "zod";

import { BuilderOutputSchema } from "./builder.js";
import { RepoInventoryOutputSchema } from "./repo_inventory.js";
import { sh } from "./_shared/exec.js";

const TEST_TIMEOUT_MS = 120_000;
const LINT_TIMEOUT_MS = 60_000;
const TYPECHECK_TIMEOUT_MS = 60_000;

const CONSOLE_SPAM_THRESHOLD = 20;
const TODO_SPAM_THRESHOLD = 10;
const LARGE_FILE_BYTES = 500 * 1024;

export const IndependentQaOutputSchema = z.object({
  score: z.number().min(0).max(100),
  testsRan: z.boolean(),
  testsPassed: z.boolean(),
  testSummary: z.string(),
  lintPassed: z.boolean(),
  lintErrors: z.number().int().min(0),
  typecheckPassed: z.boolean(),
  checks: z.array(
    z.object({
      name: z.string(),
      passed: z.boolean(),
      details: z.string(),
    }),
  ),
  blockers: z.array(z.string()),
  manualTasks: z.array(z.string()),
  screenshotArtifacts: z.array(z.string()),
  warnings: z.array(z.string()),
  autoFixable: z.array(z.string()),
  recommendation: z.enum(["ship", "fix_first", "blocked"]),
});

export type IndependentQaOutput = z.infer<typeof IndependentQaOutputSchema>;

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
type MaestroConfig = {
  enabled: boolean;
  required: boolean;
  command: string;
  flowPath: string;
  installIfMissing: boolean;
  /** Full shell command from repo root; bypasses `maestro test` construction when set. */
  pipelineCommand?: string;
  /** When true (default on darwin), boot an iOS Simulator automatically if none is running. */
  autoBootSimulator: boolean;
  /** Preferred simulator name (e.g. "iPhone 16 Pro"). Picks first available iPhone when unset. */
  preferredSimulator?: string;
  /** Max seconds to wait for the simulator to reach `Booted` state after boot. */
  bootTimeoutSeconds: number;
};

/**
 * Attempt to ensure at least one iOS Simulator is in the `Booted` state before
 * running Maestro. Returns a one-line status string for logging. Best-effort:
 * never throws, never blocks indefinitely, returns silently when `xcrun` isn't
 * available (non-macOS hosts) or when a sim is already booted.
 *
 * This addresses the "Maestro smoke did not run: no booted simulator/device"
 * warning that started appearing once we stopped manually booting sims. The
 * historic behavior of the loop depended on a long-lived booted sim; this
 * helper restores it without requiring operator setup.
 */
async function ensureBootedIosSimulator(
  repoPath: string,
  config: MaestroConfig,
): Promise<{ ok: boolean; note: string; bootedNow: boolean }> {
  if (process.platform !== "darwin") {
    return { ok: false, note: "skipped: not darwin", bootedNow: false };
  }
  const xcrun = await sh("command -v xcrun", repoPath, 5_000);
  if (xcrun.exitCode !== 0) {
    return { ok: false, note: "skipped: `xcrun` not on PATH", bootedNow: false };
  }

  const booted = await sh("xcrun simctl list devices booted --json", repoPath, 10_000);
  if (booted.exitCode === 0 && /"state"\s*:\s*"Booted"/.test(booted.stdout)) {
    return { ok: true, note: "already booted", bootedNow: false };
  }

  const list = await sh("xcrun simctl list devices available --json", repoPath, 15_000);
  if (list.exitCode !== 0) {
    return { ok: false, note: `xcrun simctl list failed: ${truncate(list.stderr || list.stdout, 160)}`, bootedNow: false };
  }

  type DeviceEntry = { udid?: string; name?: string; isAvailable?: boolean; state?: string };
  type DeviceList = { devices?: Record<string, DeviceEntry[]> };
  let parsed: DeviceList;
  try {
    parsed = JSON.parse(list.stdout) as DeviceList;
  } catch {
    return { ok: false, note: "could not parse `xcrun simctl list` output", bootedNow: false };
  }

  const candidates: Array<{ udid: string; name: string; runtime: string }> = [];
  for (const [runtime, entries] of Object.entries(parsed.devices ?? {})) {
    if (!runtime.toLowerCase().includes("ios")) continue;
    for (const entry of entries ?? []) {
      if (!entry.udid || !entry.name) continue;
      if (entry.isAvailable === false) continue;
      candidates.push({ udid: entry.udid, name: entry.name, runtime });
    }
  }
  if (candidates.length === 0) {
    return { ok: false, note: "no available iOS simulator (install one via Xcode)", bootedNow: false };
  }

  const preferred = config.preferredSimulator?.toLowerCase();
  candidates.sort((a, b) => {
    const aPref = preferred && a.name.toLowerCase().includes(preferred) ? -10 : 0;
    const bPref = preferred && b.name.toLowerCase().includes(preferred) ? -10 : 0;
    if (aPref !== bPref) return aPref - bPref;
    const aIphone = /^iPhone\b/.test(a.name) ? -5 : 0;
    const bIphone = /^iPhone\b/.test(b.name) ? -5 : 0;
    if (aIphone !== bIphone) return aIphone - bIphone;
    return b.runtime.localeCompare(a.runtime);
  });

  const target = candidates[0]!;
  const bootResult = await sh(`xcrun simctl boot ${quoteShell(target.udid)}`, repoPath, 60_000);
  if (bootResult.exitCode !== 0 && !/Booted/.test(bootResult.stderr + bootResult.stdout)) {
    return {
      ok: false,
      note: `boot \`${target.name}\` failed: ${truncate(bootResult.stderr || bootResult.stdout, 160)}`,
      bootedNow: false,
    };
  }

  const deadline = Date.now() + Math.max(30, config.bootTimeoutSeconds) * 1000;
  while (Date.now() < deadline) {
    const status = await sh(`xcrun simctl bootstatus ${quoteShell(target.udid)}`, repoPath, 30_000);
    if (status.exitCode === 0) break;
    await new Promise((r) => setTimeout(r, 1500));
  }

  await sh("open -a Simulator", repoPath, 10_000);

  return { ok: true, note: `booted ${target.name} (${target.udid.slice(0, 8)})`, bootedNow: true };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Slack for mtime comparison (clock skew, slow FS). */
const SCREENSHOT_SINCE_SLACK_MS = 10_000;
/** Maestro nests output under --debug-output when not flattened; stay shallow. */
const MAESTRO_DEBUG_MAX_DEPTH = 8;

async function collectImageFilesRecursive(
  dir: string,
  depth: number,
  out: Array<{ path: string; mtimeMs: number }>,
): Promise<void> {
  if (depth > MAESTRO_DEBUG_MAX_DEPTH) return;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const abs = join(dir, name);
    try {
      const st = await stat(abs);
      if (st.isDirectory()) {
        await collectImageFilesRecursive(abs, depth + 1, out);
        continue;
      }
      if (!st.isFile()) continue;
      if (!/\.(png|jpg|jpeg|webp)$/i.test(name)) continue;
      out.push({ path: abs, mtimeMs: st.mtimeMs });
    } catch {
      /* skip */
    }
  }
}

/**
 * Collect Maestro / QA screenshots written under `<repo>/.maestro-debug`.
 * Maestro's default is ~/.maestro/tests/... — we pass --debug-output here so artifacts are repo-local.
 * Only files modified at or after `sinceMs` (minus slack) are included so we never attach stale runs.
 */
async function collectQaScreenshots(repoPath: string, sinceMs: number): Promise<string[]> {
  const root = join(repoPath, ".maestro-debug");
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  await collectImageFilesRecursive(root, 0, candidates);
  const threshold = sinceMs - SCREENSHOT_SINCE_SLACK_MS;
  const fresh = candidates.filter((c) => c.mtimeMs >= threshold);
  fresh.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return fresh.slice(0, 12).map((c) => c.path);
}

async function detectPackageManager(repoPath: string): Promise<PackageManager> {
  const ordered: Array<[PackageManager, string]> = [
    ["bun", "bun.lockb"],
    ["pnpm", "pnpm-lock.yaml"],
    ["yarn", "yarn.lock"],
    ["npm", "package-lock.json"],
  ];
  for (const [pm, lock] of ordered) {
    if (await fileExists(join(repoPath, lock))) return pm;
  }
  return "npm";
}

function resolvePackageJsonPath(repoPath: string, input: StageInputComposition): string {
  const inv = RepoInventoryOutputSchema.safeParse(input.repoInventory);
  const rel = inv.success ? inv.data.keyFiles.packageJsonPaths[0] : undefined;
  if (rel) return join(repoPath, rel);
  return join(repoPath, "package.json");
}

async function readPackageScripts(packageJsonPath: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const j = JSON.parse(raw) as { scripts?: Record<string, string> };
    return j.scripts ?? {};
  } catch {
    return {};
  }
}

function testCommand(pm: PackageManager): string {
  switch (pm) {
    case "npm":
      return "npm test";
    case "pnpm":
      return "pnpm test";
    case "yarn":
      return "yarn test";
    case "bun":
      return "bun test";
  }
}

function runScriptCommand(pm: PackageManager, script: string): string {
  switch (pm) {
    case "npm":
      return `npm run ${script}`;
    case "pnpm":
      return `pnpm run ${script}`;
    case "yarn":
      return `yarn run ${script}`;
    case "bun":
      return `bun run ${script}`;
  }
}

function pickTypecheckScript(scripts: Record<string, string>): string | undefined {
  if (scripts.typecheck) return "typecheck";
  if (scripts["type-check"]) return "type-check";
  return undefined;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function maestroInstallTasks(command: string, flowPath: string): string[] {
  const home = process.env.HOME ?? "$HOME";
  const maestroBin = `${home}/.maestro/bin`;
  const lines = [
    `Manual tool setup: install Maestro CLI so QA can run device smoke.`,
    `Run: curl -Ls "https://get.maestro.mobile.dev" | bash`,
    `Run: echo 'export PATH="${maestroBin}:$PATH"' >> ~/.bashrc`,
    `Run: echo 'export PATH="${maestroBin}:$PATH"' >> ~/.zshrc`,
    `Run: export PATH="${maestroBin}:$PATH"`,
    `Run: hash -r && ${command} --version`,
    `Run: ${command} test ${quoteShell(flowPath)}`,
    "If the shell still cannot find the command, restart the terminal/Cursor shell so PATH updates apply.",
  ];
  return lines;
}

function resolveMaestroPipelineCommand(config: MaestroConfig): string | undefined {
  const explicit = config.pipelineCommand?.trim();
  if (explicit) return explicit;
  const cmd = config.command.trim();
  if (!cmd) return undefined;
  // npm/pnpm/yarn wrapper scripts (e.g. `npm run maestro:smoke -w @pkg --`) bootstrap Metro + Expo Go.
  if (/^(npm|pnpm|yarn)\s+run\b/i.test(cmd)) return cmd;
  if (/\bmaestro:/i.test(cmd)) return cmd;
  return undefined;
}

function resolveMaestroConfig(input: StageInputComposition): MaestroConfig {
  const maestro = input.config.project.qa_automation?.maestro;
  const command = maestro?.command ?? "maestro";
  const pipelineCommand = maestro?.pipeline_command?.trim() || resolveMaestroPipelineCommand({
    enabled: maestro?.enabled ?? false,
    required: maestro?.required ?? false,
    command,
    flowPath: maestro?.flow_path ?? ".maestro",
    installIfMissing: maestro?.install_if_missing ?? true,
    pipelineCommand: undefined,
    autoBootSimulator: maestro?.auto_boot_simulator ?? process.platform === "darwin",
    preferredSimulator: maestro?.preferred_simulator?.trim() || undefined,
    bootTimeoutSeconds: maestro?.boot_timeout_seconds ?? 90,
  });
  return {
    enabled: maestro?.enabled ?? false,
    required: maestro?.required ?? false,
    command,
    flowPath: maestro?.flow_path ?? ".maestro",
    installIfMissing: maestro?.install_if_missing ?? true,
    pipelineCommand,
    autoBootSimulator: maestro?.auto_boot_simulator ?? process.platform === "darwin",
    preferredSimulator: maestro?.preferred_simulator?.trim() || undefined,
    bootTimeoutSeconds: maestro?.boot_timeout_seconds ?? 90,
  };
}

function maestroHomeBinary(): string | undefined {
  const home = process.env.HOME;
  if (!home) return undefined;
  return join(home, ".maestro", "bin", "maestro");
}

type MaestroCommandResolution = {
  command: string;
  available: boolean;
  installAttempted: boolean;
  installedNow: boolean;
};

async function resolveMaestroCommand(repoPath: string, config: MaestroConfig): Promise<MaestroCommandResolution> {
  const candidates: string[] = [config.command];
  const homeBinary = maestroHomeBinary();
  if (homeBinary) candidates.push(homeBinary);
  const uniqueCandidates = [...new Set(candidates)];

  for (const candidate of uniqueCandidates) {
    const versionResult = await sh(`${quoteShell(candidate)} --version`, repoPath, 20_000);
    if (versionResult.exitCode === 0) {
      return { command: candidate, available: true, installAttempted: false, installedNow: false };
    }
  }

  if (!config.installIfMissing) {
    return { command: config.command, available: false, installAttempted: false, installedNow: false };
  }

  const install = await sh(`curl -Ls "https://get.maestro.mobile.dev" | bash`, repoPath, 180_000);
  const installSucceeded = install.exitCode === 0;
  if (!installSucceeded) {
    return { command: config.command, available: false, installAttempted: true, installedNow: false };
  }

  for (const candidate of uniqueCandidates) {
    const versionResult = await sh(`${quoteShell(candidate)} --version`, repoPath, 20_000);
    if (versionResult.exitCode === 0) {
      return { command: candidate, available: true, installAttempted: true, installedNow: true };
    }
  }

  return { command: config.command, available: false, installAttempted: true, installedNow: false };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [truncated]`;
}

/**
 * Best-effort parser that pulls concrete failing test signal out of a test
 * runner's combined stdout/stderr. Recognizes Jest (`FAIL path/to/x.test.ts`,
 * `at Object.<anonymous> (path/to/file.ts:42:7)`), Vitest (`❯ path/to/x.test.ts`,
 * `FAIL  path/to/x.test.ts > Suite > Test`), and Mocha (`AssertionError`).
 *
 * Returns the unique set of relative test file paths plus the first error
 * message line — enough context for Cursor to grep/open and fix without
 * needing to re-run the suite to discover the failure surface.
 */
function extractFailingTestDetails(summary: string): {
  failingFiles: string[];
  firstErrorLine: string;
} {
  const lines = summary.split(/\r?\n/);
  const filesSet = new Set<string>();
  // Jest/Vitest: `FAIL <path>` or `FAIL  <path> > Suite > Test`
  for (const line of lines) {
    const failMatch = line.match(/^\s*(?:FAIL|❯|✖)\s+([^\s>]+\.(?:t|j)sx?|[^\s>]+\.test\.[a-z]+)\b/);
    if (failMatch) {
      filesSet.add(failMatch[1]);
      continue;
    }
    // Vitest stack trace: `❯ packages/foo/tests/bar.test.ts:23`
    const stackMatch = line.match(/[\s(]((?:[a-zA-Z0-9._/-]+\/)?[a-zA-Z0-9._-]+\.(?:t|j)sx?):(\d+)/);
    if (stackMatch && /(test|spec|__tests__|\.test\.)/i.test(stackMatch[1])) {
      filesSet.add(stackMatch[1]);
    }
  }
  let firstErrorLine = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(Error|AssertionError|TypeError|ReferenceError|SyntaxError):/.test(trimmed)) {
      firstErrorLine = trimmed.slice(0, 200);
      break;
    }
    if (/expected\s+.+\s+to\s+(?:be|equal|match)/i.test(trimmed)) {
      firstErrorLine = trimmed.slice(0, 200);
      break;
    }
    if (/^✖\s/.test(trimmed) || /^●\s/.test(trimmed)) {
      firstErrorLine = trimmed.slice(0, 200);
      break;
    }
  }
  return { failingFiles: [...filesSet], firstErrorLine };
}

function estimateLintErrors(stdout: string, stderr: string): number {
  const blob = `${stdout}\n${stderr}`;
  if (!blob.trim()) return 0;
  const lines = blob.split("\n").filter((l) => /\berror\b/i.test(l) || /✖|×/.test(l));
  const n = lines.length;
  return n > 0 ? Math.min(n, 999) : 1;
}

async function grepCount(repoPath: string, regex: string, exts: string[]): Promise<number> {
  const includes = exts.map((e) => `--include='${e}'`).join(" ");
  const cmd = `grep -rE ${includes} --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=.next --exclude-dir=.turbo --exclude-dir=coverage ${regex} . 2>/dev/null | wc -l | tr -d '[:space:]'`;
  const r = await sh(cmd, repoPath, 60_000);
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

async function countLargeFiles(repoPath: string): Promise<{ count: number; sample: string[] }> {
  const prune =
    "\\( -path ./node_modules -o -path ./.git -o -path ./dist -o -path ./build -o -path ./.next \\)";
  const countCmd = `find . ${prune} -prune -o -type f -size +${LARGE_FILE_BYTES}c -print 2>/dev/null | wc -l | tr -d '[:space:]'`;
  const sampleCmd = `find . ${prune} -prune -o -type f -size +${LARGE_FILE_BYTES}c -print 2>/dev/null | head -12`;
  const [c, s] = await Promise.all([sh(countCmd, repoPath, 60_000), sh(sampleCmd, repoPath, 60_000)]);
  const parsed = parseInt(c.stdout.trim(), 10);
  const count = Number.isFinite(parsed) ? parsed : 0;
  const sample = s.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return { count, sample: sample.slice(0, 8) };
}

/**
 * Read the previous `independent_qa` output for regression comparison.
 *
 * Subtle but important: `foundry loop` runs a *post-Cursor pipeline slice* that
 * rebuilds `independent_qa`/`release_agent`/etc. but **omits** the `builder`
 * stage. Those slices write fresh `<runId>/...independent_qa/output.json`
 * artifacts on top of the Cursor branch state. If we treat them as the
 * regression baseline, the next outer cycle's pre-Cursor pipeline (which runs
 * `builder` again from main) inevitably looks like a regression even when
 * nothing meaningful changed — Cursor's branch had different state than main.
 *
 * Strategy: walk runs newest-to-oldest and prefer the most recent run whose
 * `run.json` manifest *includes* the `builder` stage (a real outer-cycle
 * baseline). Fall back to the most recent QA artifact only when no pre-Cursor
 * baseline exists yet (first runs).
 */
async function readPreviousIndependentQa(
  repoPath: string,
  currentRunId: string,
): Promise<IndependentQaOutput | undefined> {
  const outRoot = join(repoPath, ".foundry", "out");
  let entries: string[];
  try {
    entries = await readdir(outRoot);
  } catch {
    return undefined;
  }
  const runDirs = entries.sort((a, b) => b.localeCompare(a));
  let fallback: IndependentQaOutput | undefined;
  for (const runId of runDirs) {
    if (runId === currentRunId) continue;
    const runPath = join(outRoot, runId);
    let sub: string[];
    try {
      sub = await readdir(runPath);
    } catch {
      continue;
    }
    const qaDir = sub.find((d) => d.endsWith("_independent_qa"));
    if (!qaDir) continue;
    let qaData: IndependentQaOutput | undefined;
    try {
      const raw = await readFile(join(runPath, qaDir, "output.json"), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const v = IndependentQaOutputSchema.safeParse(parsed);
      if (!v.success) continue;
      qaData = v.data;
    } catch {
      continue;
    }
    // Manifest tells us whether this run was a full pre-Cursor outer cycle.
    let isOuterCyclePreCursor = false;
    try {
      const rawManifest = await readFile(join(runPath, "run.json"), "utf8");
      const manifest = JSON.parse(rawManifest) as {
        stages?: Array<{ stage?: string; status?: string }>;
      };
      isOuterCyclePreCursor = (manifest.stages ?? []).some(
        (s) => s.stage === "builder" && s.status !== "skipped" && s.status !== "pending",
      );
    } catch {
      // Older runs may not have a parsable manifest; treat as unknown and only
      // use as last-resort fallback below.
    }
    if (isOuterCyclePreCursor) return qaData;
    if (!fallback) fallback = qaData;
  }
  return fallback;
}

function recommendationFromScore(score: number): IndependentQaOutput["recommendation"] {
  if (score >= 70) return "ship";
  if (score >= 40) return "fix_first";
  return "blocked";
}

/** Maestro failed because no simulator/device is available — not a product-code defect. */
function isLikelyMaestroEnvironmentFailure(stdout: string, stderr: string): boolean {
  const t = `${stdout}\n${stderr}`.toLowerCase();
  return (
    /\b0 devices\b/.test(t) ||
    /\bno devices?\s+(connected|available|found)\b/.test(t) ||
    /\b(no|without)\s+(booted|running)\s+(simulator|device|emulator)/i.test(t) ||
    /\bsimulator\b.*\b(not running|not booted|shut down|unavailable)\b/.test(t) ||
    /\bwaiting for bootstatus\b/.test(t) ||
    /\bwaiting for simulator\b.*\bto accept\b/.test(t) ||
    /\b(simctl|xcrun)\b.*\b(timed out|timeout)\b/.test(t) ||
    /\bfailed to boot\b/.test(t) ||
    /\bunable to (find|launch|boot)\b.*\b(device|simulator)\b/i.test(t) ||
    /\bno\s+ios\s+simulator\b/i.test(t) ||
    /\bxcrun\b.*\berror\b/i.test(t) ||
    /\binstruments?\b.*\b(failed|error)\b/i.test(t)
  );
}

/** True when Maestro/app output points at Metro, packager, or dev-server connectivity — not generic flow failures. */
function maestroOutputSuggestsMetroOrPackagerIssue(stdout: string, stderr: string): boolean {
  const t = `${stdout}\n${stderr}`.toLowerCase();
  return (
    /\bmetro\b/.test(t) ||
    /\bpackager\b/.test(t) ||
    /\b(expo\s+)?dev\s*(client|server)?\b/.test(t) ||
    /\bdevelopment\s+server\b/.test(t) ||
    /cannot\s+connect/.test(t) ||
    /could\s+not\s+connect/.test(t) ||
    /unable\s+to\s+load\s+script/i.test(t) ||
    /connection\s+refused/.test(t) ||
    /ensure\s+.*\b(expo|metro|packager|bundler)\b/i.test(t)
  );
}

function maestroShipBlockingManualHint(stdout: string, stderr: string): string {
  if (maestroOutputSuggestsMetroOrPackagerIssue(stdout, stderr)) {
    return "If logs or the simulator show **Cannot connect to Metro** / packager errors: Metro must run on the port the dev client uses (often 8081). Prefer `npm run qa:device` (starts Metro + Maestro) over bare `maestro test` without a packager.";
  }
  return "Maestro smoke failed — inspect `.maestro-debug/` and the command output for failing steps (assertions, timeouts, wrong screen). For Expo/RN dev clients, set `qa_automation.maestro.pipeline_command` to a script that starts the bundler then runs Maestro.";
}

export const independentQaStage: Stage<StageInputComposition, IndependentQaOutput> = {
  name: "independent_qa",
  description:
    "Validate codebase quality after the builder: tests, lint, typecheck, scans, score, and recommendation.",
  inputSchema: StageInputCompositionSchema,
  outputSchema: IndependentQaOutputSchema,
  async run(ctx: RunContext, input: StageInputComposition): Promise<IndependentQaOutput> {
    const repoPath = ctx.repoPath;
    const projectName = input.config.project.project_name;
    const qaStartedMs = Date.now();
    /** Only screenshots at/after this time (minus slack) are attached — avoids stale `.maestro-debug` files. */
    let screenshotSinceMs = qaStartedMs;
    ctx.logger("[independent_qa] starting", { project: projectName, repoPath });

    const pm = await detectPackageManager(repoPath);
    const invParsed = RepoInventoryOutputSchema.safeParse(input.repoInventory);
    if (invParsed.success) {
      ctx.logger("[independent_qa] package manager (lockfile)", { pm, repoType: invParsed.data.summary.repoTypeGuess });
    } else {
      ctx.logger("[independent_qa] package manager (lockfile)", { pm });
    }

    const packageJsonPath = resolvePackageJsonPath(repoPath, input);
    const scripts = await readPackageScripts(packageJsonPath);
    const hasTestScript = Boolean(scripts.test);
    const hasLintScript = Boolean(scripts.lint);
    const typecheckName = pickTypecheckScript(scripts);
    const maestro = resolveMaestroConfig(input);

    const checks: IndependentQaOutput["checks"] = [];
    const blockers: string[] = [];
    const manualTasks: string[] = [];
    const warnings: string[] = [];
    const autoFixable: string[] = [];

    let testsRan = false;
    let testsPassed = false;
    let testSummary = "";

    if (hasTestScript) {
      const cmd = testCommand(pm);
      ctx.logger("[independent_qa] tests", { cmd });
      const r = await sh(cmd, repoPath, TEST_TIMEOUT_MS);
      testsRan = true;
      testsPassed = r.exitCode === 0;
      testSummary = truncate(`${r.stdout}\n${r.stderr}`.trim(), 4000);
      checks.push({
        name: "test_suite",
        passed: testsPassed,
        details: testsPassed ? `Exit 0 (${cmd})` : `Exit ${r.exitCode} (${cmd}). See testSummary.`,
      });
      if (!testsPassed) {
        // Expand the blocker with concrete failing test paths + the first
        // assertion/error line. Without this, the work packet only carries
        // the generic "Test suite failed" string and Cursor has no anchor
        // (file path, test name) to actually fix anything — the loop spins
        // for cycles repeating the same vague target.
        const failingDetails = extractFailingTestDetails(testSummary);
        if (failingDetails.failingFiles.length > 0 || failingDetails.firstErrorLine) {
          const fileList = failingDetails.failingFiles.slice(0, 4).join(", ");
          const moreFiles = failingDetails.failingFiles.length > 4 ? ` (+${failingDetails.failingFiles.length - 4} more)` : "";
          const errLine = failingDetails.firstErrorLine ? ` First error: ${failingDetails.firstErrorLine}` : "";
          blockers.push(
            `Test suite failed after builder changes.${fileList ? ` Failing files: ${fileList}${moreFiles}.` : ""}${errLine}`,
          );
        } else {
          blockers.push("Test suite failed after builder changes.");
        }
      }
    } else {
      checks.push({
        name: "test_suite",
        passed: true,
        details: "Skipped: no `test` script in package.json.",
      });
      testsRan = false;
      testsPassed = true;
      testSummary = "No `test` script in package.json — tests not executed.";
    }

    let lintPassed = true;
    let lintErrors = 0;
    if (hasLintScript) {
      const cmd = runScriptCommand(pm, "lint");
      ctx.logger("[independent_qa] lint", { cmd });
      const r = await sh(cmd, repoPath, LINT_TIMEOUT_MS);
      lintPassed = r.exitCode === 0;
      lintErrors = lintPassed ? 0 : estimateLintErrors(r.stdout, r.stderr);
      checks.push({
        name: "lint",
        passed: lintPassed,
        details: lintPassed ? `Exit 0 (${cmd})` : `Exit ${r.exitCode} (${cmd}); ~${lintErrors} error line(s) in output.`,
      });
      if (!lintPassed) autoFixable.push("Lint errors detected — builder will auto-fix on next cycle.");
    } else {
      checks.push({
        name: "lint",
        passed: true,
        details: "Skipped: no `lint` script in package.json.",
      });
    }

    let typecheckPassed = true;
    if (typecheckName) {
      const cmd = runScriptCommand(pm, typecheckName);
      ctx.logger("[independent_qa] typecheck", { cmd });
      const r = await sh(cmd, repoPath, TYPECHECK_TIMEOUT_MS);
      typecheckPassed = r.exitCode === 0;
      checks.push({
        name: "typecheck",
        passed: typecheckPassed,
        details: typecheckPassed ? `Exit 0 (${cmd})` : `Exit ${r.exitCode} (${cmd}).`,
      });
      if (!typecheckPassed) autoFixable.push("Typecheck errors detected — builder will auto-fix on next cycle.");
    } else {
      checks.push({
        name: "typecheck",
        passed: true,
        details: "Skipped: no `typecheck` or `type-check` script in package.json.",
      });
    }

    let maestroPassed = true;
    let maestroFailureIsShipBlocking = false;
    if (maestro.enabled) {
      if (maestro.required && !maestro.pipelineCommand) {
        warnings.push(
          "Maestro smoke is required but `qa_automation.maestro.pipeline_command` is unset. Bare `maestro test` often fails without a running Metro/packager; set `pipeline_command` to e.g. `npm run qa:device -- --debug-output .maestro-debug --flatten-debug-output`.",
        );
      }
      const maestroExists = await fileExists(join(repoPath, maestro.flowPath));
      if (!maestroExists) {
        maestroPassed = false;
        checks.push({
          name: "maestro_smoke",
          passed: false,
          details: `Configured flow path missing: ${maestro.flowPath}`,
        });
        const message = `Maestro enabled but flow path '${maestro.flowPath}' does not exist.`;
        maestroFailureIsShipBlocking = maestro.required;
        if (maestro.required) blockers.push(message);
        else warnings.push(message);
        manualTasks.push(
          `Manual repo/tooling setup: create or restore Maestro flows at ${maestro.flowPath}, then run: ${maestro.command} test ${quoteShell(maestro.flowPath)}`,
        );
      } else if (maestro.pipelineCommand) {
        const cmd = maestro.pipelineCommand;
        if (maestro.autoBootSimulator) {
          const boot = await ensureBootedIosSimulator(repoPath, maestro);
          ctx.logger("[independent_qa] maestro.simulator", boot);
          if (!boot.ok && boot.note !== "skipped: not darwin") warnings.push(`Simulator auto-boot: ${boot.note}`);
        }
        screenshotSinceMs = Date.now();
        ctx.logger("[independent_qa] maestro", { cmd, mode: "pipeline_command" });
        const r = await sh(cmd, repoPath, TEST_TIMEOUT_MS);
        maestroPassed = r.exitCode === 0;
        checks.push({
          name: "maestro_smoke",
          passed: maestroPassed,
          details: maestroPassed
            ? `Exit 0 (${cmd})`
            : `Exit ${r.exitCode} (${cmd}). ${truncate(`${r.stdout}\n${r.stderr}`.trim(), 500)}`,
        });
        if (!maestroPassed) {
          const envOnly = isLikelyMaestroEnvironmentFailure(r.stdout, r.stderr);
          const message = envOnly
            ? "Maestro smoke did not run: no booted simulator/device (environmental — not a code failure)."
            : "Maestro smoke flows failed.";
          if (envOnly && !maestro.required) {
            warnings.push(message);
            manualTasks.push(
              "Boot an iOS Simulator (or connect a device), run `npx expo run:ios` (or your platform build), then re-run smoke (or use `qa_automation.maestro.pipeline_command` with a script that starts Metro).",
            );
          } else if (maestro.required) {
            // required:true means we MUST see the product work to ship.
            // "Couldn't verify" (env-only) is not "ship" — block it too.
            blockers.push(
              envOnly
                ? `${message} Required UX smoke could not be verified on a device/simulator — blocking ship (qa_automation.maestro.required is true).`
                : message,
            );
            maestroFailureIsShipBlocking = true;
            manualTasks.push(
              envOnly
                ? "Boot an iOS Simulator (or connect a device), then re-run so the required scan→verdict UX smoke can actually execute."
                : maestroShipBlockingManualHint(r.stdout, r.stderr),
            );
          } else {
            warnings.push(`${message} Treating as warning because qa_automation.maestro.required is false.`);
          }
        }
      } else {
        const maestroCommand = await resolveMaestroCommand(repoPath, maestro);
        if (!maestroCommand.available) {
          maestroPassed = false;
          checks.push({
            name: "maestro_smoke",
            passed: false,
            details: `Command unavailable: ${maestro.command}${maestroCommand.installAttempted ? " (auto-install attempted)." : ""}`,
          });
          const message = `Maestro CLI '${maestro.command}' is not available in the current shell${maestroCommand.installAttempted ? " after auto-install attempt" : ""}.`;
          if (maestro.required) {
            blockers.push(message);
            maestroFailureIsShipBlocking = true;
          } else warnings.push(`${message} Device smoke skipped.`);
          manualTasks.push(...maestroInstallTasks(maestro.command, maestro.flowPath));
        } else {
          if (maestroCommand.installedNow) {
            manualTasks.push(
              "Maestro CLI was auto-installed by Foundry. Restart your shell once so PATH is refreshed globally for future runs.",
            );
          }
          const debugDir = join(repoPath, ".maestro-debug");
          const cmd = `${quoteShell(maestroCommand.command)} test ${quoteShell(maestro.flowPath)} --debug-output ${quoteShell(debugDir)} --flatten-debug-output`;
          if (maestro.autoBootSimulator) {
            const boot = await ensureBootedIosSimulator(repoPath, maestro);
            ctx.logger("[independent_qa] maestro.simulator", boot);
            if (!boot.ok && boot.note !== "skipped: not darwin") warnings.push(`Simulator auto-boot: ${boot.note}`);
          }
          screenshotSinceMs = Date.now();
          ctx.logger("[independent_qa] maestro", { cmd });
          const r = await sh(cmd, repoPath, TEST_TIMEOUT_MS);
          maestroPassed = r.exitCode === 0;
          checks.push({
            name: "maestro_smoke",
            passed: maestroPassed,
            details: maestroPassed
              ? `Exit 0 (${cmd})`
              : `Exit ${r.exitCode} (${cmd}). ${truncate(`${r.stdout}\n${r.stderr}`.trim(), 500)}`,
          });
          if (!maestroPassed) {
            const envOnly = isLikelyMaestroEnvironmentFailure(r.stdout, r.stderr);
            const message = envOnly
              ? "Maestro smoke did not run: no booted simulator/device (environmental — not a code failure)."
              : "Maestro smoke flows failed.";
            if (envOnly && !maestro.required) {
              warnings.push(message);
              manualTasks.push(
                "Boot an iOS Simulator (or connect a device), run `npx expo run:ios` (or your platform build), then `maestro test` on the configured flow path.",
              );
            } else if (maestro.required) {
              // required:true means we MUST see the product work to ship.
              blockers.push(
                envOnly
                  ? `${message} Required UX smoke could not be verified on a device/simulator — blocking ship (qa_automation.maestro.required is true).`
                  : message,
              );
              maestroFailureIsShipBlocking = true;
              manualTasks.push(
                envOnly
                  ? "Boot an iOS Simulator (or connect a device), then re-run so the required scan→verdict UX smoke can actually execute."
                  : maestroShipBlockingManualHint(r.stdout, r.stderr),
              );
            } else {
              warnings.push(`${message} Treating as warning because qa_automation.maestro.required is false.`);
            }
          }
        }
      }
    } else {
      checks.push({
        name: "maestro_smoke",
        passed: true,
        details: "Skipped: qa_automation.maestro.enabled is false.",
      });
    }

    ctx.logger("[independent_qa] scanning console / TODO / large files");
    const consoleCount = await grepCount(repoPath, "'console\\.(log|error)'", [
      "*.ts",
      "*.tsx",
      "*.js",
      "*.jsx",
      "*.mjs",
      "*.cjs",
    ]);
    const todoCount = await grepCount(repoPath, "'(TODO|FIXME)'", ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.py", "*.go", "*.rs"]);

    const consoleOk = consoleCount <= CONSOLE_SPAM_THRESHOLD;
    checks.push({
      name: "console_log_scan",
      passed: consoleOk,
      details: `Found ${consoleCount} console.log / console.error references (threshold ${CONSOLE_SPAM_THRESHOLD}).`,
    });
    if (!consoleOk) {
      warnings.push(`Console logging is heavy (${consoleCount} matches); consider removing before release.`);
    }

    const todoOk = todoCount <= TODO_SPAM_THRESHOLD;
    checks.push({
      name: "todo_fixme_scan",
      passed: todoOk,
      details: `Found ${todoCount} TODO/FIXME markers (threshold ${TODO_SPAM_THRESHOLD}).`,
    });
    if (!todoOk) {
      warnings.push(`Many TODO/FIXME markers (${todoCount}).`);
    }

    const large = await countLargeFiles(repoPath);
    const largeOk = large.count === 0;
    checks.push({
      name: "large_files",
      passed: largeOk,
      details: largeOk
        ? `No source-tracked files over ${LARGE_FILE_BYTES} bytes (sample scan).`
        : `${large.count} file(s) over ${LARGE_FILE_BYTES} bytes. Examples: ${large.sample.join(", ")}`,
    });
    if (!largeOk) {
      warnings.push(`${large.count} file(s) exceed ${LARGE_FILE_BYTES} bytes.`);
    }

    const prev = await readPreviousIndependentQa(repoPath, ctx.runId);
    let regression = false;
    if (prev && prev.testsRan && testsRan && prev.testsPassed && !testsPassed) {
      regression = true;
      blockers.push("Regression: tests passed in a previous Foundry QA run but fail now.");
      checks.push({
        name: "test_regression_vs_prior_qa",
        passed: false,
        details: "Prior independent_qa run had testsPassed=true; current run has testsPassed=false.",
      });
    } else {
      checks.push({
        name: "test_regression_vs_prior_qa",
        passed: true,
        details: prev
          ? "No regression vs prior QA artifact (tests not weaker than last recorded pass)."
          : "No prior independent_qa artifact to compare (first run or unreadable history).",
      });
    }

    const builderParsed = BuilderOutputSchema.safeParse(input.builder);
    if (builderParsed.success && builderParsed.data.status !== "ok") {
      warnings.push(`Builder stage status was "${builderParsed.data.status}" (not ok).`);
    }

    // Scoring: test failures are hard blockers; lint/typecheck are auto-fixable
    // and only produce a minor deduction. Console/TODO spam are warnings.
    let score = 100;
    if (testsRan && !testsPassed) score -= 40;
    if (regression) score -= 20;
    if (hasLintScript && !lintPassed) score -= 5;
    if (typecheckName && !typecheckPassed) score -= 5;
    if (maestro.enabled && maestroFailureIsShipBlocking) score -= 20;
    if (consoleCount > CONSOLE_SPAM_THRESHOLD) score -= 5;
    if (todoCount > TODO_SPAM_THRESHOLD) score -= 5;
    score = Math.max(0, Math.min(100, score));

    const recommendation = recommendationFromScore(score);

    const output: IndependentQaOutput = {
      score,
      testsRan,
      testsPassed,
      testSummary,
      lintPassed,
      lintErrors,
      typecheckPassed,
      checks,
      blockers,
      manualTasks: [...new Set(manualTasks)],
      screenshotArtifacts: await collectQaScreenshots(repoPath, screenshotSinceMs),
      warnings,
      autoFixable,
      recommendation,
    };

    const md = buildReadmeMarkdown(projectName, pm, packageJsonPath, output, prev);
    await writeStageMarkdown(ctx, "independent_qa", "README.md", md);

    ctx.logger("[independent_qa] done", { score, recommendation, blockers: blockers.length, warnings: warnings.length });
    return IndependentQaOutputSchema.parse(output);
  },
};

function buildReadmeMarkdown(
  projectName: string,
  pm: PackageManager,
  packageJsonPath: string,
  out: IndependentQaOutput,
  prev: IndependentQaOutput | undefined,
): string {
  const lines: string[] = [
    `# Independent QA — ${projectName}`,
    "",
    `**Quality score:** ${out.score}/100`,
    "",
    `**Recommendation:** \`${out.recommendation}\` (${out.recommendation === "ship" ? "ready to ship" : out.recommendation === "fix_first" ? "address issues before shipping" : "blocked"})`,
    "",
    "## Summary",
    "",
    "| Check | Result |",
    "|-------|--------|",
    `| Tests | ${out.testsRan ? (out.testsPassed ? "passed" : "failed") : "not run (no script)"} |`,
    `| Lint | ${out.lintPassed ? "passed" : "failed / skipped"} |`,
    `| Typecheck | ${out.typecheckPassed ? "passed" : "failed / skipped"} |`,
    "",
    `- **Package manager (lockfile):** ${pm}`,
    `- **package.json:** \`${packageJsonPath}\``,
    "",
  ];
  if (prev) {
    lines.push("## Comparison with prior QA", "", `- Previous run had testsPassed=${prev.testsPassed}, score=${prev.score}.`, "");
  }
  lines.push(
    "## Blockers (must fix before release)",
    "",
    out.blockers.length ? out.blockers.map((b) => `- ${b}`).join("\n") : "_None — ready to ship._",
    "",
    "## Manual tasks (system / toolset / external)",
    "",
    out.manualTasks.length ? out.manualTasks.map((t) => `- ${t}`).join("\n") : "_None._",
    "",
    "## Screenshot artifacts",
    "",
    out.screenshotArtifacts.length ? out.screenshotArtifacts.map((s) => `- \`${s}\``).join("\n") : "_No QA screenshots were captured for this run._",
    "",
    "## Auto-fixable (builder handles these)",
    "",
    out.autoFixable.length ? out.autoFixable.map((a) => `- ${a}`).join("\n") : "_None._",
    "",
    "## Warnings",
    "",
    out.warnings.length ? out.warnings.map((w) => `- ${w}`).join("\n") : "_None._",
    "",
    "## Checks",
    "",
    ...out.checks.map((c) => [`### ${c.name}`, "", c.passed ? "Status: **passed**" : "Status: **failed**", "", c.details, ""].join("\n")),
    "## Test output (excerpt)",
    "",
    "```text",
    out.testSummary || "(empty)",
    "```",
    "",
    "---",
    "",
    "_Generated by Foundry `independent_qa` stage._",
  );
  return lines.join("\n");
}
