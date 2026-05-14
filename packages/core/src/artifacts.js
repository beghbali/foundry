import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
/** Absolute path to a stage folder under the current run (prefixed for sort order). */
export function stageOutDir(ctx, stageName) {
    const idx = ctx.stageIndex?.(stageName) ?? -1;
    const prefix = idx >= 0 ? String(idx).padStart(2, "0") : "99";
    return join(ctx.outDir, `${prefix}_${stageName}`);
}
export async function writeStageJson(ctx, stageName, filename, data) {
    const dir = stageOutDir(ctx, stageName);
    await mkdir(dir, { recursive: true });
    const text = JSON.stringify(data, null, 2);
    await writeFile(join(dir, filename), text, "utf8");
}
export async function writeStageMarkdown(ctx, stageName, filename, md) {
    const dir = stageOutDir(ctx, stageName);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), md, "utf8");
}
/**
 * Read a file from the most recent run under .foundry/out/<runId>/...
 * artifactRelativePath is relative to each run directory, e.g. feedback_agent/output.json
 */
export async function readLatestArtifact(repoPath, artifactRelativePath) {
    const outRoot = join(repoPath, ".foundry", "out");
    let entries;
    try {
        entries = await readdir(outRoot);
    }
    catch {
        return undefined;
    }
    const runDirs = [];
    for (const name of entries) {
        const p = join(outRoot, name);
        try {
            const s = await stat(p);
            if (s.isDirectory())
                runDirs.push(name);
        }
        catch {
            /* skip */
        }
    }
    // ISO run ids sort lexicographically in time order; latest last.
    runDirs.sort((a, b) => b.localeCompare(a));
    for (const runId of runDirs) {
        const file = join(outRoot, runId, artifactRelativePath);
        try {
            return await readFile(file, "utf8");
        }
        catch {
            const parts = artifactRelativePath.split(/[\\/]/).filter(Boolean);
            if (parts.length >= 2) {
                const [stageName, ...rest] = parts;
                try {
                    const entries = await readdir(join(outRoot, runId));
                    const prefixed = entries.find((name) => name.endsWith(`_${stageName}`));
                    if (prefixed) {
                        return await readFile(join(outRoot, runId, prefixed, ...rest), "utf8");
                    }
                }
                catch {
                    /* try older run */
                }
            }
        }
    }
    return undefined;
}
