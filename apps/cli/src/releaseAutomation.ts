import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import QRCode from "qrcode";

import type { FoundryConfig, RunManifest } from "@foundry/core";

export interface EasBuildSettings {
  buildOnApproval: boolean;
  command: string;
  profile: string;
  platform: "ios" | "android" | "all";
  nonInteractive: boolean;
}

export interface EasBuildResult {
  status: "skipped" | "already_started" | "started" | "failed";
  detail: string;
  logPath?: string;
  artifactPath?: string;
  buildId?: string;
  buildUrl?: string;
  /** ANSI “large cell” terminal QR for `buildUrl` (console only); not stored in eas-build.json. */
  qrCodeAscii?: string;
  /** High-res PNG of the same QR (reliable to scan from phone); not stored in eas-build.json. */
  qrCodePngPath?: string;
}

export interface TestFlightSubmitResult {
  status: "skipped" | "already_started" | "started" | "failed";
  detail: string;
  logPath?: string;
  artifactPath?: string;
  submissionId?: string;
}

export interface ReleasePromotionResult {
  status: "skipped" | "promoted" | "failed";
  detail: string;
  logPath?: string;
  baseBranch?: string;
  builderBranch?: string;
}

function isEasEligibleConfig(config: FoundryConfig): boolean {
  const repoType = config.project.repo_type.toLowerCase();
  return !/^(web_data_platform|web_app|node|python|enterprise)/i.test(repoType);
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function easCommandWithArgs(command: string, args: string[]): string {
  const prefix = command.trim();
  return [prefix, ...args.map(shellQuote)].filter(Boolean).join(" ");
}

/**
 * True if `git status --porcelain` reports any change outside `.foundry/`.
 * Foundry itself writes approvals, run output, and release logs under `.foundry/`; those should not
 * block automatic branch promotion after approval.
 */
/** Parse one line of `git status --porcelain=1` (required; v2 breaks naive `slice(3)`). */
function parsePorcelainV1Path(line: string): string | undefined {
  const t = line.trimEnd();
  if (!t || t.startsWith("#")) return undefined;
  if (/^[0-9] /.test(t)) return undefined;
  if (t.length < 4) return undefined;
  const sep = t[2];
  if (sep !== " " && sep !== "\t") return undefined;
  let rawPath = t.slice(3).trim();
  if (!rawPath) return undefined;
  if (rawPath.includes(" -> ")) {
    rawPath = rawPath.split(" -> ").pop()!.trim();
  }
  return rawPath.replace(/^"|"$/g, "");
}

function hasNonFoundryWorkingTreeChanges(porcelain: string): boolean {
  for (const raw of porcelain.split("\n")) {
    const p = parsePorcelainV1Path(raw);
    if (!p) continue;
    if (p === ".foundry" || p.startsWith(".foundry/")) continue;
    return true;
  }
  return false;
}

function foundryWorkingTreePaths(porcelain: string): string[] {
  const out: string[] = [];
  for (const raw of porcelain.split("\n")) {
    const p = parsePorcelainV1Path(raw);
    if (!p) continue;
    if (p === ".foundry" || p.startsWith(".foundry/")) out.push(p);
  }
  return [...new Set(out)];
}

function shellBootstrapCommand(inner: string): string {
  const setup = [
    "[ -f ~/.bash_profile ] && source ~/.bash_profile >/dev/null 2>&1 || true",
    "[ -f ~/.bashrc ] && source ~/.bashrc >/dev/null 2>&1 || true",
    "[ -f ~/.profile ] && source ~/.profile >/dev/null 2>&1 || true",
  ].join("; ");
  return `${setup}; ${inner}`;
}

function exec(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/bash";
    execFile(
      shell,
      ["-lc", shellBootstrapCommand(command)],
      {
        cwd,
        env: process.env,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const extra =
          error && typeof error === "object" && "message" in error
            ? String((error as { message?: string }).message ?? "")
            : "";
        resolve({
          exitCode: error ? 1 : 0,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr:
            [typeof stderr === "string" ? stderr : "", extra]
              .filter(Boolean)
              .join("\n") || "",
        });
      },
    );
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function walkForExpoBuildUrls(value: unknown, out: Set<string>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (value.includes("expo.dev") && value.includes("/builds/")) {
      const m = value.match(
        /https:\/\/expo\.dev\/accounts\/[^/\s"'<>]+\/projects\/[^/\s"'<>]+\/builds\/[a-zA-Z0-9-]+/,
      );
      if (m) out.add(m[0]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const x of value) walkForExpoBuildUrls(x, out);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value)) walkForExpoBuildUrls(v, out);
  }
}

function parseBuildInfo(stdout: string, stderr = ""): { buildId?: string; buildUrl?: string } {
  const combined = `${stdout}\n${stderr}`;
  const fromRegex = [
    ...combined.matchAll(
      /https:\/\/expo\.dev\/accounts\/[^/\s"'<>]+\/projects\/[^/\s"'<>]+\/builds\/[a-zA-Z0-9-]+/g,
    ),
  ].map((m) => m[0]);
  const urlSet = new Set(fromRegex);

  const lines = combined
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let buildId: string | undefined;
  let buildUrl: string | undefined;

  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    const line = lines[idx];
    if (!(line.startsWith("{") || line.startsWith("["))) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        if (!buildId && typeof obj.id === "string") buildId = obj.id;
        const w =
          typeof obj.webUrl === "string"
            ? obj.webUrl
            : typeof obj.buildDetailsPageUrl === "string"
              ? obj.buildDetailsPageUrl
              : undefined;
        if (w) urlSet.add(w);
        walkForExpoBuildUrls(item, urlSet);
      }
    } catch {
      /* ignore */
    }
  }

  const urls = [...urlSet];
  if (urls.length > 0) buildUrl = urls[urls.length - 1];
  return { buildId, buildUrl };
}

const EAS_BUILD_QR_PNG = "eas-build-qr.png";

async function enrichEasResultWithQr(
  result: EasBuildResult,
  releaseDir: string,
): Promise<EasBuildResult> {
  if (!result.buildUrl) return result;
  try {
    await mkdir(releaseDir, { recursive: true });
    const qrCodePngPath = join(releaseDir, EAS_BUILD_QR_PNG);
    await QRCode.toFile(qrCodePngPath, result.buildUrl, {
      errorCorrectionLevel: "M",
      width: 640,
      margin: 4,
    });
    // Default `toString` uses UTF-8 half-blocks (very dense for long URLs). `terminal` uses ANSI
    // 2×2-ish cells per module — much easier to scan from a laptop screen.
    const qrCodeAscii = await QRCode.toString(result.buildUrl, {
      type: "terminal",
      errorCorrectionLevel: "M",
      small: false,
    });
    return { ...result, qrCodeAscii, qrCodePngPath };
  } catch {
    return result;
  }
}

async function finishEasInstallDocs(
  repoPath: string,
  manifest: RunManifest,
  settings: EasBuildSettings,
  result: EasBuildResult,
): Promise<EasBuildResult> {
  const releaseDir = join(repoPath, ".foundry", "releases", manifest.runId);
  const out = await enrichEasResultWithQr(result, releaseDir);
  await writeLatestInstallFile(repoPath, manifest, settings, out);
  return out;
}

async function persistPromotionLog(
  repoPath: string,
  manifest: RunManifest,
  result: ReleasePromotionResult,
  stdout = "",
  stderr = "",
): Promise<ReleasePromotionResult> {
  const releaseDir = join(repoPath, ".foundry", "releases", manifest.runId);
  const logPath = join(releaseDir, "branch-promotion.log");
  await mkdir(releaseDir, { recursive: true });
  const log = [
    `status: ${result.status}`,
    `detail: ${result.detail}`,
    result.baseBranch ? `baseBranch: ${result.baseBranch}` : "",
    result.builderBranch ? `builderBranch: ${result.builderBranch}` : "",
    "",
    "=== STDOUT ===",
    stdout,
    "",
    "=== STDERR ===",
    stderr,
  ]
    .filter(Boolean)
    .join("\n");
  await writeFile(logPath, log, "utf8");
  return { ...result, logPath };
}

async function autoCommitAndPushFoundryArtifacts(
  repoPath: string,
  branchName: string,
  runId: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const status = await exec("git status --porcelain=1", repoPath, 15_000);
  stdout += `${status.stdout}\n`;
  stderr += `${status.stderr}\n`;
  if (status.exitCode !== 0) return { ok: false, stdout, stderr };
  const foundryPaths = foundryWorkingTreePaths(status.stdout);
  if (foundryPaths.length === 0) return { ok: true, stdout, stderr };

  const add = await exec(`git add -A -- ${foundryPaths.map((p) => shellQuote(p)).join(" ")}`, repoPath, 30_000);
  stdout += `${add.stdout}\n`;
  stderr += `${add.stderr}\n`;
  if (add.exitCode !== 0) return { ok: false, stdout, stderr };

  const commit = await exec(
    `git commit -m ${shellQuote(`foundry: update run artifacts ${runId}`)}`,
    repoPath,
    60_000,
  );
  stdout += `${commit.stdout}\n`;
  stderr += `${commit.stderr}\n`;
  if (commit.exitCode !== 0) {
    // Nothing to commit is acceptable here.
    if (!/nothing to commit|no changes added to commit/i.test(`${commit.stdout}\n${commit.stderr}`)) {
      return { ok: false, stdout, stderr };
    }
  }

  const push = await exec(`git push -u origin ${shellQuote(branchName)}`, repoPath, 120_000);
  stdout += `${push.stdout}\n`;
  stderr += `${push.stderr}\n`;
  return { ok: push.exitCode === 0, stdout, stderr };
}

export async function promoteApprovedBranch(
  repoPath: string,
  manifest: RunManifest,
  builder?: { branchName?: string; baseBranch?: string },
): Promise<ReleasePromotionResult> {
  const builderBranch = builder?.branchName;
  const targetBranch = "main";
  if (!builderBranch) {
    return persistPromotionLog(
      repoPath,
      manifest,
      { status: "skipped", detail: "Builder branch metadata not available; skipping branch promotion." },
    );
  }

  const remote = await exec("git remote get-url origin", repoPath, 15_000);
  if (remote.exitCode !== 0) {
    return persistPromotionLog(
      repoPath,
      manifest,
      {
        status: "failed",
        detail: "Git remote 'origin' is not configured; cannot push release branch.",
        baseBranch: targetBranch,
        builderBranch,
      },
      remote.stdout,
      remote.stderr,
    );
  }

  const status = await exec("git status --porcelain=1", repoPath, 15_000);
  if (status.exitCode !== 0) {
    return persistPromotionLog(
      repoPath,
      manifest,
      {
        status: "failed",
        detail: "Could not read git status; refusing to merge/push release branch automatically.",
        baseBranch: targetBranch,
        builderBranch,
      },
      status.stdout,
      status.stderr,
    );
  }
  if (hasNonFoundryWorkingTreeChanges(status.stdout)) {
    return persistPromotionLog(
      repoPath,
      manifest,
      {
        status: "failed",
        detail:
          "Working tree has changes outside `.foundry/`; commit or stash them, then re-run promotion (or merge/push manually). Changes only under `.foundry/` (e.g. approvals, run output) no longer block automatic promotion.",
        baseBranch: targetBranch,
        builderBranch,
      },
      status.stdout,
      status.stderr,
    );
  }

  const steps: string[] = [];
  let combinedStdout = "";
  let combinedStderr = "";
  const runStep = async (command: string): Promise<boolean> => {
    steps.push(`$ ${command}`);
    const r = await exec(command, repoPath, 2 * 60_000);
    combinedStdout += `${steps[steps.length - 1]}\n${r.stdout}\n`;
    combinedStderr += `${steps[steps.length - 1]}\n${r.stderr}\n`;
    return r.exitCode === 0;
  };

  const currentBranch = await exec("git rev-parse --abbrev-ref HEAD", repoPath, 15_000);
  if (currentBranch.exitCode !== 0) {
    return persistPromotionLog(
      repoPath,
      manifest,
      {
        status: "failed",
        detail: "Could not determine current git branch before promotion.",
        baseBranch: targetBranch,
        builderBranch,
      },
      currentBranch.stdout,
      currentBranch.stderr,
    );
  }

  if (status.stdout.trim()) {
    const current = currentBranch.stdout.trim();
    const committedFoundry = await autoCommitAndPushFoundryArtifacts(repoPath, current, manifest.runId);
    combinedStdout += `[auto-commit-foundry]\n${committedFoundry.stdout}\n`;
    combinedStderr += `[auto-commit-foundry]\n${committedFoundry.stderr}\n`;
    if (!committedFoundry.ok) {
      return persistPromotionLog(
        repoPath,
        manifest,
        {
          status: "failed",
          detail: "Foundry-generated artifacts were dirty and could not be auto-committed before branch promotion.",
          baseBranch: targetBranch,
          builderBranch,
        },
        combinedStdout,
        combinedStderr,
      );
    }
  }

  const builderExists = await exec(`git show-ref --verify --quiet ${shellQuote(`refs/heads/${builderBranch}`)}`, repoPath, 15_000);
  if (builderExists.exitCode !== 0) {
    return persistPromotionLog(
      repoPath,
      manifest,
      {
        status: "failed",
        detail: `Local builder branch '${builderBranch}' does not exist; cannot promote release automatically.`,
        baseBranch: targetBranch,
        builderBranch,
      },
      builderExists.stdout,
      builderExists.stderr,
    );
  }

  const fetched = await runStep("git fetch origin");
  if (!fetched) {
    return persistPromotionLog(
      repoPath,
      manifest,
      {
        status: "failed",
        detail: "Failed to fetch from origin before release promotion.",
        baseBranch: targetBranch,
        builderBranch,
      },
      combinedStdout,
      combinedStderr,
    );
  }

  const builderPushed = await runStep(`git push -u origin ${shellQuote(builderBranch)}`);
  if (!builderPushed) {
    return persistPromotionLog(
      repoPath,
      manifest,
      {
        status: "failed",
        detail: `Builder branch '${builderBranch}' could not be pushed to origin before promotion.`,
        baseBranch: targetBranch,
        builderBranch,
      },
      combinedStdout,
      combinedStderr,
    );
  }

  const targetExists = await exec(`git show-ref --verify --quiet ${shellQuote(`refs/heads/${targetBranch}`)}`, repoPath, 15_000);
  if (targetExists.exitCode !== 0) {
    const createdTarget = await runStep(`git checkout -b ${shellQuote(targetBranch)} --track origin/${targetBranch}`);
    if (!createdTarget) {
      return persistPromotionLog(
        repoPath,
        manifest,
        {
          status: "failed",
          detail: `Local release branch '${targetBranch}' does not exist and could not be created from origin.`,
          baseBranch: targetBranch,
          builderBranch,
        },
        combinedStdout,
        combinedStderr,
      );
    }
  }

  if (currentBranch.stdout.trim() !== targetBranch) {
    const checkedOut = await runStep(`git checkout ${shellQuote(targetBranch)}`);
    if (!checkedOut) {
      return persistPromotionLog(
        repoPath,
        manifest,
        {
          status: "failed",
          detail: `Failed to checkout release branch '${targetBranch}' for promotion.`,
          baseBranch: targetBranch,
          builderBranch,
        },
        combinedStdout,
        combinedStderr,
      );
    }
  }

  const updatedMain = await runStep(`git pull --ff-only origin ${shellQuote(targetBranch)}`);
  if (!updatedMain) {
    return persistPromotionLog(
      repoPath,
      manifest,
      {
        status: "failed",
        detail: `Failed to fast-forward '${targetBranch}' from origin before merging.`,
        baseBranch: targetBranch,
        builderBranch,
      },
      combinedStdout,
      combinedStderr,
    );
  }

  if (builderBranch !== targetBranch) {
    const merged = await runStep(`git merge --no-edit ${shellQuote(builderBranch)}`);
    if (!merged) {
      return persistPromotionLog(
        repoPath,
        manifest,
        {
          status: "failed",
          detail: `Failed to merge builder branch '${builderBranch}' into '${targetBranch}'.`,
          baseBranch: targetBranch,
          builderBranch,
        },
        combinedStdout,
        combinedStderr,
      );
    }
  }

  const pushed = await runStep(`git push origin ${shellQuote(targetBranch)}`);
  if (!pushed) {
    return persistPromotionLog(
      repoPath,
      manifest,
      {
        status: "failed",
        detail: `Merged into '${targetBranch}' but failed to push to origin.`,
        baseBranch: targetBranch,
        builderBranch,
      },
      combinedStdout,
      combinedStderr,
    );
  }

  return persistPromotionLog(
    repoPath,
    manifest,
    {
      status: "promoted",
      detail:
        builderBranch === targetBranch
          ? `Release branch '${targetBranch}' pushed to origin.`
          : `Merged '${builderBranch}' into '${targetBranch}' and pushed '${targetBranch}' to origin.`,
      baseBranch: targetBranch,
      builderBranch,
    },
    combinedStdout,
    combinedStderr,
  );
}

export function resolveEasBuildSettings(config: FoundryConfig): EasBuildSettings {
  const eas = config.project.release_automation?.eas;
  return {
    buildOnApproval: eas?.build_on_approval ?? false,
    command: eas?.command ?? "eas",
    profile: eas?.profile ?? "preview",
    platform: eas?.platform ?? "ios",
    nonInteractive: eas?.non_interactive ?? true,
  };
}

async function writeLatestInstallFile(
  repoPath: string,
  manifest: RunManifest,
  settings: EasBuildSettings,
  result: EasBuildResult,
): Promise<void> {
  const lines = [
    "# Latest Install",
    "",
    `- Run: \`${manifest.runId}\``,
    `- Status: \`${result.status}\``,
    `- Platform: \`${settings.platform}\``,
    `- Profile: \`${settings.profile}\``,
    "",
    `- Detail: ${result.detail}`,
    result.buildUrl ? `- Build URL: ${result.buildUrl}` : "- Build URL: not available",
    result.logPath ? `- Build log: \`${result.logPath}\`` : "- Build log: not available",
    result.artifactPath ? `- Build artifact: \`${result.artifactPath}\`` : "- Build artifact: not available",
    result.qrCodePngPath ? `- Scannable QR (PNG): \`${result.qrCodePngPath}\`` : "",
    "",
    "## Scan QR (phone camera)",
    "",
    "Prefer the **PNG** below (or open that file on disk and scan it) — terminal ASCII QR codes are often too dense for cameras. When the build finishes, use the Expo page **Install** action.",
    "",
    ...(result.buildUrl
      ? [
          "Plain link:",
          "",
          `\`${result.buildUrl}\``,
          "",
        ]
      : []),
    ...(result.qrCodePngPath
      ? [
          `![EAS build page QR](.foundry/releases/${manifest.runId}/${EAS_BUILD_QR_PNG})`,
          "",
        ]
      : []),
    ...(result.qrCodeAscii
      ? [
          "_Terminal preview (ANSI; best viewed in the console, not all Markdown viewers):_",
          "",
          "```",
          result.qrCodeAscii.trimEnd(),
          "```",
          "",
        ]
      : ["_QR not generated (no build URL yet or qrcode failed)._", ""]),
    "## Install On iPhone",
    "",
    "1. After the build completes, open the link above (or scan the QR).",
    "2. On the Expo build page, tap install/download for your device.",
    "3. If prompted, install the app.",
    "4. If iOS blocks launch, go to `Settings -> General -> VPN & Device Management`.",
    "5. Trust the developer profile, then open the app.",
    "",
    "## Notes",
    "",
    "- Foundry writes this file after each approved EAS build attempt.",
    "- If the URL is missing here, open the build log and copy the Expo build page link from there.",
    "",
  ];
  await writeFile(join(repoPath, ".foundry", "LATEST_INSTALL.md"), lines.join("\n"), "utf8");
}

export async function maybeRunApprovedEasBuild(
  repoPath: string,
  config: FoundryConfig,
  manifest: RunManifest,
  releaseStatus: string | undefined,
  opts?: { force?: boolean },
): Promise<EasBuildResult> {
  const settings = resolveEasBuildSettings(config);
  if (!isEasEligibleConfig(config)) {
    const result = { status: "skipped", detail: "EAS build skipped: project repo_type is not mobile/Expo." } satisfies EasBuildResult;
    return finishEasInstallDocs(repoPath, manifest, settings, result);
  }
  if (!settings.buildOnApproval && !opts?.force) {
    const result = { status: "skipped", detail: "EAS build on approval is disabled in .foundry/project.yaml." } satisfies EasBuildResult;
    return finishEasInstallDocs(repoPath, manifest, settings, result);
  }
  if (releaseStatus !== "approved" && releaseStatus !== "auto_approved") {
    const result = { status: "skipped", detail: "Release is not approved yet." } satisfies EasBuildResult;
    return finishEasInstallDocs(repoPath, manifest, settings, result);
  }

  const releaseDir = join(repoPath, ".foundry", "releases", manifest.runId);
  const artifactPath = join(releaseDir, "eas-build.json");
  const logPath = join(releaseDir, "eas-build.log");
  await mkdir(releaseDir, { recursive: true });

  const persist = async (result: EasBuildResult, stdout = "", stderr = ""): Promise<EasBuildResult> => {
    const log = [
      `status: ${result.status}`,
      `detail: ${result.detail}`,
      "",
      "=== STDOUT ===",
      stdout,
      "",
      "=== STDERR ===",
      stderr,
    ].join("\n");
    await writeFile(logPath, log, "utf8");
    const withPaths = { ...result, logPath, artifactPath };
    await writeFile(artifactPath, JSON.stringify(withPaths, null, 2), "utf8");
    return withPaths;
  };

  if (await fileExists(artifactPath)) {
    try {
      const raw = await readFile(artifactPath, "utf8");
      const prior = JSON.parse(raw) as Partial<EasBuildResult>;
      const result = {
        status: "already_started",
        detail: typeof prior.detail === "string" ? prior.detail : "EAS build already recorded for this run.",
        logPath,
        artifactPath,
        buildId: typeof prior.buildId === "string" ? prior.buildId : undefined,
        buildUrl: typeof prior.buildUrl === "string" ? prior.buildUrl : undefined,
      } satisfies EasBuildResult;
      return finishEasInstallDocs(repoPath, manifest, settings, result);
    } catch {
      const result = {
        status: "already_started",
        detail: "EAS build artifact already exists for this run.",
        logPath,
        artifactPath,
      } satisfies EasBuildResult;
      return finishEasInstallDocs(repoPath, manifest, settings, result);
    }
  }

  const availability = await exec(easCommandWithArgs(settings.command, ["--version"]), repoPath, 15_000);
  if (availability.exitCode !== 0) {
    const persisted = await persist(
      {
      status: "failed",
      detail: `EAS CLI '${settings.command}' is not available from the Foundry shell.`,
      },
      availability.stdout,
      availability.stderr,
    );
    return finishEasInstallDocs(repoPath, manifest, settings, persisted);
  }

  const auth = await exec(easCommandWithArgs(settings.command, ["whoami"]), repoPath, 15_000);
  if (auth.exitCode !== 0) {
    const persisted = await persist(
      {
      status: "failed",
      detail: `EAS CLI '${settings.command}' is available, but not authenticated.`,
      },
      auth.stdout,
      auth.stderr,
    );
    return finishEasInstallDocs(repoPath, manifest, settings, persisted);
  }

  const args = [
    "build",
    "--platform",
    settings.platform,
    "--profile",
    settings.profile,
    "--json",
  ];
  if (settings.nonInteractive) args.push("--non-interactive");

  const result = await exec(easCommandWithArgs(settings.command, args), repoPath, 10 * 60_000);
  const buildInfo = parseBuildInfo(result.stdout, result.stderr);
  const detail =
    result.exitCode === 0
      ? `EAS build started for platform=${settings.platform}, profile=${settings.profile}.`
      : `EAS build command failed for platform=${settings.platform}, profile=${settings.profile}.`;

  const logUrlsFromStdout = extractExpoBuildLogUrls(result.stdout);
  const remoteDetails = await fetchExpoBuildDetails(
    settings.command,
    buildInfo.buildId,
    repoPath,
    logUrlsFromStdout,
  );
  if (remoteDetails) {
    const remotePath = join(releaseDir, "expo-build-view.json");
    await writeFile(remotePath, remoteDetails.raw, "utf8");
    if (remoteDetails.remoteLogs) {
      const logsTxtPath = join(releaseDir, "expo-build-logs.txt");
      await writeFile(logsTxtPath, remoteDetails.remoteLogs, "utf8");
    }
  }

  const log = [
    `command: ${settings.command} ${args.join(" ")}`,
    `exitCode: ${result.exitCode}`,
    buildInfo.buildId ? `buildId: ${buildInfo.buildId}` : "",
    buildInfo.buildUrl ? `buildUrl: ${buildInfo.buildUrl}` : "",
    "",
    "=== STDOUT ===",
    result.stdout,
    "",
    "=== STDERR ===",
    result.stderr,
    remoteDetails
      ? [
          "",
          "=== EXPO REMOTE BUILD VIEW (eas build:view --json) ===",
          remoteDetails.summary,
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  await writeFile(logPath, log, "utf8");

  const artifact = {
    status: result.exitCode === 0 ? "started" : "failed",
    detail,
    logPath,
    artifactPath,
    buildId: buildInfo.buildId,
    buildUrl: buildInfo.buildUrl,
  } satisfies EasBuildResult;
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2), "utf8");
  return finishEasInstallDocs(repoPath, manifest, settings, artifact);
}

const EXPO_BUILD_URL_RE =
  /https:\/\/expo\.dev\/accounts\/[^/\s"'<>]+\/projects\/[^/\s"'<>]+\/builds\/([a-zA-Z0-9-]{8,})/g;
const MAX_EXPO_BACKFILL_RUN_DIRS = 6;

/** Best-effort: pull the JSON array/object that EAS prints when invoked with `--json`. */
function extractEasBuildJson(text: string): Record<string, unknown> | null {
  try {
    const stdoutBlock = text.match(/=== STDOUT ===\n([\s\S]*?)(?:\n=== STDERR ===|$)/)?.[1] ?? text;
    const trimmed = stdoutBlock.trim();
    if (!trimmed) return null;
    const firstArr = trimmed.indexOf("[");
    const firstObj = trimmed.indexOf("{");
    let start = -1;
    if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) start = firstArr;
    else if (firstObj !== -1) start = firstObj;
    if (start < 0) return null;
    const endChar = trimmed[start] === "[" ? "]" : "}";
    const end = trimmed.lastIndexOf(endChar);
    if (end <= start) return null;
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return first && typeof first === "object" ? (first as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Extract every remote build log URL present in EAS JSON output.
 * Covers `logFiles: []`, `artifacts.xcodeBuildLogsUrl`, `artifacts.buildLogsUrl`,
 * and bare `logsUrl`/`logs` strings.
 */
export function extractExpoBuildLogUrls(text: string | Record<string, unknown> | null): string[] {
  const parsed = typeof text === "string" ? extractEasBuildJson(text) : text;
  if (!parsed) return [];
  const urls = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && /^https?:\/\//i.test(v)) urls.add(v);
  };
  const logFiles = parsed.logFiles;
  if (Array.isArray(logFiles)) for (const u of logFiles) add(u);
  else if (typeof logFiles === "string") {
    try {
      const p = JSON.parse(logFiles);
      if (Array.isArray(p)) for (const u of p) add(u);
      else add(logFiles);
    } catch {
      add(logFiles);
    }
  }
  add(parsed.logsUrl);
  add(parsed.logs);
  const artifacts = parsed.artifacts;
  if (artifacts && typeof artifacts === "object") {
    const a = artifacts as Record<string, unknown>;
    add(a.xcodeBuildLogsUrl);
    add(a.buildLogsUrl);
    add(a.buildUrl);
  }
  return [...urls];
}

/** Pull buildId from parsed eas build JSON (or fallback to regex on text). */
function buildIdFromJson(parsed: Record<string, unknown> | null, fallbackText: string): string | undefined {
  if (parsed && typeof parsed.id === "string") return parsed.id;
  const m = fallbackText.match(EXPO_BUILD_URL_RE);
  if (m) {
    const url = m[0];
    const tail = url.split("/builds/")[1];
    if (tail) return tail.split(/[^a-zA-Z0-9-]/)[0];
  }
  return undefined;
}

function normalizeExpoBuildViewPayload(input: unknown, buildId?: string): Record<string, unknown> | null {
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
  if (!candidate || typeof candidate !== "object") return null;
  const build = candidate as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof build.id === "string") out.id = build.id;
  else if (buildId) out.id = buildId;
  if (typeof build.status === "string") out.status = build.status;
  if (typeof build.platform === "string") out.platform = build.platform;
  if (typeof build.appVersion === "string") out.appVersion = build.appVersion;
  if (typeof build.sdkVersion === "string") out.sdkVersion = build.sdkVersion;
  if (build.error && typeof build.error === "object") out.error = build.error;
  const artifacts = build.artifacts;
  if (artifacts && typeof artifacts === "object") out.artifacts = artifacts;
  if (Array.isArray(build.logFiles) || typeof build.logFiles === "string") out.logFiles = build.logFiles;
  if (typeof build.logsUrl === "string") out.logsUrl = build.logsUrl;
  if (typeof build.logs === "string") out.logs = build.logs;
  return Object.keys(out).length ? out : null;
}

/**
 * Best-effort: for any file under `.foundry/releases/**` (any run, any filename) that references
 * an `https://expo.dev/.../builds/<id>` URL, ensure there is an `expo-build-view.json` and
 * `expo-build-logs.txt` sibling with the remote build details + full build logs so
 * `feedback_agent` can read the real error on the next loop.
 *
 * Strategy:
 *   1. Try to re-use URLs already embedded in the stored eas-build.log's JSON stdout.
 *   2. Fetch them (they expire ~15 minutes; fail silently if so).
 *   3. If fetching failed or produced no useful content, call `eas build:view <id> --json` to
 *      get freshly signed URLs and retry.
 *
 * Runs at the top of every `foundry loop`. Non-fatal on any error.
 */
export async function backfillExpoBuildViews(repoPath: string, config: FoundryConfig): Promise<void> {
  const debug = process.env.FOUNDRY_DEBUG_EXPO_BACKFILL === "1";
  const log = (msg: string) => {
    if (debug) console.error(`[expo-backfill] ${msg}`);
  };
  try {
    const settings = resolveEasBuildSettings(config);
    const { readdir, stat } = await import("node:fs/promises");
    const releasesRoot = join(repoPath, ".foundry", "releases");
    let runDirs: string[] = [];
    try {
      runDirs = await readdir(releasesRoot);
    } catch {
      log(`no releases dir at ${releasesRoot}`);
      return;
    }
    runDirs = [...runDirs].sort().reverse().slice(0, MAX_EXPO_BACKFILL_RUN_DIRS);
    log(`scanning ${runDirs.length} run dir(s) in ${releasesRoot}`);
    const seenBuildIds = new Set<string>();
    for (const runId of runDirs) {
      const runDir = join(releasesRoot, runId);
      let entries: string[] = [];
      try {
        entries = await readdir(runDir);
      } catch {
        continue;
      }

      const canonicalView = join(runDir, "expo-build-view.json");
      const canonicalLogs = join(runDir, "expo-build-logs.txt");
      const hasView = await fileExists(canonicalView);
      const hasLogs = await fileExists(canonicalLogs);
      if (hasView && hasLogs) continue;

      for (const name of entries) {
        if (!/\.(log|txt|json)$/i.test(name)) continue;
        if (name === "expo-build-view.json" || name === "expo-build-logs.txt") continue;
        const abs = join(runDir, name);
        let size = 0;
        try {
          size = (await stat(abs)).size;
        } catch {
          continue;
        }
        if (size > 4 * 1024 * 1024) continue;
        const text = await readFile(abs, "utf8").catch(() => "");
        if (!text) continue;

        const inlineJson = extractEasBuildJson(text);
        const buildId = buildIdFromJson(inlineJson, text);
        if (!buildId || seenBuildIds.has(buildId)) continue;
        seenBuildIds.add(buildId);

        const inlineUrls = extractExpoBuildLogUrls(inlineJson);
        log(`${runId}/${name}: buildId=${buildId} inlineUrls=${inlineUrls.length}`);
        const remote = await fetchExpoBuildDetails(settings.command, buildId, repoPath, inlineUrls);
        if (!remote) {
          log(`${runId}/${name}: fetchExpoBuildDetails returned null`);
          continue;
        }
        log(
          `${runId}/${name}: got view (${remote.raw.length}b) logs=${remote.remoteLogs?.length ?? 0}b`,
        );
        if (!hasView) await writeFile(canonicalView, remote.raw, "utf8");
        if (!hasLogs && remote.remoteLogs) await writeFile(canonicalLogs, remote.remoteLogs, "utf8");
        break;
      }
    }
  } catch {
    /* backfill is best-effort */
  }
}

let cachedExpoSessionSecret: string | null | undefined;

/** Read Expo's CLI session secret from `~/.expo/state.json`. Memoized. */
async function readExpoSessionSecret(): Promise<string | null> {
  if (cachedExpoSessionSecret !== undefined) return cachedExpoSessionSecret;
  try {
    const { homedir } = await import("node:os");
    const path = `${homedir()}/.expo/state.json`;
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as { auth?: { sessionSecret?: unknown } };
    const secret = parsed?.auth?.sessionSecret;
    cachedExpoSessionSecret = typeof secret === "string" && secret ? secret : null;
  } catch {
    cachedExpoSessionSecret = null;
  }
  return cachedExpoSessionSecret;
}

/**
 * Use Expo's authenticated GraphQL endpoint to fetch a build's full metadata, including
 * freshly-signed `logFiles[]` URLs and `artifacts.xcodeBuildLogsUrl`. Requires the user to be
 * logged in with `eas login` (which writes `sessionSecret` into `~/.expo/state.json`).
 * Best-effort; returns null on any failure.
 */
async function fetchExpoBuildViaGraphQL(buildId: string): Promise<{
  logFiles: string[];
  xcodeLogsUrl: string | null;
  error: { errorCode: string | null; message: string | null; docsUrl: string | null } | null;
  status: string | null;
} | null> {
  const session = await readExpoSessionSecret();
  try {
    const query =
      "query GetBuild($buildId: ID!) { builds { byId(buildId: $buildId) { id status error { errorCode message docsUrl } logFiles artifacts { xcodeBuildLogsUrl buildUrl applicationArchiveUrl } } } }";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch("https://api.expo.dev/graphql", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "user-agent": "foundry-cli/1.0",
          ...(session ? { "expo-session": session } : {}),
        },
        body: JSON.stringify({ query, variables: { buildId } }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: {
        builds?: {
          byId?: {
            id?: string;
            status?: string;
            logFiles?: unknown;
            artifacts?: { xcodeBuildLogsUrl?: unknown };
            error?: { errorCode?: unknown; message?: unknown; docsUrl?: unknown };
          };
        };
      };
    };
    const b = body?.data?.builds?.byId;
    if (!b) return null;
    const logFiles: string[] = [];
    if (Array.isArray(b.logFiles)) for (const u of b.logFiles) if (typeof u === "string") logFiles.push(u);
    else if (typeof b.logFiles === "string") {
      try {
        const p = JSON.parse(b.logFiles);
        if (Array.isArray(p)) for (const u of p) if (typeof u === "string") logFiles.push(u);
      } catch {
        if (/^https?:\/\//i.test(b.logFiles)) logFiles.push(b.logFiles);
      }
    }
    const xcodeLogsUrl =
      typeof b.artifacts?.xcodeBuildLogsUrl === "string" ? b.artifacts.xcodeBuildLogsUrl : null;
    return {
      logFiles,
      xcodeLogsUrl,
      status: typeof b.status === "string" ? b.status : null,
      error: b.error
        ? {
            errorCode: typeof b.error.errorCode === "string" ? b.error.errorCode : null,
            message: typeof b.error.message === "string" ? b.error.message : null,
            docsUrl: typeof b.error.docsUrl === "string" ? b.error.docsUrl : null,
          }
        : null,
    };
  } catch {
    return null;
  }
}

/** Legacy fallback: unauth GraphQL → usually returns null for private projects, kept for symmetry. */
async function tryFetchExpoBuildPageLogs(buildId: string): Promise<string> {
  const result = await fetchExpoBuildViaGraphQL(buildId);
  if (!result) return "";
  const allUrls = [...result.logFiles, ...(result.xcodeLogsUrl ? [result.xcodeLogsUrl] : [])];
  const chunks: string[] = [];
  for (const u of allUrls.slice(0, 6)) {
    const t = await fetchUrlText(u, 30_000, 2 * 1024 * 1024);
    if (t) chunks.push(`=== ${u} ===\n${t}`);
  }
  if (!chunks.length && (result.error?.message || result.status)) {
    chunks.push(
      [
        "(could not fetch raw log files; reporting GraphQL metadata only)",
        `status: ${result.status ?? "unknown"}`,
        result.error?.errorCode ? `error.errorCode: ${result.error.errorCode}` : "",
        result.error?.message ? `error.message: ${result.error.message}` : "",
        result.error?.docsUrl ? `error.docsUrl: ${result.error.docsUrl}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return chunks.join("\n\n");
}

/** Fetch URL text with a short timeout; returns empty string on failure. */
async function fetchUrlText(url: string, timeoutMs = 45_000, maxBytes = 4 * 1024 * 1024): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "user-agent": "foundry-cli/1.0 (+https://github.com/foundry)" },
      });
      if (!res.ok) return "";
      const text = await res.text();
      return text.length > maxBytes ? text.slice(-maxBytes) : text;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return "";
  }
}

function summarizeExpoBuildJson(buildId: string, parsed: Record<string, unknown> | null): string[] {
  if (!parsed) return [`buildId: ${buildId}`, "(could not parse build JSON)"];
  const lines: string[] = [`buildId: ${buildId}`];
  const push = (label: string, v: unknown) => {
    if (v === undefined || v === null || v === "") return;
    lines.push(`${label}: ${String(v).slice(0, 2000)}`);
  };
  push("status", parsed.status);
  push("platform", parsed.platform);
  push("appVersion", parsed.appVersion);
  push("sdkVersion", parsed.sdkVersion);
  const err = parsed.error;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    push("error.errorCode", e.errorCode ?? e.code);
    push("error.message", e.message ?? e.stderr ?? e.stdout);
    push("error.docsUrl", e.docsUrl);
  }
  const artifacts = parsed.artifacts;
  if (artifacts && typeof artifacts === "object") {
    const a = artifacts as Record<string, unknown>;
    push("artifacts.buildUrl", a.buildUrl);
    push("artifacts.xcodeBuildLogsUrl", a.xcodeBuildLogsUrl);
    push("artifacts.buildLogsUrl", a.buildLogsUrl);
  }
  const urls = extractExpoBuildLogUrls(parsed);
  if (urls.length) lines.push(`logUrlCount: ${urls.length}`);
  return lines;
}

/**
 * Fetch every available remote log for this buildId and concatenate them into one text blob
 * that `feedback_agent` can scan. Strategy:
 *   1. If `candidateUrls` is non-empty (taken from the stored `eas build --json` stdout),
 *      try those first — zero CLI calls, fast.
 *   2. If any fetch succeeded, return the concatenated text.
 *   3. Otherwise ask Expo's authenticated GraphQL API for freshly-signed URLs and fetch those.
 *
 * Returns `null` only if we cannot produce any useful metadata at all.
 */
async function fetchExpoBuildDetails(
  easCommand: string,
  buildId: string | undefined,
  cwd: string,
  candidateUrls: string[] = [],
): Promise<{ raw: string; summary: string; remoteLogs?: string } | null> {
  if (!buildId) return null;

  const tryFetchAll = async (urls: string[]): Promise<string> => {
    const out: string[] = [];
    for (const u of urls.slice(0, 6)) {
      const txt = await fetchUrlText(u, 45_000, 2 * 1024 * 1024);
      if (txt && txt.trim()) out.push(`=== ${u} ===\n${txt}`);
    }
    return out.join("\n\n");
  };

  void easCommand;
  void cwd;
  let remoteLogs = candidateUrls.length ? await tryFetchAll(candidateUrls) : "";
  const graphql = await fetchExpoBuildViaGraphQL(buildId);
  let summaryParsed: Record<string, unknown> | null = null;

  if (graphql) {
    summaryParsed = normalizeExpoBuildViewPayload({
      id: buildId,
      status: graphql.status,
      error: graphql.error,
      artifacts: { xcodeBuildLogsUrl: graphql.xcodeLogsUrl },
      logFiles: graphql.logFiles,
    }, buildId);
    if (!remoteLogs) {
      const freshUrls = [...graphql.logFiles, ...(graphql.xcodeLogsUrl ? [graphql.xcodeLogsUrl] : [])];
      if (freshUrls.length) remoteLogs = await tryFetchAll(freshUrls);
    }
    if (!remoteLogs && (graphql.error?.message || graphql.status)) {
      remoteLogs = [
        "(could not fetch raw log files; reporting GraphQL metadata only)",
        `status: ${graphql.status ?? "unknown"}`,
        graphql.error?.errorCode ? `error.errorCode: ${graphql.error.errorCode}` : "",
        graphql.error?.message ? `error.message: ${graphql.error.message}` : "",
        graphql.error?.docsUrl ? `error.docsUrl: ${graphql.error.docsUrl}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
  }

  const summaryLines = summarizeExpoBuildJson(buildId, summaryParsed);
  summaryLines.push(
    remoteLogs ? `remoteLogsBytes: ${remoteLogs.length}` : "remoteLogsBytes: 0 (fetch failed)",
  );
  if (!graphql && !(await readExpoSessionSecret())) {
    summaryLines.push(
      "note: no ~/.expo/state.json sessionSecret found; some log URLs may 403. Run `eas login` to authenticate.",
    );
  }

  const raw = JSON.stringify(
    normalizeExpoBuildViewPayload(summaryParsed, buildId) ?? {
      id: buildId,
      status: graphql?.status ?? "UNKNOWN",
      error: graphql?.error ?? {
        errorCode: "FETCH_FAILED",
        message: "Foundry could not fetch normalized Expo build metadata.",
      },
    },
    null,
    2,
  );

  if (!summaryParsed && !remoteLogs) return null;
  return { raw, summary: summaryLines.join("\n"), remoteLogs: remoteLogs || undefined };
}

export async function maybeSubmitLatestToTestFlight(
  repoPath: string,
  config: FoundryConfig,
  manifest: RunManifest,
  releaseStatus: string | undefined,
): Promise<TestFlightSubmitResult> {
  const settings = resolveEasBuildSettings(config);
  if (!isEasEligibleConfig(config)) {
    return { status: "skipped", detail: "TestFlight submission skipped: project repo_type is not mobile/Expo." };
  }
  if (releaseStatus !== "approved" && releaseStatus !== "auto_approved") {
    return { status: "skipped", detail: "Release is not approved yet." };
  }
  if (settings.platform === "android") {
    return { status: "skipped", detail: "TestFlight submission only applies to iOS builds." };
  }

  const releaseDir = join(repoPath, ".foundry", "releases", manifest.runId);
  const artifactPath = join(releaseDir, "testflight-submit.json");
  const logPath = join(releaseDir, "testflight-submit.log");
  await mkdir(releaseDir, { recursive: true });

  const persist = async (result: TestFlightSubmitResult, stdout = "", stderr = ""): Promise<TestFlightSubmitResult> => {
    const log = [
      `status: ${result.status}`,
      `detail: ${result.detail}`,
      result.submissionId ? `submissionId: ${result.submissionId}` : "",
      "",
      "=== STDOUT ===",
      stdout,
      "",
      "=== STDERR ===",
      stderr,
    ]
      .filter(Boolean)
      .join("\n");
    await writeFile(logPath, log, "utf8");
    const withPaths = { ...result, logPath, artifactPath };
    await writeFile(artifactPath, JSON.stringify(withPaths, null, 2), "utf8");
    return withPaths;
  };

  if (await fileExists(artifactPath)) {
    try {
      const raw = await readFile(artifactPath, "utf8");
      const prior = JSON.parse(raw) as Partial<TestFlightSubmitResult>;
      return {
        status: "already_started",
        detail: typeof prior.detail === "string" ? prior.detail : "TestFlight submit already recorded for this run.",
        logPath,
        artifactPath,
        submissionId: typeof prior.submissionId === "string" ? prior.submissionId : undefined,
      };
    } catch {
      return {
        status: "already_started",
        detail: "TestFlight submit artifact already exists for this run.",
        logPath,
        artifactPath,
      };
    }
  }

  const availability = await exec(easCommandWithArgs(settings.command, ["--version"]), repoPath, 15_000);
  if (availability.exitCode !== 0) {
    return persist(
      {
        status: "failed",
        detail: `EAS CLI '${settings.command}' is not available from the Foundry shell.`,
      },
      availability.stdout,
      availability.stderr,
    );
  }

  const auth = await exec(easCommandWithArgs(settings.command, ["whoami"]), repoPath, 15_000);
  if (auth.exitCode !== 0) {
    return persist(
      {
        status: "failed",
        detail: `EAS CLI '${settings.command}' is available, but not authenticated.`,
      },
      auth.stdout,
      auth.stderr,
    );
  }

  const args = [
    "submit",
    "--platform",
    "ios",
    "--latest",
    "--json",
  ];
  if (settings.nonInteractive) args.push("--non-interactive");

  const result = await exec(easCommandWithArgs(settings.command, args), repoPath, 10 * 60_000);
  let submissionId: string | undefined;
  const lines = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    const line = lines[idx];
    if (!(line.startsWith("{") || line.startsWith("["))) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        if (typeof obj.id === "string") {
          submissionId = obj.id;
          break;
        }
      }
    } catch {
      /* ignore parse errors */
    }
    if (submissionId) break;
  }

  return persist(
    {
      status: result.exitCode === 0 ? "started" : "failed",
      detail:
        result.exitCode === 0
          ? "TestFlight submission started from the latest available iOS EAS build."
          : "TestFlight submission command failed.",
      submissionId,
    },
    result.stdout,
    result.stderr,
  );
}
