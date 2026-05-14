import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RunContext } from "./types.js";

/** Absolute path to a stage folder under the current run (prefixed for sort order). */
export function stageOutDir(ctx: RunContext, stageName: string): string {
  const idx = ctx.stageIndex?.(stageName) ?? -1;
  const prefix = idx >= 0 ? String(idx).padStart(2, "0") : "99";
  return join(ctx.outDir, `${prefix}_${stageName}`);
}

export async function writeStageJson(
  ctx: RunContext,
  stageName: string,
  filename: string,
  data: unknown,
): Promise<void> {
  const dir = stageOutDir(ctx, stageName);
  await mkdir(dir, { recursive: true });
  const text = JSON.stringify(data, null, 2);
  await writeFile(join(dir, filename), text, "utf8");
}

export async function writeStageMarkdown(
  ctx: RunContext,
  stageName: string,
  filename: string,
  md: string,
): Promise<void> {
  const dir = stageOutDir(ctx, stageName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), md, "utf8");
}

/**
 * Read a file from the most recent run under .foundry/out/<runId>/...
 * artifactRelativePath is relative to each run directory, e.g. feedback_agent/output.json
 */
export async function readLatestArtifact(
  repoPath: string,
  artifactRelativePath: string,
): Promise<string | undefined> {
  const outRoot = join(repoPath, ".foundry", "out");
  let entries: string[];
  try {
    entries = await readdir(outRoot);
  } catch {
    return undefined;
  }

  const runDirs: string[] = [];
  for (const name of entries) {
    const p = join(outRoot, name);
    try {
      const s = await stat(p);
      if (s.isDirectory()) runDirs.push(name);
    } catch {
      /* skip */
    }
  }

  // ISO run ids sort lexicographically in time order; latest last.
  runDirs.sort((a, b) => b.localeCompare(a));

  for (const runId of runDirs) {
    const file = join(outRoot, runId, artifactRelativePath);
    try {
      return await readFile(file, "utf8");
    } catch {
      const parts = artifactRelativePath.split(/[\\/]/).filter(Boolean);
      if (parts.length >= 2) {
        const [stageName, ...rest] = parts;
        try {
          const entries = await readdir(join(outRoot, runId));
          const prefixed = entries.find((name) => name.endsWith(`_${stageName}`));
          if (prefixed) {
            return await readFile(join(outRoot, runId, prefixed, ...rest), "utf8");
          }
        } catch {
          /* try older run */
        }
      }
    }
  }

  return undefined;
}
