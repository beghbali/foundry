import { run } from "./exec.js";

export interface GitStatus {
  clean: boolean;
  porcelain: string;
  branch: string;
  headSha: string;
  rawPorcelain: string;
  ignoredGeneratedPorcelain: string;
  hasOnlyGeneratedChanges: boolean;
}

const GENERATED_FOUNDRY_PATHS = [
  ".foundry/.pipeline-stage-cache.json",
  ".foundry/APPROVAL_REQUIRED.md",
  ".foundry/feedback-ledger.json",
  ".foundry/LATEST_INSTALL.md",
  ".foundry/resolver-domains.json",
  ".foundry/CURSOR_BRIEF.md",
  ".foundry/CURSOR_BUILDER_REPORT.md",
  ".foundry/CURSOR_QA_REPORT.md",
  ".foundry/WORK_PACKET.json",
  ".foundry/WORK_PACKET.md",
];

const GENERATED_FOUNDRY_PREFIXES = [
  ".foundry/out/",
  ".foundry/automation/",
  ".foundry/releases/",
  ".foundry/approvals/",
  ".foundry/approval/",
];

function normalizePathFromPorcelain(path: string): string {
  return path.replace(/\\/g, "/").trim().replace(/^"|"$/g, "");
}

function isGeneratedFoundryPath(path: string): boolean {
  const normalized = normalizePathFromPorcelain(path);
  if (GENERATED_FOUNDRY_PATHS.includes(normalized)) return true;
  return GENERATED_FOUNDRY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Parse one line from `git status --porcelain=1`.
 * Returns undefined for unsupported/noise lines.
 */
function pathFromPorcelainLine(line: string): string | undefined {
  const trimmed = line.trimEnd();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  if (trimmed.length < 4) return undefined;
  const sep = trimmed[2];
  if (sep !== " " && sep !== "\t") return undefined;
  let rawPath = trimmed.slice(3).trim();
  if (!rawPath) return undefined;
  const renameArrow = rawPath.lastIndexOf(" -> ");
  if (renameArrow >= 0) rawPath = rawPath.slice(renameArrow + 4).trim();
  return normalizePathFromPorcelain(rawPath);
}

export async function status(cwd: string): Promise<GitStatus> {
  const [porcelainResult, branchResult, shaResult] = await Promise.all([
    run("git", ["status", "--porcelain=1"], cwd),
    run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    run("git", ["rev-parse", "HEAD"], cwd),
  ]);

  const rawPorcelain = porcelainResult.stdout.trim();
  const lines = rawPorcelain ? rawPorcelain.split("\n").filter(Boolean) : [];
  const parsed = lines.map((line) => ({ line, path: pathFromPorcelainLine(line) })).filter((x) => Boolean(x.path));
  const relevant = parsed.filter((x) => !isGeneratedFoundryPath(x.path!)).map((x) => x.line);
  const ignoredGenerated = parsed.filter((x) => isGeneratedFoundryPath(x.path!)).map((x) => x.line);
  const porcelain = relevant.join("\n").trim();

  return {
    clean: porcelain === "",
    porcelain,
    branch: branchResult.stdout.trim() || "unknown",
    headSha: shaResult.stdout.trim().slice(0, 12),
    rawPorcelain,
    ignoredGeneratedPorcelain: ignoredGenerated.join("\n").trim(),
    hasOnlyGeneratedChanges: porcelain === "" && rawPorcelain !== "",
  };
}

export async function createBranch(cwd: string, name: string): Promise<boolean> {
  const result = await run("git", ["checkout", "-b", name], cwd);
  return result.exitCode === 0;
}

export async function checkoutBranch(cwd: string, name: string): Promise<boolean> {
  const result = await run("git", ["checkout", name], cwd);
  return result.exitCode === 0;
}

export async function branchExists(cwd: string, name: string): Promise<boolean> {
  const result = await run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], cwd);
  return result.exitCode === 0;
}

export async function ensureBranch(cwd: string, name: string): Promise<{ ok: boolean; created: boolean }> {
  const current = await status(cwd);
  if (current.branch === name) return { ok: true, created: false };
  if (await branchExists(cwd, name)) {
    return { ok: await checkoutBranch(cwd, name), created: false };
  }
  return { ok: await createBranch(cwd, name), created: true };
}

export async function addAll(cwd: string): Promise<boolean> {
  const result = await run("git", ["add", "-A"], cwd);
  return result.exitCode === 0;
}

export async function commit(cwd: string, message: string): Promise<{ ok: boolean; sha?: string }> {
  const result = await run("git", ["commit", "-m", message], cwd);
  if (result.exitCode !== 0) return { ok: false };
  const shaResult = await run("git", ["rev-parse", "HEAD"], cwd);
  return { ok: true, sha: shaResult.stdout.trim().slice(0, 12) };
}

export async function diff(cwd: string): Promise<{ filesChanged: string[]; filesAdded: string[]; filesDeleted: string[] }> {
  const result = await run("git", ["status", "--porcelain=1"], cwd);
  const filesChanged: string[] = [];
  const filesAdded: string[] = [];
  const filesDeleted: string[] = [];

  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const file = pathFromPorcelainLine(trimmed);
    if (!file) continue;
    if (isGeneratedFoundryPath(file)) continue;
    const code = trimmed.slice(0, 2).trim();
    if (code === "??" || code === "A") filesAdded.push(file);
    else if (code === "D") filesDeleted.push(file);
    else filesChanged.push(file);
  }

  return { filesChanged, filesAdded, filesDeleted };
}

export async function relevantPaths(cwd: string): Promise<string[]> {
  const s = await status(cwd);
  if (!s.porcelain) return [];
  return s.porcelain
    .split("\n")
    .filter(Boolean)
    .map((line) => pathFromPorcelainLine(line))
    .filter((p): p is string => Boolean(p));
}

export async function addRelevant(cwd: string): Promise<boolean> {
  const paths = await relevantPaths(cwd);
  if (paths.length === 0) return true;
  const targeted = await run("git", ["add", "-A", "--", ...paths], cwd);
  if (targeted.exitCode === 0) return true;
  // Some repos expose edge cases where path-targeted staging fails (quoted paths, ignored transitions,
  // deletes/renames across generated state). Fall back to broad staging; later diff/commit logic still
  // ignores generated `.foundry` artifacts for release semantics.
  const fallback = await run("git", ["add", "-A"], cwd);
  return fallback.exitCode === 0;
}

export async function pushBranch(cwd: string, name: string): Promise<boolean> {
  const result = await run("git", ["push", "-u", "origin", name], cwd, 120_000);
  return result.exitCode === 0;
}

export async function hasRemote(cwd: string): Promise<{ hasGithub: boolean; remote?: string }> {
  const result = await run("git", ["remote", "-v"], cwd);
  const lines = result.stdout.trim();
  const ghMatch = /origin\s+(https:\/\/github\.com\/[^\s]+|git@github\.com:[^\s]+)/m.exec(lines);
  if (ghMatch) return { hasGithub: true, remote: ghMatch[1] };
  return { hasGithub: false };
}

export async function switchBack(cwd: string, branch: string): Promise<void> {
  await run("git", ["checkout", branch], cwd);
}
