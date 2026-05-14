import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { writeStageMarkdown } from "@foundry/core/artifacts";
import { StageInputCompositionSchema } from "@foundry/core/stageInputs";
import { z } from "zod";
const MAX_TREE = 2000;
const IGNORE_DIR_NAMES = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".expo",
    ".turbo",
]);
export const RepoInventoryOutputSchema = z.object({
    repoPath: z.string(),
    generatedAt: z.string(),
    summary: z.object({
        repoTypeGuess: z.enum(["expo_rn", "node", "python", "unknown"]),
        hasSupabase: z.boolean(),
        hasExpo: z.boolean(),
        hasEas: z.boolean(),
        languages: z.array(z.string()),
    }),
    tree: z.array(z.object({
        path: z.string(),
        type: z.enum(["file", "dir"]),
        size: z.number().optional(),
    })),
    keyFiles: z.object({
        packageJsonPaths: z.array(z.string()),
        expoConfigPaths: z.array(z.string()),
        easJsonPaths: z.array(z.string()),
        supabaseDir: z.string().optional(),
        readmePaths: z.array(z.string()),
    }),
    detected: z.object({
        mobileAppDir: z.string().optional(),
        supabaseDir: z.string().optional(),
        rulesEngineDir: z.string().optional(),
    }),
});
function toPosix(rel) {
    return rel.split(sep).join("/");
}
function relFromRepo(repoPath, absPath) {
    return toPosix(relative(repoPath, absPath));
}
function shouldSkipDir(relPosix) {
    const parts = relPosix.split("/").filter(Boolean);
    if (parts[0] === ".foundry" && parts[1] === "out")
        return true;
    return parts.some((p) => IGNORE_DIR_NAMES.has(p));
}
const EXT_LANG = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "kotlin",
    ".swift": "swift",
    ".md": "markdown",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".css": "css",
    ".scss": "scss",
    ".html": "html",
};
function langFromFileName(fileName) {
    const lower = fileName.toLowerCase();
    const dot = lower.lastIndexOf(".");
    if (dot === -1)
        return undefined;
    return EXT_LANG[lower.slice(dot)] ?? undefined;
}
function isExpoConfigFile(baseName) {
    const b = baseName.toLowerCase();
    if (b === "app.json")
        return true;
    if (b.startsWith("app.config.") && /\.(js|ts|mjs|cjs)$/.test(b))
        return true;
    return false;
}
async function readJsonSafe(path) {
    try {
        const raw = await readFile(path, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
async function hasExpoInPackageJson(repoPath, relPath) {
    const data = await readJsonSafe(join(repoPath, relPath));
    if (!data)
        return false;
    const merge = (o) => typeof o === "object" && o !== null ? o : {};
    const deps = {
        ...merge(data.dependencies),
        ...merge(data.devDependencies),
        ...merge(data.peerDependencies),
    };
    return "expo" in deps;
}
async function pathIsDir(abs) {
    try {
        return (await stat(abs)).isDirectory();
    }
    catch {
        return false;
    }
}
export async function scanRepo(repoPath) {
    const generatedAt = new Date().toISOString();
    const tree = [];
    const languages = new Set();
    const packageJsonPaths = [];
    const expoConfigPaths = [];
    const easJsonPaths = [];
    const readmePaths = [];
    let supabaseDirFromConfig;
    const queue = [repoPath];
    while (queue.length) {
        const absDir = queue.shift();
        const dirRel = relFromRepo(repoPath, absDir);
        const dirPosix = dirRel || "";
        if (dirPosix && shouldSkipDir(dirPosix))
            continue;
        let entries;
        try {
            entries = await readdir(absDir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const ent of entries) {
            const absChild = join(absDir, ent.name);
            const childRel = relFromRepo(repoPath, absChild);
            const posix = childRel;
            if (ent.isDirectory()) {
                if (shouldSkipDir(posix))
                    continue;
                if (tree.length < MAX_TREE) {
                    tree.push({ path: posix, type: "dir" });
                }
                queue.push(absChild);
                continue;
            }
            if (!ent.isFile())
                continue;
            if (tree.length < MAX_TREE) {
                let size;
                try {
                    size = (await stat(absChild)).size;
                }
                catch {
                    size = undefined;
                }
                tree.push({ path: posix, type: "file", size });
            }
            const base = ent.name;
            const lang = langFromFileName(base);
            if (lang)
                languages.add(lang);
            const lower = base.toLowerCase();
            if (lower === "package.json")
                packageJsonPaths.push(posix);
            if (lower === "eas.json")
                easJsonPaths.push(posix);
            if (/^readme\.md$/i.test(base))
                readmePaths.push(posix);
            if (posix === "supabase/config.toml" || posix.endsWith("/supabase/config.toml")) {
                const idx = posix.indexOf("/supabase/config.toml");
                supabaseDirFromConfig = idx === -1 ? "supabase" : posix.slice(0, idx + "/supabase".length);
            }
            if (isExpoConfigFile(base))
                expoConfigPaths.push(posix);
        }
    }
    const hasSupabaseFolder = await pathIsDir(join(repoPath, "supabase"));
    const keyFilesSupabaseDir = supabaseDirFromConfig ?? (hasSupabaseFolder ? "supabase" : undefined);
    let hasExpo = expoConfigPaths.length > 0 ||
        easJsonPaths.length > 0 ||
        (await hasExpoInPackageJson(repoPath, "package.json"));
    if (!hasExpo) {
        for (const p of packageJsonPaths) {
            if (await hasExpoInPackageJson(repoPath, p)) {
                hasExpo = true;
                break;
            }
        }
    }
    const hasEas = easJsonPaths.length > 0;
    const hasSupabase = hasSupabaseFolder || supabaseDirFromConfig !== undefined;
    async function fileExists(rel) {
        try {
            return (await stat(join(repoPath, rel))).isFile();
        }
        catch {
            return false;
        }
    }
    const hasPythonRoot = (await fileExists("pyproject.toml")) ||
        (await fileExists("requirements.txt")) ||
        (await fileExists("Pipfile")) ||
        (await fileExists("setup.py"));
    let repoTypeGuess = "unknown";
    if (hasExpo)
        repoTypeGuess = "expo_rn";
    else if (hasPythonRoot || languages.has("python"))
        repoTypeGuess = "python";
    else if (packageJsonPaths.length > 0)
        repoTypeGuess = "node";
    const detected = {};
    if (await pathIsDir(join(repoPath, "apps", "mobile")))
        detected.mobileAppDir = "apps/mobile";
    if (hasSupabaseFolder)
        detected.supabaseDir = "supabase";
    if (await pathIsDir(join(repoPath, "packages", "rules-engine")))
        detected.rulesEngineDir = "packages/rules-engine";
    return {
        repoPath,
        generatedAt,
        summary: {
            repoTypeGuess,
            hasSupabase,
            hasExpo,
            hasEas,
            languages: [...languages].sort(),
        },
        tree,
        keyFiles: {
            packageJsonPaths: [...new Set(packageJsonPaths)].sort(),
            expoConfigPaths: [...new Set(expoConfigPaths)].sort(),
            easJsonPaths: [...new Set(easJsonPaths)].sort(),
            supabaseDir: keyFilesSupabaseDir,
            readmePaths: [...new Set(readmePaths)].sort(),
        },
        detected,
    };
}
function buildReadme(output, projectName) {
    const s = output.summary;
    const lines = [
        "# Repo inventory",
        "",
        `**Project:** ${projectName}`,
        `**Repo path:** \`${output.repoPath}\``,
        `**Generated:** ${output.generatedAt}`,
        "",
        "## Detected summary",
        "",
        `- **Inferred stack:** \`${s.repoTypeGuess}\``,
        `- **Expo:** ${s.hasExpo ? "yes" : "no"} | **EAS:** ${s.hasEas ? "yes" : "no"} | **Supabase:** ${s.hasSupabase ? "yes" : "no"}`,
        `- **Languages (sample):** ${s.languages.length ? s.languages.join(", ") : "(none sampled)"}`,
        `- **Tree entries recorded:** ${output.tree.length} (cap ${MAX_TREE})`,
        "",
        "### Key paths",
        "",
        `- **package.json:** ${output.keyFiles.packageJsonPaths.length} file(s)`,
        `- **Expo config:** ${output.keyFiles.expoConfigPaths.length} file(s)`,
        `- **EAS:** ${output.keyFiles.easJsonPaths.length} file(s)`,
        `- **README:** ${output.keyFiles.readmePaths.length} file(s)`,
    ];
    if (output.keyFiles.supabaseDir) {
        lines.push(`- **Supabase dir:** \`${output.keyFiles.supabaseDir}\``);
    }
    lines.push("", "## Detected roots", "");
    const d = output.detected;
    if (d.mobileAppDir)
        lines.push(`- **Mobile app:** \`${d.mobileAppDir}\``);
    if (d.supabaseDir)
        lines.push(`- **Supabase:** \`${d.supabaseDir}\``);
    if (d.rulesEngineDir)
        lines.push(`- **Rules engine:** \`${d.rulesEngineDir}\``);
    if (!d.mobileAppDir && !d.supabaseDir && !d.rulesEngineDir)
        lines.push("- _(none of the common roots detected)_");
    lines.push("", "## Next stage inputs (suggestions)", "");
    lines.push("- **market_gap_analysis:** Use `config.project` north star + differentiators; cross-check stack (`repoTypeGuess`) and whether mobile/Supabase are in play.");
    if (s.hasExpo || s.repoTypeGuess === "expo_rn") {
        lines.push("- **product_definition / builder:** Prefer `keyFiles.expoConfigPaths` and root `package.json` for app id, plugins, and native module needs.");
    }
    if (s.hasSupabase) {
        lines.push("- **builder / release:** Plan migrations and env using `keyFiles.supabaseDir` / `detected.supabaseDir` and `gates` for prod approval.");
    }
    if (output.keyFiles.packageJsonPaths.length > 1) {
        lines.push("- **independent_qa:** Monorepo — run tests per workspace `package.json` paths listed in `keyFiles.packageJsonPaths`.");
    }
    lines.push("- **feedback_agent:** Uses composed `feedback` from prior runs when present; see `repo_inventory` tree for docs and support paths.");
    return lines.join("\n") + "\n";
}
export const repoInventoryStage = {
    name: "repo_inventory",
    description: "Scan the target repository (respecting ignore rules) and record structure, stack signals, and key files.",
    inputSchema: StageInputCompositionSchema,
    outputSchema: RepoInventoryOutputSchema,
    async run(ctx, input) {
        const projectName = input.config.project.project_name;
        const configuredRepoType = input.config.project.repo_type.toLowerCase();
        ctx.logger("[repo_inventory] scanning", { repoPath: ctx.repoPath });
        const output = await scanRepo(ctx.repoPath);
        if (/^(web_data_platform|web_app|node|python|enterprise)/i.test(configuredRepoType)) {
            output.summary.hasExpo = false;
            if (output.summary.repoTypeGuess === "expo_rn") {
                output.summary.repoTypeGuess = output.keyFiles.packageJsonPaths.length > 0 ? "node" : "unknown";
            }
            delete output.detected.mobileAppDir;
        }
        const validated = RepoInventoryOutputSchema.parse(output);
        await writeStageMarkdown(ctx, "repo_inventory", "README.md", buildReadme(validated, projectName));
        return validated;
    },
};
