import { stat } from "node:fs/promises";
import { join } from "node:path";

import { sh, type ExecResult } from "./exec.js";

export interface CleanupResult {
  cmd: string;
  ok: boolean;
  exitCode: number;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function hasScript(cwd: string, name: string): Promise<boolean> {
  const pkgPath = join(cwd, "package.json");
  if (!(await fileExists(pkgPath))) return false;
  try {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    return typeof pkg.scripts?.[name] === "string";
  } catch {
    return false;
  }
}

async function detectRunner(cwd: string): Promise<"pnpm" | "npm" | "yarn"> {
  if (await fileExists(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * Run available quality scripts in the target repo. Returns results for each.
 */
export async function runQualityChecks(cwd: string): Promise<CleanupResult[]> {
  const results: CleanupResult[] = [];
  const runner = await detectRunner(cwd);
  const runCmd = runner === "npm" ? "npm run" : runner;

  const checks: Array<{ script: string; label: string }> = [
    { script: "lint", label: `${runCmd} lint` },
    { script: "typecheck", label: `${runCmd} typecheck` },
    { script: "test", label: `${runCmd} test` },
    { script: "prettier:check", label: `${runCmd} prettier:check` },
    { script: "fmt:check", label: `${runCmd} fmt:check` },
  ];

  for (const { script, label } of checks) {
    if (await hasScript(cwd, script)) {
      const r = await sh(`${runCmd} ${script}`, cwd, 120_000);
      results.push({ cmd: label, ok: r.exitCode === 0, exitCode: r.exitCode });
    }
  }

  return results;
}

/**
 * Best-effort formatting and unused-import cleanup.
 */
export async function tidyCode(cwd: string): Promise<CleanupResult[]> {
  const results: CleanupResult[] = [];
  const runner = await detectRunner(cwd);

  if (await hasScript(cwd, "lint:fix")) {
    const r = await sh(`${runner === "npm" ? "npm run" : runner} lint:fix`, cwd, 60_000);
    results.push({ cmd: `${runner} lint:fix`, ok: r.exitCode === 0, exitCode: r.exitCode });
  } else if (await hasScript(cwd, "lint")) {
    const r = await sh(`${runner === "npm" ? "npx" : runner === "pnpm" ? "pnpm exec" : "yarn"} eslint . --fix 2>/dev/null`, cwd, 60_000);
    results.push({ cmd: "eslint --fix (best effort)", ok: r.exitCode === 0, exitCode: r.exitCode });
  }

  if (await hasScript(cwd, "format")) {
    const r = await sh(`${runner === "npm" ? "npm run" : runner} format`, cwd, 60_000);
    results.push({ cmd: `${runner} format`, ok: r.exitCode === 0, exitCode: r.exitCode });
  }

  return results;
}
