import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const execFileAsync = promisify(execFile);
const CACHE_VERSION = 1;
const CACHE_FILENAME = ".pipeline-stage-cache.json";
const GENERATED_FOUNDRY_PATHS = new Set([
    ".foundry/.pipeline-stage-cache.json",
    ".foundry/APPROVAL_REQUIRED.md",
    ".foundry/feedback-ledger.json",
    ".foundry/LATEST_INSTALL.md",
    ".foundry/CURSOR_BRIEF.md",
    ".foundry/CURSOR_BUILDER_REPORT.md",
    ".foundry/CURSOR_QA_REPORT.md",
    ".foundry/WORK_PACKET.json",
    ".foundry/WORK_PACKET.md",
]);
const GENERATED_FOUNDRY_PREFIXES = [
    ".foundry/out/",
    ".foundry/automation/",
    ".foundry/releases/",
    ".foundry/approvals/",
];
/** Keys dropped when fingerprinting stage inputs (timestamps / run metadata). */
const VOLATILE_INPUT_KEYS = new Set([
    "generatedAt",
    "startedAt",
    "finishedAt",
    "collectedAt",
    "runId",
    "stub",
]);
export const STAGES_ELIGIBLE_FOR_REUSE = ["builder", "independent_qa"];
export function isStageReuseEnabled() {
    return process.env.FOUNDRY_DISABLE_STAGE_REUSE !== "true";
}
function cachePath(repoPath) {
    return join(repoPath, ".foundry", CACHE_FILENAME);
}
function normalizePorcelainPath(path) {
    return path.replace(/\\/g, "/").trim().replace(/^"|"$/g, "");
}
function pathFromPorcelainLine(line) {
    const trimmed = line.trim();
    const rawPath = trimmed.slice(3).trim();
    const renameArrow = rawPath.lastIndexOf(" -> ");
    return normalizePorcelainPath(renameArrow >= 0 ? rawPath.slice(renameArrow + 4) : rawPath);
}
function isGeneratedFoundryPath(path) {
    const normalized = normalizePorcelainPath(path);
    if (GENERATED_FOUNDRY_PATHS.has(normalized))
        return true;
    return GENERATED_FOUNDRY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
export async function computeRepoFingerprint(repoPath) {
    try {
        const { stdout: headOut } = await execFileAsync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
            encoding: "utf8",
        });
        const { stdout: porcOut } = await execFileAsync("git", ["-C", repoPath, "status", "--porcelain"], { encoding: "utf8" });
        const head = headOut.trim();
        const porc = porcOut
            .split(/\r?\n/)
            .filter(Boolean)
            .filter((line) => !isGeneratedFoundryPath(pathFromPorcelainLine(line)))
            .sort()
            .join("\n");
        return createHash("sha256").update(`${head}\n${porc}`).digest("hex");
    }
    catch {
        return createHash("sha256").update(`nogit:${repoPath}`).digest("hex");
    }
}
function stripVolatileForFingerprint(value) {
    if (value === null || typeof value !== "object")
        return value;
    if (Array.isArray(value))
        return value.map(stripVolatileForFingerprint);
    const o = value;
    const out = {};
    for (const key of Object.keys(o).sort()) {
        if (VOLATILE_INPUT_KEYS.has(key))
            continue;
        out[key] = stripVolatileForFingerprint(o[key]);
    }
    return out;
}
export function fingerprintStageInput(repoFingerprint, input) {
    const stable = stripVolatileForFingerprint(input);
    const body = JSON.stringify(stable);
    return createHash("sha256").update(`${repoFingerprint}\n${body}`).digest("hex");
}
async function readCache(repoPath) {
    try {
        const raw = await readFile(cachePath(repoPath), "utf8");
        const parsed = JSON.parse(raw);
        if (parsed?.version !== CACHE_VERSION || typeof parsed.entries !== "object" || !parsed.entries) {
            return undefined;
        }
        return parsed;
    }
    catch {
        return undefined;
    }
}
async function writeCache(repoPath, file) {
    const abs = cachePath(repoPath);
    const next = JSON.stringify(file, null, 2);
    try {
        const current = await readFile(abs, "utf8");
        if (current === next)
            return;
    }
    catch {
        // File missing or unreadable: write it below.
    }
    await writeFile(abs, next, "utf8");
}
function outputEligibleForCache(stageName, output) {
    if (!output || typeof output !== "object")
        return false;
    const o = output;
    if (stageName === "builder") {
        const s = o.status;
        return s === "ok" || s === "partial";
    }
    if (stageName === "independent_qa") {
        return o.recommendation === "ship";
    }
    return false;
}
export function cachedOutputIsReusable(stageName, output) {
    return outputEligibleForCache(stageName, output);
}
export async function tryGetReusableStageOutput(repoPath, stageName, inputFingerprint) {
    const cache = await readCache(repoPath);
    const entry = cache?.entries?.[stageName];
    if (!entry || entry.inputFingerprint !== inputFingerprint)
        return undefined;
    if (!cachedOutputIsReusable(stageName, entry.output))
        return undefined;
    return entry.output;
}
export async function rememberStageOutput(repoPath, stageName, inputFingerprint, output) {
    if (!outputEligibleForCache(stageName, output))
        return;
    const prev = (await readCache(repoPath)) ?? { version: CACHE_VERSION, entries: {} };
    prev.entries = { ...prev.entries, [stageName]: { inputFingerprint, output } };
    await writeCache(repoPath, prev);
}
