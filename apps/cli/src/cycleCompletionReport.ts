import chalk from "chalk";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PipelineIndependentQa } from "./cursorAutomation.js";
import { truncateForDisplay } from "./cursorAutomation.js";
import {
  collectBuildSpecAddressedTexts,
  investorDirectiveAppearsBuilt,
  isEnvironmentalWorkItem,
  readBuildSpecFromRepo,
  readBuildSpecLedger,
} from "@foundry/core/buildSpec";
import { isDeferredPlumbingWorkPacketItem, isNonActionableWorkPacketItem, type WorkPacket } from "./workPacket.js";

export type FeedbackLedgerItem = {
  id: string;
  summary: string;
  status: "open" | "resolved" | "ignored";
  shouldImplement: boolean;
  source: string;
  implementationNote?: string;
};

export type CycleWorkScope = {
  feedbackIds: string[];
  feedbackSummaries: Map<string, string>;
  investorDirectives: string[];
  packetKeys: string[];
  packetSummaries: Map<string, string>;
};

export type CompletionRow = {
  kind: "Feedback" | "Investor" | "Packet" | "QA";
  label: string;
  built: boolean;
  tested: boolean;
};

function isEnvironmentalFeedbackItem(item: { summary?: string; type?: string }): boolean {
  return isEnvironmentalWorkItem(`${item.summary ?? ""} ${item.type ?? ""}`);
}

function isMetaFeedbackChurn(item: FeedbackLedgerItem): boolean {
  const s = item.summary.toLowerCase();
  return (
    item.source.startsWith("foundry:") ||
    /\bautomation_log\b/.test(s) ||
    /\bbuilder\.log\b/.test(s) ||
    /\bopen feedback ledger items with\b/.test(s)
  );
}

export function captureCycleWorkScope(
  ledgerItems: FeedbackLedgerItem[],
  workPacket: WorkPacket | undefined,
  investorDirectives: string[],
): CycleWorkScope {
  const feedbackIds: string[] = [];
  const feedbackSummaries = new Map<string, string>();
  for (const item of ledgerItems) {
    if (item.status !== "open") continue;
    if (!item.shouldImplement || isEnvironmentalFeedbackItem(item) || isMetaFeedbackChurn(item)) continue;
    feedbackIds.push(item.id);
    feedbackSummaries.set(item.id, item.summary);
  }

  const packetKeys: string[] = [];
  const packetSummaries = new Map<string, string>();
  for (const item of workPacket?.items ?? []) {
    if (item.status !== "open") continue;
    if (isNonActionableWorkPacketItem(item.text) || isDeferredPlumbingWorkPacketItem(item.text)) continue;
    packetKeys.push(item.key);
    packetSummaries.set(item.key, item.text);
  }

  return {
    feedbackIds,
    feedbackSummaries,
    investorDirectives: [...investorDirectives],
    packetKeys,
    packetSummaries,
  };
}

export function summarizeFeedbackLedgerCounts(items: FeedbackLedgerItem[]): string {
  const actionable = items.filter(
    (i) => i.shouldImplement && !isEnvironmentalFeedbackItem(i) && !isMetaFeedbackChurn(i),
  );
  const resolved = actionable.filter((i) => i.status === "resolved").length;
  const open = actionable.filter((i) => i.status === "open").length;
  return `${resolved} resolved · ${open} open`;
}

async function investorDirectiveBuilt(
  repoPath: string,
  directive: string,
  addressedTexts: string[],
): Promise<boolean> {
  return investorDirectiveAppearsBuilt(directive, addressedTexts, repoPath);
}

export async function buildCompletionRows(
  repoPath: string,
  scope: CycleWorkScope,
  qa: PipelineIndependentQa | undefined,
  ledgerItems: FeedbackLedgerItem[],
): Promise<CompletionRow[]> {
  const byId = new Map(ledgerItems.map((i) => [i.id, i]));
  const qaShip =
    qa?.recommendation === "ship" &&
    (qa?.blockers?.length ?? 0) === 0 &&
    qa?.testsPassed !== false;

  const spec = await readBuildSpecFromRepo(repoPath);
  const buildLedger = await readBuildSpecLedger(repoPath);
  const addressedTexts = collectBuildSpecAddressedTexts(spec, buildLedger);

  const rows: CompletionRow[] = [];

  for (const id of scope.feedbackIds) {
    const item = byId.get(id);
    if (!item) continue;
    const built = item.status === "resolved";
    rows.push({
      kind: "Feedback",
      label: scope.feedbackSummaries.get(id) ?? item.summary,
      built,
      tested: built && qaShip,
    });
  }

  for (const directive of scope.investorDirectives) {
    const built = await investorDirectiveBuilt(repoPath, directive, addressedTexts);
    rows.push({
      kind: "Investor",
      label: directive,
      built,
      tested: built && qaShip,
    });
  }

  let packet: WorkPacket | undefined;
  try {
    packet = JSON.parse(
      await readFile(join(repoPath, ".foundry", "WORK_PACKET.json"), "utf8"),
    ) as WorkPacket;
  } catch {
    packet = undefined;
  }
  const packetByKey = new Map((packet?.items ?? []).map((i) => [i.key, i]));
  for (const key of scope.packetKeys) {
    const item = packetByKey.get(key);
    if (!item) continue;
    const built = item.status === "closed";
    rows.push({
      kind: "Packet",
      label: scope.packetSummaries.get(key) ?? item.text,
      built,
      tested: built && qaShip,
    });
  }

  for (const blocker of qa?.blockers ?? []) {
    rows.push({
      kind: "QA",
      label: blocker,
      built: false,
      tested: qaShip,
    });
  }

  return rows;
}

function checkbox(done: boolean): string {
  return done ? chalk.green("[x]") : chalk.gray("[ ]");
}

export function logCompletionTable(
  rows: CompletionRow[],
  qa: PipelineIndependentQa | undefined,
  title: string,
): void {
  if (rows.length === 0) return;

  const qaShip =
    qa?.recommendation === "ship" &&
    (qa?.blockers?.length ?? 0) === 0 &&
    qa?.testsPassed !== false;

  const built = rows.filter((r) => r.built).length;
  const tested = rows.filter((r) => r.tested).length;
  const byKind = (kind: CompletionRow["kind"]) => rows.filter((r) => r.kind === kind);

  console.log(chalk.bold(`\n  ${title}`));
  console.log(chalk.gray("  done   tested  kind       item"));
  console.log(chalk.gray("  ─────  ──────  ─────────  ────────────────────────────────────────"));

  for (const row of rows) {
    const kind = row.kind.padEnd(9);
    const label = truncateForDisplay(row.label.replace(/\s+/g, " "), 72);
    console.log(
      `  ${checkbox(row.built)}     ${checkbox(row.tested)}     ${chalk.cyan(kind)}  ${label}`,
    );
  }

  const fb = byKind("Feedback");
  const inv = byKind("Investor");
  const pkt = byKind("Packet");
  const parts: string[] = [];
  if (fb.length) parts.push(`feedback ${fb.filter((r) => r.built).length}/${fb.length} built`);
  if (inv.length) parts.push(`investor ${inv.filter((r) => r.built).length}/${inv.length} built`);
  if (pkt.length) parts.push(`packet ${pkt.filter((r) => r.built).length}/${pkt.length} closed`);
  parts.push(`QA ${qaShip ? "ship" : qa?.recommendation ?? "?"}`);
  console.log(chalk.gray("  ───────────────────────────────────────────────────────────────────────"));
  console.log(
    chalk.gray(
      `  Totals: ${built}/${rows.length} built · ${tested}/${rows.length} tested · ${parts.join(" · ")}`,
    ),
  );
}
