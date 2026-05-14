import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type WorkPacketSection =
  | "qa"
  | "runtime"
  | "must"
  | "gaps"
  | "should"
  | "monetization"
  | "edge"
  | "builder";

export type WorkPacketStatus = "open" | "closed" | "manual_only";

export interface WorkPacketItem {
  id: string;
  key: string;
  source: "qa" | "brief" | "builder";
  section: WorkPacketSection;
  text: string;
  status: WorkPacketStatus;
  priority: number;
  reopenCount: number;
}

export interface WorkPacket {
  version: 1;
  runId: string;
  createdAt: string;
  updatedAt: string;
  maxItems: number;
  briefBacklogOpen: number;
  items: WorkPacketItem[];
  deferredCounts: Record<WorkPacketSection, number>;
  manualOnly: string[];
}

export type BriefTrackedSection = "must" | "should" | "gaps" | "monetization" | "edge" | "runtime";

export type BriefOpenItem = {
  section: BriefTrackedSection;
  text: string;
};

type PacketSignals = {
  briefOpenItems: BriefOpenItem[];
  checkedBriefItems: string[];
  qaCodeBlockers: string[];
  builderCodeBlockers: string[];
  manualOnly: string[];
  codeChanged: boolean;
};

export type WorkPacketSourceInput = PacketSignals & {
  repoPath: string;
  runId: string;
  maxItems?: number;
};

function normalizeKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 180);
}

/** Not addressable by a normal Cursor coding pass — ops, GTM, hosted DB, or device-lab ACs. */
export function isStructuralNonCodeBriefItem(text: string): boolean {
  const t = text.toLowerCase();
  if (/repeatable acquisition|acquisition channel|business\/marketing|marketing item/i.test(text)) return true;
  if (/ac-04|ac-05/.test(t) && /device|e2e|performance|sync|cross-device/i.test(t)) return true;
  if (/acceptance tests.*device|device-level e2e/i.test(t)) return true;
  if (/supabase db push|hosted database|apply to the hosted|migration.*apply/i.test(t)) return true;
  return false;
}

function priorityForSection(section: WorkPacketSection): number {
  switch (section) {
    case "qa":
      return 0;
    case "runtime":
      return 1;
    case "must":
      return 2;
    case "gaps":
      return 3;
    case "should":
      return 4;
    case "monetization":
      return 5;
    case "edge":
      return 6;
    case "builder":
      return 7;
    default:
      return 99;
  }
}

function sectionLabel(section: WorkPacketSection): string {
  switch (section) {
    case "qa":
      return "QA";
    case "runtime":
      return "Runtime";
    case "must":
      return "Must";
    case "gaps":
      return "Gap";
    case "should":
      return "Should";
    case "monetization":
      return "Monetization";
    case "edge":
      return "Edge";
    case "builder":
      return "Builder";
    default:
      return section;
  }
}

/**
 * While QA is not ship-clean, stabilize mode keeps the work packet focused on **tests/lint/Maestro**
 * (via `qa` rows) plus **must / runtime** brief lines only — not gaps/monetization/edge/should.
 * After `recommendation === "ship"` and zero blockers, the full brief is eligible again for release prep.
 */
export function filterBriefItemsForStabilizePhase(
  items: BriefOpenItem[],
  pipelineQa: { recommendation?: string; blockers?: string[] } | undefined,
): BriefOpenItem[] {
  const qaClean =
    pipelineQa &&
    pipelineQa.recommendation === "ship" &&
    (pipelineQa.blockers?.length ?? 0) === 0;
  if (qaClean) return items;
  return items.filter((i) => i.section === "must" || i.section === "runtime");
}

export async function readOpenBriefItems(briefPath: string): Promise<BriefOpenItem[]> {
  let raw = "";
  try {
    raw = await readFile(briefPath, "utf8");
  } catch {
    return [];
  }

  const out: BriefOpenItem[] = [];
  let section: BriefTrackedSection | "other" = "other";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "### Must Ship (Phase 1)") section = "must";
    else if (trimmed === "### Should Ship (stretch)") section = "should";
    else if (trimmed === "## Unresolved Gaps (Cursor should fix these)") section = "gaps";
    else if (trimmed === "## Monetization Integration") section = "monetization";
    else if (trimmed === "## Edge Function Rate Limiting") section = "edge";
    else if (trimmed === "## Runtime Failures To Fix First") section = "runtime";
    else if (trimmed.startsWith("## ") || trimmed.startsWith("### ")) section = "other";

    if (!trimmed.startsWith("- [ ]")) continue;
    if (section === "other") continue;
    const text = trimmed.replace(/^- \[ \]\s*/, "").trim();
    if (!text) continue;
    out.push({ section, text });
  }
  return out;
}

export async function readCheckedBriefItems(briefPath: string): Promise<string[]> {
  let raw = "";
  try {
    raw = await readFile(briefPath, "utf8");
  } catch {
    return [];
  }

  const out: string[] = [];
  let section: BriefTrackedSection | "other" = "other";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "### Must Ship (Phase 1)") section = "must";
    else if (trimmed === "### Should Ship (stretch)") section = "should";
    else if (trimmed === "## Unresolved Gaps (Cursor should fix these)") section = "gaps";
    else if (trimmed === "## Monetization Integration") section = "monetization";
    else if (trimmed === "## Edge Function Rate Limiting") section = "edge";
    else if (trimmed === "## Runtime Failures To Fix First") section = "runtime";
    else if (trimmed.startsWith("## ") || trimmed.startsWith("### ")) section = "other";

    if (!trimmed.startsWith("- [x]")) continue;
    if (section === "other") continue;
    const text = trimmed.replace(/^- \[x\]\s*/, "").trim();
    if (!text) continue;
    out.push(text);
  }
  return out;
}

function emptyDeferredCounts(): Record<WorkPacketSection, number> {
  return {
    qa: 0,
    runtime: 0,
    must: 0,
    gaps: 0,
    should: 0,
    monetization: 0,
    edge: 0,
    builder: 0,
  };
}

function packetPaths(repoPath: string): { json: string; md: string } {
  return {
    json: join(repoPath, ".foundry", "WORK_PACKET.json"),
    md: join(repoPath, ".foundry", "WORK_PACKET.md"),
  };
}

function choosePacketItems(candidates: WorkPacketItem[], maxItems: number): WorkPacketItem[] {
  return candidates.slice(0, maxItems);
}

function isNoOpPacketText(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    /no files changed.*already present/.test(t) ||
    /^nothing to do\b/.test(t) ||
    /^no-op\b/.test(t) ||
    /external to the repository/.test(t) ||
    /not by product code/.test(t) ||
    /shell_session_update/.test(t) ||
    /repository-wide hygiene warnings/.test(t) ||
    /non-blocking.*outside/.test(t) ||
    /playwright chromium was not installed/.test(t) ||
    /\benospc\b/.test(t)
  );
}

async function writePacketFiles(repoPath: string, packet: WorkPacket): Promise<void> {
  const paths = packetPaths(repoPath);
  await mkdir(join(repoPath, ".foundry"), { recursive: true });
  await writeFile(paths.json, JSON.stringify(packet, null, 2) + "\n", "utf8");
  await writeFile(paths.md, renderWorkPacketMarkdown(packet), "utf8");
}

export async function createWorkPacket(input: WorkPacketSourceInput): Promise<WorkPacket> {
  const maxItems = input.maxItems ?? 14;
  const candidates: WorkPacketItem[] = [];
  const seen = new Set<string>();
  const extraManual = new Set(input.manualOnly);
  let seq = 0;
  const push = (
    source: WorkPacketItem["source"],
    section: WorkPacketSection,
    text: string,
  ) => {
    const key = normalizeKey(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidates.push({
      id: `pkt-${++seq}`,
      key,
      source,
      section,
      text,
      status: "open",
      priority: priorityForSection(section),
      reopenCount: 0,
    });
  };

  for (const blocker of input.qaCodeBlockers) push("qa", "qa", blocker);
  for (const item of input.briefOpenItems) {
    if (isStructuralNonCodeBriefItem(item.text)) {
      extraManual.add(`[brief:${item.section}] ${item.text}`);
      continue;
    }
    push("brief", item.section, item.text);
  }
  for (const blocker of input.builderCodeBlockers) {
    if (isNoOpPacketText(blocker)) continue;
    if (isStructuralNonCodeBriefItem(blocker)) {
      extraManual.add(`[builder] ${blocker}`);
      continue;
    }
    push("builder", "builder", blocker);
  }

  candidates.sort((a, b) => a.priority - b.priority || a.text.localeCompare(b.text));
  const items = choosePacketItems(candidates, maxItems);
  const selectedKeys = new Set(items.map((item) => item.key));
  const deferredCounts = emptyDeferredCounts();
  for (const candidate of candidates) {
    if (!selectedKeys.has(candidate.key)) {
      deferredCounts[candidate.section] += 1;
    }
  }

  const packet: WorkPacket = {
    version: 1,
    runId: input.runId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    maxItems,
    briefBacklogOpen: input.briefOpenItems.length,
    items,
    deferredCounts,
    manualOnly: [...extraManual],
  };
  await writePacketFiles(input.repoPath, packet);
  return packet;
}

export async function refreshWorkPacket(
  repoPath: string,
  packet: WorkPacket,
  signals: PacketSignals,
): Promise<WorkPacket> {
  const openKeys = new Set<string>();
  for (const item of signals.briefOpenItems) openKeys.add(normalizeKey(item.text));
  for (const item of signals.qaCodeBlockers) openKeys.add(normalizeKey(item));
  for (const item of signals.builderCodeBlockers) openKeys.add(normalizeKey(item));
  const checkedKeys = new Set(signals.checkedBriefItems.map((item) => normalizeKey(item)));

  const manualKeys = new Set(signals.manualOnly.map((item) => normalizeKey(item)));
  const items = packet.items.map((item) => {
    const next = { ...item };
    let nextStatus: WorkPacketStatus = "open";
    if (manualKeys.has(item.key)) {
      nextStatus = "manual_only";
    } else if (item.source === "brief") {
      nextStatus = checkedKeys.has(item.key) ? "closed" : "open";
    } else if (signals.codeChanged && !openKeys.has(item.key)) {
      nextStatus = "closed";
    }
    if (item.status === "closed" && nextStatus === "open") {
      next.reopenCount += 1;
    }
    next.status = nextStatus;
    return next;
  });

  const updated: WorkPacket = {
    ...packet,
    updatedAt: new Date().toISOString(),
    briefBacklogOpen: signals.briefOpenItems.length,
    manualOnly: [...new Set(signals.manualOnly)],
    items,
  };
  await writePacketFiles(repoPath, updated);
  return updated;
}

export function workPacketOpenCount(packet: WorkPacket | undefined): number {
  if (!packet) return 0;
  return packet.items.filter((item) => item.status === "open").length;
}

export function workPacketClosedCount(packet: WorkPacket | undefined): number {
  if (!packet) return 0;
  return packet.items.filter((item) => item.status === "closed").length;
}

export function workPacketReopenCount(packet: WorkPacket | undefined): number {
  if (!packet) return 0;
  return packet.items.reduce((sum, item) => sum + item.reopenCount, 0);
}

export function workPacketSummaryLine(packet: WorkPacket | undefined): string {
  if (!packet) return "packet missing";
  const open = workPacketOpenCount(packet);
  const closed = workPacketClosedCount(packet);
  const manual = packet.items.filter((item) => item.status === "manual_only").length;
  return `open=${open}/${packet.items.length} · closed=${closed} · manual_only=${manual} · deferred_backlog=${Object.values(packet.deferredCounts).reduce((a, b) => a + b, 0)}`;
}

export function sampleOpenPacketItems(packet: WorkPacket | undefined, maxTotal: number, maxLineLen = 120): string[] {
  if (!packet) return [];
  return packet.items
    .filter((item) => item.status === "open")
    .slice(0, maxTotal)
    .map((item) => `[${sectionLabel(item.section)}] ${truncate(item.text, maxLineLen)}`);
}

function truncate(text: string, maxLen: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= maxLen) return one;
  return `${one.slice(0, Math.max(0, maxLen - 1))}…`;
}

export function renderWorkPacketMarkdown(packet: WorkPacket): string {
  const lines: string[] = [
    "# Foundry Work Packet",
    "",
    "This packet freezes the current inner-loop scope.",
    "Close these items before widening to the deferred backlog.",
    "",
    `- run: \`${packet.runId}\``,
    `- max_items: ${packet.maxItems}`,
    `- updated_at: ${packet.updatedAt}`,
    `- brief_backlog_open: ${packet.briefBacklogOpen}`,
    "",
    "## Active Packet Items",
    "",
  ];

  const active = packet.items.filter((item) => item.status !== "closed");
  if (active.length === 0) {
    lines.push("_No active items remain in this packet._", "");
  } else {
    for (const item of active) {
      lines.push(`- [${item.status === "closed" ? "x" : " "}] [${sectionLabel(item.section)}] ${item.text}`);
    }
    lines.push("");
  }

  lines.push("## Closed In This Packet", "");
  const closed = packet.items.filter((item) => item.status === "closed");
  if (closed.length === 0) {
    lines.push("_None yet._", "");
  } else {
    for (const item of closed) {
      const reopened = item.reopenCount > 0 ? ` (reopened ${item.reopenCount}x)` : "";
      lines.push(`- [x] [${sectionLabel(item.section)}] ${item.text}${reopened}`);
    }
    lines.push("");
  }

  lines.push("## Deferred Backlog Counts", "");
  for (const [section, count] of Object.entries(packet.deferredCounts)) {
    if (count > 0) lines.push(`- ${sectionLabel(section as WorkPacketSection)}: ${count}`);
  }
  if (Object.values(packet.deferredCounts).every((count) => count === 0)) {
    lines.push("_None._");
  }
  lines.push("");

  lines.push("## Manual-Only Blockers", "");
  if (packet.manualOnly.length === 0) {
    lines.push("_None._", "");
  } else {
    for (const item of packet.manualOnly) lines.push(`- ${item}`);
    lines.push("");
  }

  lines.push("## Policy", "");
  lines.push("- Finish the active packet before expanding scope.");
  lines.push("- Use `.foundry/CURSOR_BRIEF.md` for implementation detail, not to widen scope.");
  lines.push("- If an item is impossible in this repo, document it in `.foundry/CURSOR_BUILDER_REPORT.md`.");
  lines.push("");
  return lines.join("\n");
}
