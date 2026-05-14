import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";

import { writeStageMarkdown } from "@foundry/core/artifacts";
import { StageInputCompositionSchema, type StageInputComposition } from "@foundry/core/stageInputs";
import type { RunContext, Stage } from "@foundry/core/types";
import { z } from "zod";

const MAX_FILE_BYTES = 1_048_576; // 1 MB
const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);
const SQL_EXTS = new Set([".sql"]);

// ---------- output schema ----------

export const CurrentStateAuditOutputSchema = z.object({
  detectedApp: z.object({
    mobileRoot: z.string().optional(),
    webRoot: z.string().optional(),
    backendRoot: z.string().optional(),
    dataRoots: z.array(z.string()).optional(),
    cloudRoots: z.array(z.string()).optional(),
    language: z.enum(["ts", "js", "mixed"]),
    packageManager: z.enum(["pnpm", "npm", "yarn"]).optional(),
  }),
  navigation: z.object({
    routes: z.array(z.object({ name: z.string(), file: z.string() })),
    navigators: z.array(z.object({ file: z.string(), kind: z.enum(["stack", "tabs", "unknown"]) })),
  }),
  screens: z.array(
    z.object({
      name: z.string(),
      file: z.string(),
      purposeGuess: z.string(),
      keyActions: z.array(z.string()),
    }),
  ),
  apiSurface: z.object({
    edgeFunctions: z.array(z.object({ name: z.string(), path: z.string() })),
    endpoints: z.array(z.object({ function: z.string(), method: z.string(), route: z.string() })),
  }),
  dataModel: z.object({
    migrations: z.array(z.object({ file: z.string(), tablesMentioned: z.array(z.string()) })),
    tablesMentioned: z.array(z.string()),
  }),
  flows: z.array(
    z.object({
      name: z.string(),
      entry: z.string(),
      steps: z.array(z.string()),
      exit: z.string(),
      filesInvolved: z.array(z.string()),
    }),
  ),
  gaps: z.array(
    z.object({
      area: z.enum(["ux", "api", "data", "reliability"]),
      description: z.string(),
      likelyFiles: z.array(z.string()),
    }),
  ),
});

export type CurrentStateAuditOutput = z.infer<typeof CurrentStateAuditOutputSchema>;

// ---------- helpers ----------

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

async function readSafe(abs: string, maxBytes = MAX_FILE_BYTES): Promise<string | undefined> {
  try {
    const s = await stat(abs);
    if (!s.isFile() || s.size > maxBytes) return undefined;
    return await readFile(abs, "utf8");
  } catch {
    return undefined;
  }
}

async function listDir(abs: string): Promise<string[]> {
  try {
    return await readdir(abs);
  } catch {
    return [];
  }
}

async function isDir(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isDirectory();
  } catch {
    return false;
  }
}

async function collectFiles(
  root: string,
  extensions: Set<string>,
  maxDepth = 6,
  maxFiles = 500,
): Promise<string[]> {
  const result: string[] = [];
  const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".expo", ".turbo"]);

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth || result.length >= maxFiles) return;
    const entries = await listDir(dir);
    for (const name of entries) {
      if (SKIP.has(name)) continue;
      const abs = join(dir, name);
      if (await isDir(abs)) {
        await walk(abs, depth + 1);
      } else if (extensions.has(extname(name).toLowerCase())) {
        result.push(abs);
        if (result.length >= maxFiles) return;
      }
    }
  }

  await walk(root, 0);
  return result;
}

// ---------- detection: app roots ----------

interface DetectedApp {
  mobileRoot?: string;
  webRoot?: string;
  backendRoot?: string;
  dataRoots?: string[];
  cloudRoots?: string[];
  language: "ts" | "js" | "mixed";
  packageManager?: "pnpm" | "npm" | "yarn";
}

async function detectApp(repoPath: string, input: StageInputComposition): Promise<DetectedApp> {
  const inv = input.repoInventory;
  const repoType = input.config.project.repo_type.toLowerCase();
  const isWebDataPlatform = /web|data|platform|cloud|enterprise/.test(repoType);
  const parsed = z.object({
    detected: z.object({
      mobileAppDir: z.string().optional(),
      supabaseDir: z.string().optional(),
    }).optional(),
    summary: z.object({
      languages: z.array(z.string()).optional(),
    }).optional(),
  }).safeParse(inv);

  let mobileRoot = parsed.success ? parsed.data.detected?.mobileAppDir : undefined;
  if (!mobileRoot && !isWebDataPlatform) {
    if (await isDir(join(repoPath, "app"))) mobileRoot = ".";
    else if (await isDir(join(repoPath, "apps", "mobile"))) mobileRoot = "apps/mobile";
  }

  let webRoot: string | undefined;
  for (const candidate of ["apps/web", "web", "."]) {
    const abs = join(repoPath, candidate === "." ? "" : candidate);
    if (
      (await isDir(join(abs, "app"))) ||
      (await isDir(join(abs, "pages"))) ||
      (await isDir(join(abs, "src", "app"))) ||
      (await isDir(join(abs, "src", "pages"))) ||
      (await readSafe(join(abs, "next.config.js"))) ||
      (await readSafe(join(abs, "next.config.mjs"))) ||
      (await readSafe(join(abs, "vite.config.ts"))) ||
      (await readSafe(join(abs, "vite.config.js")))
    ) {
      webRoot = candidate;
      break;
    }
  }

  let backendRoot = parsed.success ? parsed.data.detected?.supabaseDir : undefined;
  if (!backendRoot && (await isDir(join(repoPath, "supabase")))) backendRoot = "supabase";
  if (!backendRoot) {
    for (const candidate of ["apps/api", "api", "server", "services"]) {
      if (await isDir(join(repoPath, candidate))) {
        backendRoot = candidate;
        break;
      }
    }
  }

  const dataRoots: string[] = [];
  for (const candidate of ["sql", "dbt", "migrations", "warehouse", "data", "databricks", "notebooks"]) {
    if (await isDir(join(repoPath, candidate))) dataRoots.push(candidate);
  }

  const cloudRoots: string[] = [];
  for (const candidate of ["infra", "terraform", "cdk", "pulumi", "aws", ".github/workflows"]) {
    if (await isDir(join(repoPath, candidate))) cloudRoots.push(candidate);
  }

  const langs = parsed.success ? (parsed.data.summary?.languages ?? []) : [];
  const hasTs = langs.includes("typescript");
  const hasJs = langs.includes("javascript");
  let language: DetectedApp["language"] = "ts";
  if (hasTs && hasJs) language = "mixed";
  else if (hasJs && !hasTs) language = "js";

  let packageManager: DetectedApp["packageManager"];
  if (await readSafe(join(repoPath, "pnpm-lock.yaml"))) packageManager = "pnpm";
  else if (await readSafe(join(repoPath, "yarn.lock"))) packageManager = "yarn";
  else if (await readSafe(join(repoPath, "package-lock.json"))) packageManager = "npm";

  return { mobileRoot, webRoot, backendRoot, dataRoots, cloudRoots, language, packageManager };
}

// ---------- navigation & screens ----------

interface RouteEntry { name: string; file: string }
interface NavigatorEntry { file: string; kind: "stack" | "tabs" | "unknown" }
interface ScreenEntry { name: string; file: string; purposeGuess: string; keyActions: string[] }

async function scanNavigation(
  repoPath: string,
  mobileRoot: string,
): Promise<{ routes: RouteEntry[]; navigators: NavigatorEntry[]; screens: ScreenEntry[] }> {
  const appRoot = join(repoPath, mobileRoot === "." ? "" : mobileRoot);
  const appDir = join(appRoot, "app");
  const routes: RouteEntry[] = [];
  const navigators: NavigatorEntry[] = [];
  const screens: ScreenEntry[] = [];

  if (!(await isDir(appDir))) return { routes, navigators, screens };

  const codeFiles = await collectFiles(appDir, CODE_EXTS, 4, 200);

  for (const abs of codeFiles) {
    const relFromApp = toPosix(relative(appDir, abs));
    const relFromRepo = toPosix(relative(repoPath, abs));
    const base = basename(abs);
    const content = await readSafe(abs);
    if (!content) continue;

    const isLayout = base === "_layout.tsx" || base === "_layout.ts" || base === "_layout.js";

    if (isLayout) {
      let kind: NavigatorEntry["kind"] = "unknown";
      if (/\bStack\b/.test(content) || /createNativeStackNavigator/.test(content)) kind = "stack";
      if (/\bTabs\b/.test(content) || /createBottomTabNavigator/.test(content)) kind = "tabs";
      navigators.push({ file: relFromRepo, kind });

      const screenRe = /(?:Stack|Tabs)\.Screen\s+name=["']([^"']+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = screenRe.exec(content)) !== null) {
        routes.push({ name: m[1], file: relFromRepo });
      }
      continue;
    }

    if (base.startsWith("_")) continue;

    const routeName = fileToRouteName(relFromApp);
    routes.push({ name: routeName, file: relFromRepo });

    const purposeGuess = guessScreenPurpose(routeName, content);
    const keyActions = extractKeyActions(content);
    const screenName = routeName
      .split("/")
      .filter(Boolean)
      .map((s) => s.replace(/^\[/, "").replace(/\]$/, ""))
      .join(" > ") || "index";

    screens.push({ name: screenName, file: relFromRepo, purposeGuess, keyActions });
  }

  return { routes, navigators, screens };
}

async function scanWebNavigation(
  repoPath: string,
  webRoot: string,
): Promise<{ routes: RouteEntry[]; navigators: NavigatorEntry[]; screens: ScreenEntry[] }> {
  const root = join(repoPath, webRoot === "." ? "" : webRoot);
  const routes: RouteEntry[] = [];
  const navigators: NavigatorEntry[] = [];
  const screens: ScreenEntry[] = [];
  const codeFiles = await collectFiles(root, CODE_EXTS, 6, 300);

  for (const abs of codeFiles) {
    const relFromRoot = toPosix(relative(root, abs));
    const relFromRepo = toPosix(relative(repoPath, abs));
    if (
      !/(^|\/)(app|pages|routes|src\/app|src\/pages|src\/routes)\//i.test(relFromRoot) &&
      !/(^|\/)(components|features)\//i.test(relFromRoot)
    ) {
      continue;
    }

    const base = basename(abs);
    if (base.startsWith("_") && !/_layout|layout/i.test(base)) continue;
    const content = await readSafe(abs);
    if (!content) continue;

    if (/layout\.(tsx?|jsx?)$/i.test(base) || /RootLayout|AppShell|DashboardLayout/.test(content)) {
      navigators.push({ file: relFromRepo, kind: "unknown" });
    }

    const routeName = webFileToRouteName(relFromRoot);
    const isRoutable =
      /(^|\/)(app|pages|routes|src\/app|src\/pages|src\/routes)\//i.test(relFromRoot) &&
      !/\/(layout|loading|error|not-found)\.(tsx?|jsx?)$/i.test(relFromRoot);
    if (isRoutable) routes.push({ name: routeName, file: relFromRepo });

    const looksLikeScreen =
      isRoutable ||
      /\b(page|screen|dashboard|wizard|form|table|ledger|connector|agreement|policy|evidence|overlap)\b/i.test(
        relFromRepo,
      ) ||
      /<form\b|useForm\(|fetch\(|router\.|<table\b|DataGrid|Button|Input/.test(content);
    if (!looksLikeScreen) continue;

    screens.push({
      name: routeName.replace(/^\//, "") || basename(abs).replace(/\.(tsx?|jsx?)$/i, ""),
      file: relFromRepo,
      purposeGuess: guessWebScreenPurpose(routeName, relFromRepo, content),
      keyActions: extractKeyActions(content),
    });
  }

  return { routes, navigators, screens };
}

function webFileToRouteName(relFromRoot: string): string {
  return "/" + relFromRoot
    .replace(/^(src\/)?(app|pages|routes)\//, "")
    .replace(/\.(tsx?|jsx?|mjs|cjs)$/, "")
    .replace(/\/page$/, "")
    .replace(/\/index$/, "")
    .replace(/^page$/, "")
    .replace(/^index$/, "");
}

function guessWebScreenPurpose(routeName: string, relFile: string, content: string): string {
  const lower = `${routeName} ${relFile} ${content.slice(0, 1000)}`.toLowerCase();
  if (/connector|snowflake|redshift|databricks|bigquery|warehouse/.test(lower)) return "Warehouse connector setup and verification";
  if (/agreement|contract|legal/.test(lower)) return "Agreement generation and review";
  if (/policy|approval|approve/.test(lower)) return "Policy approval and governance";
  if (/overlap|audience|cohort|segment/.test(lower)) return "Audience overlap run workflow";
  if (/evidence|proof|receipt|pack/.test(lower)) return "Evidence pack and proof review";
  if (/ledger|audit|history|runs/.test(lower)) return "Trust Ledger / audit history";
  if (/org|tenant|partner|invite/.test(lower)) return "Organization and partner management";
  if (/dashboard|home/.test(lower)) return "Dashboard / workspace overview";
  if (/settings|admin|security/.test(lower)) return "Admin, security, or configuration";
  return "Web application surface";
}

function fileToRouteName(relFromApp: string): string {
  return "/" + relFromApp
    .replace(/\.(tsx?|jsx?|mjs|cjs)$/, "")
    .replace(/\/index$/, "")
    .replace(/^index$/, "");
}

function guessScreenPurpose(routeName: string, content: string): string {
  const lower = routeName.toLowerCase();
  if (/auth/.test(lower)) return "Authentication / sign-in flow";
  if (/onboarding/.test(lower)) return "Onboarding step";
  if (/settings/.test(lower)) return "User settings and preferences";
  if (/intro/.test(lower)) return "Introduction or welcome screen";
  if (/pro/.test(lower) || /paywall/.test(lower)) return "Pro upgrade / paywall";
  if (/memory/.test(lower)) return "Garden memory / history view";
  if (/year/.test(lower)) return "Yearly overview or calendar";
  if (/setup|garden/.test(lower)) return "Garden setup and management";
  if (/observe/.test(lower)) return "Observation / diagnosis input";
  if (/decision/.test(lower)) return "Decision detail / action window";
  if (/plant/.test(lower)) return "Plant detail view";
  if (/zone/.test(lower)) return "Zone detail / edit";
  if (lower === "/" || lower === "") return "Entry / routing guard";
  if (/index/.test(lower) || /this.?week/.test(lower)) return "Home / weekly action plan";
  if (/\berror\b/.test(lower)) return "Error boundary";
  return "Application screen";
}

function extractKeyActions(content: string): string[] {
  const actions: string[] = [];

  const navigateRe = /router\.(push|replace|navigate|back)\(\s*['"`]?([^'"`),\s]*)/g;
  const navTargets = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = navigateRe.exec(content)) !== null) {
    const target = m[2] || "(back)";
    if (!navTargets.has(target)) {
      navTargets.add(target);
      actions.push(`Navigate: ${m[1]}(${target})`);
    }
  }

  if (/supabase\s*\.\s*from\s*\(/.test(content)) actions.push("Supabase DB query");
  if (/supabase\s*\.\s*auth\s*\./.test(content)) actions.push("Supabase auth call");
  if (/supabase\s*\.\s*functions\s*\.invoke/.test(content)) actions.push("Edge function invocation");
  if (/fetch\s*\(/.test(content) && !/deno/i.test(content)) actions.push("HTTP fetch");
  if (/Alert\.alert/.test(content)) actions.push("User alert dialog");
  if (/useEffect/.test(content)) actions.push("Side effect on mount/change");
  if (/RefreshControl/.test(content)) actions.push("Pull-to-refresh");
  if (/Image|<Image/.test(content)) actions.push("Image display");
  if (/TextInput|<TextInput|<RNTextInput/.test(content)) actions.push("Text input field");
  if (/Modal/.test(content)) actions.push("Modal dialog");

  return actions.slice(0, 10);
}

// ---------- API surface ----------

interface EdgeFunction { name: string; path: string }
interface EndpointEntry { function: string; method: string; route: string }

async function scanApiSurface(
  repoPath: string,
  backendRoot?: string,
): Promise<{ edgeFunctions: EdgeFunction[]; endpoints: EndpointEntry[] }> {
  const edgeFunctions: EdgeFunction[] = [];
  const endpoints: EndpointEntry[] = [];

  if (!backendRoot) return { edgeFunctions, endpoints };

  const backendAbs = join(repoPath, backendRoot);
  const functionsDir = join(repoPath, backendRoot, "functions");
  const fnDirs = await listDir(functionsDir);

  for (const name of fnDirs) {
    if (name.startsWith(".")) continue;
    const fnDir = join(functionsDir, name);
    if (!(await isDir(fnDir))) continue;

    const relPath = toPosix(relative(repoPath, fnDir));
    edgeFunctions.push({ name, path: relPath });

    const indexFile = join(fnDir, "index.ts");
    const content = await readSafe(indexFile);
    if (!content) continue;

    const fnRel = toPosix(relative(repoPath, indexFile));

    if (/serve\s*\(/.test(content)) {
      endpoints.push({ function: name, method: "POST", route: `/functions/v1/${name}` });
    }

    const routeRe = /\b(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = routeRe.exec(content)) !== null) {
      endpoints.push({ function: name, method: m[1].toUpperCase(), route: m[2] });
    }
  }

  const apiFiles = await collectFiles(backendAbs, CODE_EXTS, 6, 300);
  for (const abs of apiFiles) {
    const relFile = toPosix(relative(repoPath, abs));
    const content = await readSafe(abs);
    if (!content) continue;
    const routeRe = /\b(?:app|router|server|api)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = routeRe.exec(content)) !== null) {
      endpoints.push({ function: relFile, method: m[1].toUpperCase(), route: m[2] });
    }
    const methodExportRe = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g;
    while ((m = methodExportRe.exec(content)) !== null) {
      endpoints.push({ function: relFile, method: m[1].toUpperCase(), route: `/${relFile}` });
    }
  }

  return { edgeFunctions, endpoints };
}

// ---------- data model ----------

interface MigrationEntry { file: string; tablesMentioned: string[] }

async function scanDataModel(
  repoPath: string,
  backendRoot?: string,
  dataRoots: string[] = [],
): Promise<{ migrations: MigrationEntry[]; tablesMentioned: string[] }> {
  const migrations: MigrationEntry[] = [];
  const allTables = new Set<string>();

  const roots = new Set<string>(dataRoots);
  if (backendRoot) roots.add(`${backendRoot}/migrations`);
  for (const candidate of ["migrations", "sql", "dbt", "warehouse", "databricks"]) {
    if (await isDir(join(repoPath, candidate))) roots.add(candidate);
  }

  for (const root of roots) {
    const files = await collectFiles(join(repoPath, root), SQL_EXTS, 6, 300);
    for (const abs of files) {
      const content = await readSafe(abs);
      if (!content) continue;

      const tables = new Set<string>();
      const tableRe = /(?:create|alter|drop)\s+(?:or\s+replace\s+)?(?:table|view)\s+(?:if\s+(?:not\s+)?exists\s+)?([\w."]+)/gi;
      let m: RegExpExecArray | null;
      while ((m = tableRe.exec(content)) !== null) {
        const t = m[1].replace(/"/g, "").toLowerCase();
        if (t !== "if") {
          tables.add(t);
          allTables.add(t);
        }
      }

      const relFile = toPosix(relative(repoPath, abs));
      migrations.push({ file: relFile, tablesMentioned: [...tables].sort() });
    }
  }

  return { migrations, tablesMentioned: [...allTables].sort() };
}

// ---------- flows ----------

interface FlowEntry {
  name: string;
  entry: string;
  steps: string[];
  exit: string;
  filesInvolved: string[];
}

function inferFlows(
  screens: ScreenEntry[],
  routes: RouteEntry[],
  repoPath: string,
): FlowEntry[] {
  const flows: FlowEntry[] = [];
  const routeMap = new Map(routes.map((r) => [r.name, r.file]));

  const onboardingScreens = screens
    .filter((s) => /onboarding/.test(s.file))
    .sort((a, b) => a.file.localeCompare(b.file));

  if (onboardingScreens.length > 0) {
    flows.push({
      name: "Onboarding",
      entry: onboardingScreens[0].file,
      steps: onboardingScreens.map((s) => `${s.name}: ${s.purposeGuess}`),
      exit: "intro or (tabs)",
      filesInvolved: onboardingScreens.map((s) => s.file),
    });
  }

  const authScreen = screens.find((s) => /\/auth/.test(s.file) && !/error/.test(s.file));
  if (authScreen) {
    flows.push({
      name: "Authentication",
      entry: authScreen.file,
      steps: [
        "User lands on auth screen",
        "Signs in / signs up via Supabase Auth",
        "On success, redirect to root (which routes to tabs or onboarding)",
      ],
      exit: "/ (root router guard)",
      filesInvolved: [authScreen.file, routeMap.get("/") ?? "app/index.tsx"],
    });
  }

  const weeklyScreen = screens.find(
    (s) => s.file.includes("(tabs)/index") || s.purposeGuess.includes("weekly"),
  );
  if (weeklyScreen) {
    const observeScreen = screens.find((s) => /observe/.test(s.file));
    const setupScreen = screens.find((s) => /setup/.test(s.file));
    const involved = [weeklyScreen.file];
    if (observeScreen) involved.push(observeScreen.file);
    if (setupScreen) involved.push(setupScreen.file);

    flows.push({
      name: "Weekly Check-in",
      entry: weeklyScreen.file,
      steps: [
        "View this week's action plan (do / watch / ignore items)",
        "Complete tasks and log outcomes",
        "Navigate to observe for diagnosis if needed",
        "Navigate to garden setup to adjust plants/zones",
      ],
      exit: "Stays in tabs",
      filesInvolved: involved,
    });
  }

  const proScreen = screens.find((s) => /\/pro/.test(s.file));
  if (proScreen) {
    flows.push({
      name: "Pro Upgrade",
      entry: proScreen.file,
      steps: [
        "User hits a gated feature",
        "Paywall modal opens with context parameter",
        "User chooses plan or dismisses",
        "On purchase, returns to previous screen",
      ],
      exit: "router.back() to previous screen",
      filesInvolved: [proScreen.file],
    });
  }

  const decisionScreen = screens.find((s) => /decision/.test(s.file));
  if (decisionScreen) {
    flows.push({
      name: "Decision Window",
      entry: decisionScreen.file,
      steps: [
        "User taps active decision prompt from weekly view",
        "Views decision detail with options",
        "Makes a choice or defers",
        "Returns to weekly view",
      ],
      exit: "router.back()",
      filesInvolved: [decisionScreen.file, weeklyScreen?.file ?? "app/(tabs)/index.tsx"],
    });
  }

  const connectorScreen = screens.find((s) => /connector|warehouse/i.test(`${s.file} ${s.purposeGuess}`));
  const agreementScreen = screens.find((s) => /agreement|policy/i.test(`${s.file} ${s.purposeGuess}`));
  const overlapScreen = screens.find((s) => /overlap|audience|cohort/i.test(`${s.file} ${s.purposeGuess}`));
  const evidenceScreen = screens.find((s) => /evidence|ledger|proof|audit/i.test(`${s.file} ${s.purposeGuess}`));
  if (connectorScreen || agreementScreen || overlapScreen || evidenceScreen) {
    flows.push({
      name: "Governed Data Collaboration",
      entry: connectorScreen?.file ?? screens[0]?.file ?? "web app",
      steps: [
        "Create organizations and select partner collaboration context",
        "Connect and verify warehouse datasets",
        "Generate agreement and approve executable policy",
        "Run overlap or collaboration job with suppression rules",
        "Review aggregate result and download evidence pack",
      ],
      exit: evidenceScreen?.file ?? overlapScreen?.file ?? "Trust Ledger / evidence pack",
      filesInvolved: [connectorScreen, agreementScreen, overlapScreen, evidenceScreen]
        .filter((s): s is ScreenEntry => !!s)
        .map((s) => s.file),
    });
  }

  return flows;
}

// ---------- gaps ----------

interface GapEntry {
  area: "ux" | "api" | "data" | "reliability";
  description: string;
  likelyFiles: string[];
}

async function fileContains(abs: string, pattern: RegExp | string): Promise<boolean> {
  const content = await readSafe(abs);
  if (!content) return false;
  return typeof pattern === "string" ? content.includes(pattern) : pattern.test(content);
}

async function identifyGaps(
  repoPath: string,
  screens: ScreenEntry[],
  api: { edgeFunctions: EdgeFunction[]; endpoints: EndpointEntry[] },
  data: { migrations: MigrationEntry[]; tablesMentioned: string[] },
  flows: FlowEntry[],
  det: DetectedApp,
): Promise<GapEntry[]> {
  const gaps: GapEntry[] = [];
  const mobileBase = join(repoPath, det.mobileRoot === "." ? "" : (det.mobileRoot ?? ""));
  const backendBase = det.backendRoot ? join(repoPath, det.backendRoot) : undefined;
  const rootLayout = join(mobileBase, "app", "_layout.tsx");

  if (!det.mobileRoot && det.webRoot) {
    if (api.endpoints.length === 0 && api.edgeFunctions.length === 0) {
      gaps.push({
        area: "api",
        description: "No API endpoints detected for the web/data platform workflow. Connector verification and overlap runs may not have server-side execution paths.",
        likelyFiles: [det.backendRoot ?? "api"],
      });
    }
    const hasConnectorSurface = screens.some((s) => /connector|snowflake|redshift|databricks|warehouse/i.test(`${s.file} ${s.purposeGuess}`));
    if (!hasConnectorSurface) {
      gaps.push({
        area: "ux",
        description: "No warehouse connector setup surface detected. Enterprise users need guided setup and verification for Snowflake/Redshift/Databricks/AWS.",
        likelyFiles: [det.webRoot],
      });
    }
    const hasEvidenceSurface = screens.some((s) => /evidence|ledger|proof|audit/i.test(`${s.file} ${s.purposeGuess}`));
    if (!hasEvidenceSurface) {
      gaps.push({
        area: "reliability",
        description: "No Trust Ledger or evidence-pack surface detected. Enterprise workflows need audit-ready run history and downloadable proof artifacts.",
        likelyFiles: [det.webRoot],
      });
    }
    const hasPolicySurface = screens.some((s) => /agreement|policy|approval/i.test(`${s.file} ${s.purposeGuess}`));
    if (!hasPolicySurface) {
      gaps.push({
        area: "data",
        description: "No agreement/policy approval surface detected. Cross-cloud collaboration needs executable policy approval before runs.",
        likelyFiles: [det.webRoot],
      });
    }
    return gaps;
  }

  const hasErrorBoundary =
    screens.some((s) => /error/i.test(s.file)) ||
    (await fileContains(join(mobileBase, "src", "components", "ErrorBoundary.tsx"), "class ErrorBoundary")) ||
    (await fileContains(rootLayout, "ErrorBoundary"));
  if (!hasErrorBoundary) {
    gaps.push({
      area: "reliability",
      description: "No error boundary screen detected. Unhandled errors may crash the app.",
      likelyFiles: ["app/_layout.tsx"],
    });
  }

  const hasOfflineHandling =
    screens.some((s) => s.keyActions.some((a) => /offline|netinfo|network/i.test(a))) ||
    (await fileContains(join(mobileBase, "src", "hooks", "useNetworkStatus.ts"), "NetInfo")) ||
    (await fileContains(join(mobileBase, "src", "components", "OfflineBanner.tsx"), "offline")) ||
    (await fileContains(rootLayout, "OfflineBanner"));
  if (!hasOfflineHandling) {
    gaps.push({
      area: "reliability",
      description: "No offline handling or network status detection found. The app may fail silently when offline.",
      likelyFiles: ["app/_layout.tsx", "src/lib/supabase.ts"],
    });
  }

  const hasLoadingStates = screens.some((s) => s.keyActions.includes("Pull-to-refresh"));
  if (!hasLoadingStates) {
    gaps.push({
      area: "ux",
      description: "No pull-to-refresh detected on any screen. Users may not be able to refresh stale data.",
      likelyFiles: screens.slice(0, 3).map((s) => s.file),
    });
  }

  if (api.edgeFunctions.length > 0) {
    const fnFiles = api.edgeFunctions.map((f) => f.path + "/index.ts");
    let hasRateLimiting =
      !!backendBase &&
      (await fileContains(join(backendBase, "functions", "_shared", "rate-limit.ts"), "rateLimit("));
    if (!hasRateLimiting) {
      for (const fn of api.edgeFunctions) {
        if (await fileContains(join(repoPath, fn.path, "index.ts"), /rateLimit\(|rateLimitResponse\(/)) {
          hasRateLimiting = true;
          break;
        }
      }
    }
    if (!hasRateLimiting) {
      gaps.push({
        area: "api",
        description: "Edge functions have no visible rate limiting. Abuse or runaway clients could cause cost spikes.",
        likelyFiles: fnFiles,
      });
    }
  }

  let hasInputValidation = screens.some(
    (s) => s.keyActions.includes("Text input field") && s.keyActions.some((a) => /validat/i.test(a)),
  );
  if (!hasInputValidation) {
    for (const s of screens.filter((x) => x.keyActions.includes("Text input field")).slice(0, 10)) {
      if (await fileContains(join(repoPath, s.file), /\[foundry:validation\]|validateRequired\(/)) {
        hasInputValidation = true;
        break;
      }
    }
  }
  if (!hasInputValidation && screens.some((s) => s.keyActions.includes("Text input field"))) {
    const inputScreens = screens.filter((s) => s.keyActions.includes("Text input field")).map((s) => s.file);
    gaps.push({
      area: "ux",
      description: "Screens with text input have no visible client-side validation. Users may submit bad data.",
      likelyFiles: inputScreens.slice(0, 5),
    });
  }

  const tablesWithRLS = data.tablesMentioned;
  if (tablesWithRLS.length > 0 && !data.migrations.some((m) =>
    m.tablesMentioned.length > 0,
  )) {
    gaps.push({
      area: "data",
      description: "Tables detected but no migration structure could be parsed. Schema may be applied manually.",
      likelyFiles: data.migrations.map((m) => m.file),
    });
  }

  const deepLinkScreens = screens.filter((s) => /\[.*\]/.test(s.file));
  if (deepLinkScreens.length > 0) {
    const missingGuard: ScreenEntry[] = [];
    for (const s of deepLinkScreens) {
      const hasGuardByMetadata = s.keyActions.some((a) => /auth|guard|redirect/i.test(a));
      const hasGuardByCode = await fileContains(
        join(repoPath, s.file),
        /\[foundry:auth-guard\]|useAuthStore\(\)|replace\(\s*['"]\/auth['"]\s*\)/,
      );
      if (!hasGuardByMetadata && !hasGuardByCode) missingGuard.push(s);
    }
    if (missingGuard.length > 0) {
      gaps.push({
        area: "reliability",
        description: "Dynamic route screens may be accessible without auth guard. Deep links could bypass login.",
        likelyFiles: missingGuard.map((s) => s.file),
      });
    }
  }

  const onboardingFlow = flows.find((f) => f.name === "Onboarding");
  if (onboardingFlow && onboardingFlow.steps.length > 4) {
    gaps.push({
      area: "ux",
      description: `Onboarding has ${onboardingFlow.steps.length} steps. Consider reducing or deferring non-essential steps to improve completion rate.`,
      likelyFiles: onboardingFlow.filesInvolved,
    });
  }

  return gaps;
}

// ---------- README ----------

function buildReadme(output: CurrentStateAuditOutput, projectName: string): string {
  const lines = [
    `# ${projectName} — Current State Audit`,
    "",
    "## Detected App Structure",
    "",
    `- **Mobile root:** \`${output.detectedApp.mobileRoot ?? "(not found)"}\``,
    `- **Web root:** \`${output.detectedApp.webRoot ?? "(not found)"}\``,
    `- **Backend root:** \`${output.detectedApp.backendRoot ?? "(not found)"}\``,
    `- **Data roots:** ${(output.detectedApp.dataRoots ?? []).map((r) => `\`${r}\``).join(", ") || "(not found)"}`,
    `- **Cloud/infra roots:** ${(output.detectedApp.cloudRoots ?? []).map((r) => `\`${r}\``).join(", ") || "(not found)"}`,
    `- **Language:** ${output.detectedApp.language}`,
    `- **Package manager:** ${output.detectedApp.packageManager ?? "unknown"}`,
    "",
    "## Routes & Screens",
    "",
    `Found **${output.screens.length}** screens across **${output.navigation.navigators.length}** navigator(s).`,
    "",
    "| Screen | File | Purpose |",
    "| --- | --- | --- |",
    ...output.screens.map(
      (s) => `| ${s.name} | \`${s.file}\` | ${s.purposeGuess} |`,
    ),
    "",
    "## Edge Functions",
    "",
  ];

  if (output.apiSurface.edgeFunctions.length > 0) {
    for (const fn of output.apiSurface.edgeFunctions) {
      lines.push(`- **${fn.name}** — \`${fn.path}\``);
    }
  } else {
    lines.push("_(none detected)_");
  }

  lines.push("", "## Data Model", "");
  if (output.dataModel.tablesMentioned.length > 0) {
    lines.push(`**Tables:** ${output.dataModel.tablesMentioned.join(", ")}`, "");
    lines.push(`**Migrations:** ${output.dataModel.migrations.length} file(s)`, "");
  } else {
    lines.push("_(no migrations found)_");
  }

  lines.push("## User Flows", "");
  for (const flow of output.flows) {
    lines.push(`### ${flow.name}`, "");
    flow.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push(`- Entry: \`${flow.entry}\``, `- Exit: ${flow.exit}`, "");
  }

  lines.push("## Top Gaps", "");
  const topGaps = output.gaps.slice(0, 5);
  for (const gap of topGaps) {
    lines.push(`- **[${gap.area}]** ${gap.description}`);
    lines.push(`  - Files: ${gap.likelyFiles.map((f) => `\`${f}\``).join(", ")}`);
  }

  lines.push("");
  return lines.join("\n");
}

// ---------- stage ----------

export const currentStateAuditStage: Stage<StageInputComposition, CurrentStateAuditOutput> = {
  name: "current_state_audit",
  description: "Static analysis of the target repo: screens, navigation, API surface, data model, flows, and gaps.",
  inputSchema: StageInputCompositionSchema,
  outputSchema: CurrentStateAuditOutputSchema,
  async run(ctx: RunContext, input: StageInputComposition): Promise<CurrentStateAuditOutput> {
    ctx.logger("[current_state_audit] scanning", { repoPath: ctx.repoPath });

    const det = await detectApp(ctx.repoPath, input);

    ctx.logger("[current_state_audit] detected", {
      mobileRoot: det.mobileRoot,
      webRoot: det.webRoot,
      backendRoot: det.backendRoot,
      dataRoots: det.dataRoots,
      cloudRoots: det.cloudRoots,
      language: det.language,
      packageManager: det.packageManager,
    });

    const nav = det.mobileRoot
      ? await scanNavigation(ctx.repoPath, det.mobileRoot)
      : det.webRoot
        ? await scanWebNavigation(ctx.repoPath, det.webRoot)
        : { routes: [], navigators: [], screens: [] };
    const { routes, navigators, screens } = nav;

    const apiSurface = await scanApiSurface(ctx.repoPath, det.backendRoot);
    const dataModel = await scanDataModel(ctx.repoPath, det.backendRoot, det.dataRoots ?? []);
    const flows = inferFlows(screens, routes, ctx.repoPath);
    const gaps = await identifyGaps(ctx.repoPath, screens, apiSurface, dataModel, flows, det);

    const output: CurrentStateAuditOutput = {
      detectedApp: det,
      navigation: { routes, navigators },
      screens,
      apiSurface,
      dataModel,
      flows,
      gaps,
    };

    const validated = CurrentStateAuditOutputSchema.parse(output);

    await writeStageMarkdown(
      ctx,
      "current_state_audit",
      "README.md",
      buildReadme(validated, input.config.project.project_name),
    );

    return validated;
  },
};
