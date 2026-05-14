import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// ---------- types ----------

export interface FileAction {
  file: string;
  action: "created" | "modified" | "skipped";
  description: string;
}

export interface GateConfig {
  feature: string;
  freeLimit?: { type: "count" | "rate"; value: number; period: "month" | "week" | "day" };
  requiresEntitlement?: string;
  paywallMoment: string;
}

export interface AnalyticsEventConfig {
  name: string;
  when: string;
  properties: string[];
}

// ---------- file helpers ----------

async function fileExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function safeWrite(absPath: string, content: string): Promise<boolean> {
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, content, "utf8");
  return true;
}

async function safeRead(absPath: string): Promise<string | undefined> {
  try { return await readFile(absPath, "utf8"); } catch { return undefined; }
}

// ---------- text modification helpers ----------

function addImport(content: string, importLine: string): string {
  if (content.includes(importLine.replace(/;?\s*$/, ""))) return content;
  const lastImportIdx = content.lastIndexOf("\nimport ");
  if (lastImportIdx === -1) return importLine + "\n" + content;
  const endOfLine = content.indexOf("\n", lastImportIdx + 1);
  return content.slice(0, endOfLine + 1) + importLine + "\n" + content.slice(endOfLine + 1);
}

function insertAfter(content: string, marker: string, insertion: string): string {
  const idx = content.indexOf(marker);
  if (idx === -1) return content;
  const insertPos = idx + marker.length;
  return content.slice(0, insertPos) + insertion + content.slice(insertPos);
}

function insertBefore(content: string, marker: string, insertion: string): string {
  const idx = content.indexOf(marker);
  if (idx === -1) return content;
  return content.slice(0, idx) + insertion + content.slice(idx);
}

// ---------- templates ----------

function errorBoundaryTemplate(): string {
  return `import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Text style={styles.emoji}>⚠️</Text>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.message}>{this.state.error?.message}</Text>
          <TouchableOpacity
            style={styles.button}
            onPress={() => this.setState({ hasError: false })}
          >
            <Text style={styles.buttonText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, backgroundColor: '#FAFAF8' },
  emoji: { fontSize: 48, marginBottom: 16 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 8, color: '#1a1a1a' },
  message: { fontSize: 14, color: '#666', textAlign: 'center', marginBottom: 32, lineHeight: 20 },
  button: { backgroundColor: '#2e7d32', paddingHorizontal: 28, paddingVertical: 14, borderRadius: 10 },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
});
`;
}

function networkStatusHookTemplate(): string {
  return `import { useEffect, useState } from 'react';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';

export function useNetworkStatus() {
  const [isConnected, setIsConnected] = useState(true);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
      setIsConnected(state.isConnected ?? true);
    });
    return () => unsubscribe();
  }, []);

  return { isConnected };
}
`;
}

function offlineBannerTemplate(): string {
  return `import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useNetworkStatus } from '../hooks/useNetworkStatus';

export function OfflineBanner() {
  const { isConnected } = useNetworkStatus();
  if (isConnected) return null;

  return (
    <View style={styles.banner}>
      <Text style={styles.text}>You're offline — some features may be unavailable</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { backgroundColor: '#e65100', paddingVertical: 6, paddingHorizontal: 16, alignItems: 'center' },
  text: { color: '#fff', fontSize: 13, fontWeight: '500' },
});
`;
}

function rateLimitTemplate(): string {
  return `const windowStore = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): { allowed: boolean; remaining: number; retryAfterMs: number } {
  const now = Date.now();
  const entry = windowStore.get(key);

  if (!entry || now > entry.resetAt) {
    windowStore.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1, retryAfterMs: 0 };
  }

  if (entry.count >= maxRequests) {
    return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now };
  }

  entry.count++;
  return { allowed: true, remaining: maxRequests - entry.count, retryAfterMs: 0 };
}

export function rateLimitResponse(retryAfterMs: number): Response {
  return new Response(
    JSON.stringify({ error: 'Too many requests', retryAfterMs }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.ceil(retryAfterMs / 1000)),
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}
`;
}

function paywallTemplate(gates: GateConfig[], projectName: string): string {
  const gateEntries = gates
    .map((g) => {
      const freeLimit = g.freeLimit
        ? `{ type: '${g.freeLimit.type}', value: ${g.freeLimit.value}, period: '${g.freeLimit.period}' }`
        : "undefined";
      return `  {
    feature: '${g.feature}',
    freeLimit: ${freeLimit},
    requiresEntitlement: ${g.requiresEntitlement ? `'${g.requiresEntitlement}'` : "undefined"},
    paywallMoment: '${g.paywallMoment.replace(/'/g, "\\'")}',
  }`;
    })
    .join(",\n");

  return `export interface Gate {
  feature: string;
  freeLimit?: { type: 'count' | 'rate'; value: number; period: 'month' | 'week' | 'day' };
  requiresEntitlement?: string;
  paywallMoment: string;
}

export const GATES: Gate[] = [
${gateEntries},
];

export function getGate(feature: string): Gate | undefined {
  return GATES.find((g) => g.feature === feature);
}

export function shouldShowPaywall(feature: string, currentUsage: number): boolean {
  const gate = getGate(feature);
  if (!gate) return false;
  if (!gate.freeLimit) return true;
  return currentUsage >= gate.freeLimit.value;
}

export function getPaywallMoment(feature: string): string | undefined {
  return getGate(feature)?.paywallMoment;
}
`;
}

function analyticsTemplate(events: AnalyticsEventConfig[], projectName: string): string {
  const eventTypes = events.map((e) => `  | '${e.name}'`).join("\n");
  const eventDocs = events
    .map((e) => `  '${e.name}': {\n    when: '${e.when.replace(/'/g, "\\'")}',\n    properties: [${e.properties.map((p) => `'${p}'`).join(", ")}],\n  }`)
    .join(",\n");

  return `type EventName =
${eventTypes};

type EventProperties = Record<string, string | number | boolean>;

export const EVENT_CATALOG: Record<EventName, { when: string; properties: string[] }> = {
${eventDocs},
};

let _trackFn: ((name: string, properties: EventProperties) => void) | undefined;

export function setTracker(fn: (name: string, properties: EventProperties) => void) {
  _trackFn = fn;
}

export function track(name: EventName, properties: EventProperties = {}) {
  if (__DEV__) {
    console.log('[analytics]', name, properties);
  }
  _trackFn?.(name, properties);
}
`;
}

// ---------- screen-level wiring types ----------

export interface ScreenInfo {
  name: string;
  file: string;
  purposeGuess: string;
  keyActions?: string[];
}

export interface GapInfo {
  area: string;
  description: string;
  likelyFiles: string[];
}

// ---------- auth guard resolver ----------

export async function resolveAuthGuards(
  repoPath: string,
  dynamicRoutes: string[],
): Promise<FileAction[]> {
  const actions: FileAction[] = [];
  const GUARD_MARKER = "// [foundry:auth-guard]";

  const authGuardAlreadyPresent = (content: string): boolean => {
    if (content.includes(GUARD_MARKER)) return true;
    const hasAuthStateGuard =
      /const\s*\{\s*[^}]*isAuthenticated[^}]*isAnonymous[^}]*\}\s*=\s*useAuthStore\(\)/.test(content) &&
      /replace\(\s*['"]\/auth['"]\s*\)/.test(content) &&
      /!\s*isAuthenticated\s*&&\s*!\s*isAnonymous/.test(content);
    if (hasAuthStateGuard) return true;
    const hasLegacySessionGuard =
      /const\s*\{\s*session\s*\}\s*=\s*useAuthStore\(\)/.test(content) &&
      /replace\(\s*['"]\/auth['"]\s*\)/.test(content);
    return hasLegacySessionGuard;
  };

  for (const routeFile of dynamicRoutes) {
    const absPath = join(repoPath, routeFile);
    const content = await safeRead(absPath);
    if (!content) continue;
    if (authGuardAlreadyPresent(content)) {
      actions.push({ file: routeFile, action: "skipped", description: "Auth guard already present (marker or inline guard)" });
      continue;
    }

    const hasAuthStore = content.includes("useAuthStore");
    const hasRouter = content.includes("useRouter") || content.includes("router");

    let modified = content;

    if (!hasAuthStore) {
      modified = addImport(modified, "import { useAuthStore } from '@/stores/authStore';");
    }
    if (!hasRouter && !content.includes("useRouter")) {
      modified = addImport(modified, "import { useRouter } from 'expo-router';");
    }

    const guardSnippet = `\n  ${GUARD_MARKER}\n  const { isAuthenticated, isAnonymous } = useAuthStore();\n  const _guardRouter = useRouter();\n  useEffect(() => {\n    if (!isAuthenticated && !isAnonymous) _guardRouter.replace('/auth');\n  }, [isAuthenticated, isAnonymous]);\n`;

    const fnMatch = modified.match(/export default function \w+\([^)]*\)\s*\{/);
    if (fnMatch) {
      const insertPos = modified.indexOf(fnMatch[0]) + fnMatch[0].length;
      modified = modified.slice(0, insertPos) + guardSnippet + modified.slice(insertPos);

      if (!modified.includes("import { useEffect") && !modified.includes("import {useEffect")) {
        if (modified.includes("from 'react'")) {
          modified = modified.replace(
            /import \{([^}]+)\} from 'react'/,
            (match, imports) => {
              if (imports.includes("useEffect")) return match;
              return `import {${imports}, useEffect} from 'react'`;
            },
          );
        } else {
          modified = addImport(modified, "import { useEffect } from 'react';");
        }
      }

      await writeFile(absPath, modified, "utf8");
      actions.push({ file: routeFile, action: "modified", description: "Added auth guard — redirects unauthenticated users to /auth" });
    }
  }

  return actions;
}

// ---------- input validation resolver ----------

export async function resolveInputValidation(
  repoPath: string,
  screenFiles: string[],
): Promise<FileAction[]> {
  const actions: FileAction[] = [];
  const VALIDATION_MARKER = "// [foundry:validation]";

  const validationHelper = `\n${VALIDATION_MARKER}\nfunction validateRequired(value: string, label: string): string | null {\n  if (!value || !value.trim()) return \`\${label} is required\`;\n  return null;\n}\n`;

  for (const screenFile of screenFiles) {
    const absPath = join(repoPath, screenFile);
    const content = await safeRead(absPath);
    if (!content) continue;
    if (content.includes(VALIDATION_MARKER)) {
      actions.push({ file: screenFile, action: "skipped", description: "Validation already present" });
      continue;
    }
    if (!content.includes("TextInput") && !content.includes("textInput")) {
      actions.push({ file: screenFile, action: "skipped", description: "No text input found" });
      continue;
    }

    let modified = content;

    const fnMatch = modified.match(/export default function \w+\([^)]*\)\s*\{/);
    if (!fnMatch) continue;

    const insertPos = modified.indexOf(fnMatch[0]);
    modified = modified.slice(0, insertPos) + validationHelper + "\n" + modified.slice(insertPos);

    await writeFile(absPath, modified, "utf8");
    actions.push({ file: screenFile, action: "modified", description: "Added validateRequired helper for input validation" });
  }

  return actions;
}

// ---------- paywall wiring resolver ----------

const PAYWALL_WIRE_MARKER = "// [foundry:paywall-wired]";
const ANALYTICS_WIRE_MARKER = "// [foundry:analytics-wired]";

/**
 * Prefer exact route files over fuzzy screen names.
 * The old `"(tabs)"` catch-all matched almost every Expo tab screen and caused
 * repeated wrapper reinjection into unrelated files.
 */
const GATE_FEATURE_TO_SCREEN_FILES: Record<string, string[]> = {
  weekly_action_plan: ["app/(tabs)/index.tsx"],
  diagnosis_workflow: ["app/(tabs)/observe.tsx"],
  garden_profiles: ["app/(tabs)/setup.tsx"],
  full_task_history: ["app/(tabs)/index.tsx", "app/memory.tsx", "app/plant/[id].tsx"],
  personalized_insights: ["app/(tabs)/index.tsx"],
};

const GATE_FEATURE_TO_SCREEN_KEYWORDS: Record<string, string[]> = {
  weekly_action_plan: ["(tabs)/index"],
  diagnosis_workflow: ["observe"],
  garden_profiles: ["setup"],
  full_task_history: ["memory", "plant/[id]", "(tabs)/index"],
  personalized_insights: ["(tabs)/index"],
};

function paywallFeatureRegex(feature: string): RegExp {
  return new RegExp(
    `shouldShowPaywall\\s*\\(\\s*['"]${feature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`,
  );
}

/** True if this source already enforces the gate (inline or prior Foundry wiring), so stubs must not be re-injected. */
export function paywallGateAlreadyWiredInSource(content: string, feature: string): boolean {
  if (!content) return false;
  if (content.includes(PAYWALL_WIRE_MARKER) && content.includes(feature)) return true;
  if (paywallFeatureRegex(feature).test(content)) return true;
  if (new RegExp(`\\b_check_${feature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(content)) return true;
  return false;
}

/** True if analytics for this event is already present (inline `track(...)` or Foundry marker). */
export function analyticsEventAlreadyWiredInSource(content: string, eventName: string): boolean {
  if (!content) return false;
  if (content.includes(ANALYTICS_WIRE_MARKER) && content.includes(eventName)) return true;
  const esc = eventName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\btrack\\s*\\(\\s*['"]${esc}['"]`).test(content)) return true;
  if (new RegExp(`\\b_track_${esc}\\b`).test(content)) return true;
  return false;
}

function targetScreensForPaywallGate(screens: ScreenInfo[], feature: string): ScreenInfo[] {
  const fileTargets = GATE_FEATURE_TO_SCREEN_FILES[feature] ?? [];
  const exact = screens.filter((s) => fileTargets.some((target) => s.file === target || s.file.endsWith(target)));
  if (exact.length > 0) return exact;
  const matchNames = GATE_FEATURE_TO_SCREEN_KEYWORDS[feature] ?? [];
  return screens.filter((s) =>
    matchNames.some((m) => s.name.toLowerCase().includes(m.toLowerCase()) || s.file.toLowerCase().includes(m.toLowerCase())),
  );
}

/**
 * Gate features whose target screens all already contain real or stub wiring — use for CURSOR_BRIEF `[x]`.
 */
export async function computeSatisfiedPaywallGates(
  repoPath: string,
  screens: ScreenInfo[],
  gates: GateConfig[],
): Promise<Set<string>> {
  const satisfied = new Set<string>();
  for (const gate of gates) {
    const targets = targetScreensForPaywallGate(screens, gate.feature);
    if (targets.length === 0) continue;
    let allOk = true;
    for (const screen of targets) {
      const content = await safeRead(join(repoPath, screen.file));
      if (!paywallGateAlreadyWiredInSource(content ?? "", gate.feature)) {
        allOk = false;
        break;
      }
    }
    if (allOk) satisfied.add(gate.feature);
  }
  return satisfied;
}

const ANALYTICS_EVENT_SCREEN_KEYWORDS: Record<string, string[]> = {
  paywall_shown: ["pro"],
  paywall_dismissed: ["pro"],
  trial_started: ["pro"],
};

function targetScreensForAnalyticsEvent(screens: ScreenInfo[], eventName: string): ScreenInfo[] {
  const keywords = ANALYTICS_EVENT_SCREEN_KEYWORDS[eventName];
  if (!keywords) return [];
  return screens.filter((s) =>
    keywords.some((kw) => s.name.toLowerCase().includes(kw) || s.file.toLowerCase().includes(kw)),
  );
}

/** Event names that are already wired on all target screens. */
export async function computeSatisfiedAnalyticsEvents(
  repoPath: string,
  screens: ScreenInfo[],
  events: AnalyticsEventConfig[],
): Promise<Set<string>> {
  const satisfied = new Set<string>();
  for (const event of events) {
    const targets = targetScreensForAnalyticsEvent(screens, event.name);
    if (targets.length === 0) continue;
    let allOk = true;
    for (const screen of targets) {
      const content = await safeRead(join(repoPath, screen.file));
      if (!analyticsEventAlreadyWiredInSource(content ?? "", event.name)) {
        allOk = false;
        break;
      }
    }
    if (allOk) satisfied.add(event.name);
  }
  return satisfied;
}

/** Edge function `path/index.ts` paths that already include Foundry rate-limit wiring. */
export async function computeSatisfiedEdgeRateLimitPaths(
  repoPath: string,
  edgeFunctions: Array<{ name: string; path: string }>,
): Promise<Set<string>> {
  const done = new Set<string>();
  const RL_MARKER = "// [foundry:rate-limit-wired]";
  for (const fn of edgeFunctions) {
    if (fn.name === "_shared") continue;
    const rel = `${fn.path}/index.ts`;
    const content = await safeRead(join(repoPath, rel));
    if (!content) continue;
    const hasMarker = content.includes(RL_MARKER);
    const hasImport = /import\s+\{\s*rateLimit\s*,\s*rateLimitResponse\s*\}\s+from\s+['"][^'"]+rate-limit\.ts['"]/.test(content);
    const hasUsage = /rateLimit\(/.test(content) && /rateLimitResponse\(/.test(content);
    if (hasMarker || (hasImport && hasUsage)) done.add(rel);
  }
  return done;
}

export async function wirePaywallIntoScreens(
  repoPath: string,
  screens: ScreenInfo[],
  gates: GateConfig[],
): Promise<FileAction[]> {
  const actions: FileAction[] = [];

  for (const gate of gates) {
    const targetScreens = targetScreensForPaywallGate(screens, gate.feature);

    if (targetScreens.length === 0) continue;

    for (const screen of targetScreens) {
      const absPath = join(repoPath, screen.file);
      const content = await safeRead(absPath);
      if (!content) continue;
      if (paywallGateAlreadyWiredInSource(content, gate.feature)) {
        actions.push({
          file: screen.file,
          action: "skipped",
          description: `Paywall gate ${gate.feature} already wired (inline or marker) in ${screen.file}`,
        });
        continue;
      }
      actions.push({
        file: screen.file,
        action: "skipped",
        description:
          `Paywall gate ${gate.feature} still needs inline wiring in ${screen.file}; ` +
          "Foundry avoids injecting dead `_check_*` wrapper stubs.",
      });
    }
  }

  return actions;
}

// ---------- analytics wiring resolver ----------

export async function wireAnalyticsIntoScreens(
  repoPath: string,
  screens: ScreenInfo[],
  events: AnalyticsEventConfig[],
): Promise<FileAction[]> {
  const actions: FileAction[] = [];

  for (const event of events) {
    const targetScreens = targetScreensForAnalyticsEvent(screens, event.name);
    if (targetScreens.length === 0) continue;

    for (const screen of targetScreens) {
      const absPath = join(repoPath, screen.file);
      const content = await safeRead(absPath);
      if (!content) continue;
      if (analyticsEventAlreadyWiredInSource(content, event.name)) {
        actions.push({
          file: screen.file,
          action: "skipped",
          description: `Analytics ${event.name} already wired (inline or marker) in ${screen.file}`,
        });
        continue;
      }
      actions.push({
        file: screen.file,
        action: "skipped",
        description:
          `Analytics event ${event.name} still needs inline wiring in ${screen.file}; ` +
          "Foundry avoids injecting dead `_track_*` wrapper stubs.",
      });
    }
  }

  return actions;
}

// ---------- rate limit wiring resolver ----------

export async function wireRateLimitIntoEdgeFunctions(
  repoPath: string,
  edgeFunctions: Array<{ name: string; path: string }>,
): Promise<FileAction[]> {
  const actions: FileAction[] = [];
  const RL_MARKER = "// [foundry:rate-limit-wired]";

  for (const fn of edgeFunctions) {
    if (fn.name === "_shared") continue;
    const indexPath = join(repoPath, fn.path, "index.ts");
    const content = await safeRead(indexPath);
    if (!content) {
      actions.push({
        file: `${fn.path}/index.ts`,
        action: "skipped",
        description: `Edge function file missing or unreadable for ${fn.name}`,
      });
      continue;
    }
    if (content.includes(RL_MARKER)) {
      actions.push({ file: `${fn.path}/index.ts`, action: "skipped", description: "Rate limiting already wired" });
      continue;
    }

    let modified = content;
    modified = addImport(modified, "import { rateLimit, rateLimitResponse } from '../_shared/rate-limit.ts';");

    const serveMatch = modified.match(/Deno\.serve\s*\(\s*(async\s*)?\(\s*(\w+)/);
    if (serveMatch) {
      const reqParam = serveMatch[2];
      const serveIdx = modified.indexOf(serveMatch[0]);
      const bodyStart = modified.indexOf("{", serveIdx + serveMatch[0].length);
      if (bodyStart !== -1) {
        const rlSnippet = `\n    ${RL_MARKER}\n    const _clientIp = ${reqParam}.headers.get('x-forwarded-for') ?? 'unknown';\n    const _rl = rateLimit(_clientIp, 30, 60_000);\n    if (!_rl.allowed) return rateLimitResponse(_rl.retryAfterMs);\n`;
        modified = modified.slice(0, bodyStart + 1) + rlSnippet + modified.slice(bodyStart + 1);
      }
    } else {
      actions.push({
        file: `${fn.path}/index.ts`,
        action: "skipped",
        description: `No Deno.serve handler match in ${fn.name}; manual rate-limit wiring required`,
      });
      continue;
    }

    if (modified !== content) {
      await writeFile(indexPath, modified, "utf8");
      actions.push({ file: `${fn.path}/index.ts`, action: "modified", description: `Wired rate limiting into ${fn.name} edge function` });
    } else {
      actions.push({
        file: `${fn.path}/index.ts`,
        action: "skipped",
        description: `No safe insertion point found for ${fn.name}; manual rate-limit wiring required`,
      });
    }
  }

  return actions;
}

// ---------- infrastructure resolvers ----------

export async function resolveErrorBoundary(
  repoPath: string,
  mobileRoot: string,
): Promise<FileAction[]> {
  const actions: FileAction[] = [];
  const base = mobileRoot === "." ? repoPath : join(repoPath, mobileRoot);
  const targetFile = join(base, "src", "components", "ErrorBoundary.tsx");

  if (await fileExists(targetFile)) {
    actions.push({ file: "src/components/ErrorBoundary.tsx", action: "skipped", description: "ErrorBoundary already exists" });
    return actions;
  }

  await safeWrite(targetFile, errorBoundaryTemplate());
  actions.push({ file: "src/components/ErrorBoundary.tsx", action: "created", description: "React error boundary component" });

  const layoutPath = join(base, "app", "_layout.tsx");
  const layoutContent = await safeRead(layoutPath);
  if (layoutContent && !layoutContent.includes("ErrorBoundary")) {
    let modified = addImport(layoutContent, "import { ErrorBoundary } from '@/components/ErrorBoundary';");

    if (modified.includes("<FeedbackProvider")) {
      modified = insertBefore(modified, "<FeedbackProvider", "<ErrorBoundary>\n      ");
      modified = insertAfter(modified, "</FeedbackProvider>", "\n      </ErrorBoundary>");
    } else if (modified.includes("<Stack")) {
      modified = insertBefore(modified, "<Stack", "<ErrorBoundary>\n        ");
      const lastStackClose = modified.lastIndexOf("</Stack>");
      if (lastStackClose !== -1) {
        const afterClose = lastStackClose + "</Stack>".length;
        modified = modified.slice(0, afterClose) + "\n        </ErrorBoundary>" + modified.slice(afterClose);
      }
    }

    if (modified !== layoutContent) {
      await writeFile(layoutPath, modified, "utf8");
      actions.push({ file: "app/_layout.tsx", action: "modified", description: "Wrapped layout with ErrorBoundary" });
    }
  }

  return actions;
}

export async function resolveOfflineHandler(
  repoPath: string,
  mobileRoot: string,
): Promise<FileAction[]> {
  const actions: FileAction[] = [];
  const base = mobileRoot === "." ? repoPath : join(repoPath, mobileRoot);

  const hookFile = join(base, "src", "hooks", "useNetworkStatus.ts");
  if (!(await fileExists(hookFile))) {
    await safeWrite(hookFile, networkStatusHookTemplate());
    actions.push({ file: "src/hooks/useNetworkStatus.ts", action: "created", description: "Network connectivity hook using @react-native-community/netinfo" });
  } else {
    actions.push({ file: "src/hooks/useNetworkStatus.ts", action: "skipped", description: "Already exists" });
  }

  const bannerFile = join(base, "src", "components", "OfflineBanner.tsx");
  if (!(await fileExists(bannerFile))) {
    await safeWrite(bannerFile, offlineBannerTemplate());
    actions.push({ file: "src/components/OfflineBanner.tsx", action: "created", description: "Offline status banner component" });
  } else {
    actions.push({ file: "src/components/OfflineBanner.tsx", action: "skipped", description: "Already exists" });
  }

  const layoutPath = join(base, "app", "_layout.tsx");
  const layoutContent = await safeRead(layoutPath);
  if (layoutContent && !layoutContent.includes("OfflineBanner")) {
    let modified = addImport(layoutContent, "import { OfflineBanner } from '@/components/OfflineBanner';");

    const stackMarker = "<Stack\n";
    const stackMarkerAlt = "<Stack ";
    const marker = modified.includes(stackMarker) ? stackMarker : stackMarkerAlt;
    if (modified.includes(marker)) {
      modified = insertBefore(modified, marker, "<OfflineBanner />\n          ");
    }

    if (modified !== layoutContent) {
      await writeFile(layoutPath, modified, "utf8");
      actions.push({ file: "app/_layout.tsx", action: "modified", description: "Added OfflineBanner to root layout" });
    }
  }

  return actions;
}

export async function resolveRateLimiting(
  repoPath: string,
  edgeFunctions: Array<{ name: string; path: string }>,
  backendRoot?: string,
): Promise<FileAction[]> {
  const actions: FileAction[] = [];
  if (!backendRoot || edgeFunctions.length === 0) return actions;

  const sharedDir = join(repoPath, backendRoot, "functions", "_shared");
  const rateLimitFile = join(sharedDir, "rate-limit.ts");

  if (await fileExists(rateLimitFile)) {
    actions.push({ file: `${backendRoot}/functions/_shared/rate-limit.ts`, action: "skipped", description: "Already exists" });
    return actions;
  }

  await safeWrite(rateLimitFile, rateLimitTemplate());
  actions.push({
    file: `${backendRoot}/functions/_shared/rate-limit.ts`,
    action: "created",
    description: `Rate limiter utility for ${edgeFunctions.length} edge function(s)`,
  });

  return actions;
}

export async function resolvePaywallGates(
  repoPath: string,
  mobileRoot: string,
  gates: GateConfig[],
  projectName: string,
): Promise<FileAction[]> {
  const actions: FileAction[] = [];
  if (gates.length === 0) return actions;

  const base = mobileRoot === "." ? repoPath : join(repoPath, mobileRoot);
  const paywallFile = join(base, "src", "lib", "paywall.ts");

  if (await fileExists(paywallFile)) {
    actions.push({ file: "src/lib/paywall.ts", action: "skipped", description: "Already exists" });
    return actions;
  }

  await safeWrite(paywallFile, paywallTemplate(gates, projectName));
  actions.push({
    file: "src/lib/paywall.ts",
    action: "created",
    description: `Paywall gate definitions (${gates.length} gates) from monetization_architect`,
  });

  return actions;
}

export async function resolveAnalytics(
  repoPath: string,
  mobileRoot: string,
  events: AnalyticsEventConfig[],
  projectName: string,
): Promise<FileAction[]> {
  const actions: FileAction[] = [];
  if (events.length === 0) return actions;

  const base = mobileRoot === "." ? repoPath : join(repoPath, mobileRoot);
  const analyticsFile = join(base, "src", "lib", "analytics.ts");

  if (await fileExists(analyticsFile)) {
    actions.push({ file: "src/lib/analytics.ts", action: "skipped", description: "Already exists" });
    return actions;
  }

  await safeWrite(analyticsFile, analyticsTemplate(events, projectName));
  actions.push({
    file: "src/lib/analytics.ts",
    action: "created",
    description: `Analytics event tracker (${events.length} events) from monetization_architect`,
  });

  return actions;
}
