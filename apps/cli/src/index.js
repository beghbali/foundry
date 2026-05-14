#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { mkdir, writeFile, access, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { loadFoundryConfig, listRegisteredStageNames, runPipeline } from "@foundry/core";
import { chooseBuilderModel, qaNeedsPremiumCursorBuilder, qaMaestroSmokeOnlyShipGreen, resolveEffectiveInnerLoopMax, countCriticalBriefItems, formatIterationFocusMarkdown, getPipelineSnapshotForConsole, logShipGateConsole, separateManualAndCodeItems, summarizeCoreQaPlanForConsole, summarizeCursorBuilderReportMd, truncateForDisplay, preflightCursorCommand, preflightCursorModels, readBuilderRemainingBlockers, readStageJson, resolveCursorAutomationSettings, runBuilderAgent, sampleUncheckedBriefLines, shouldRunCursorAutomation, } from "./cursorAutomation.js";
import { backfillExpoBuildViews, maybeRunApprovedEasBuild, maybeSubmitLatestToTestFlight, promoteApprovedBranch, resolveEasBuildSettings, } from "./releaseAutomation.js";
import { createWorkPacket, filterBriefItemsForStabilizePhase, readCheckedBriefItems, readOpenBriefItems, refreshWorkPacket, sampleOpenPacketItems, workPacketClosedCount, workPacketOpenCount, workPacketReopenCount, workPacketSummaryLine, } from "./workPacket.js";
function logEasQueuedToConsole(easBuild, blankLineBeforeTitle) {
    const title = blankLineBeforeTitle ? "\n  EAS build queued." : "  EAS build queued.";
    console.log(chalk.green.bold(title));
    if (easBuild.buildUrl)
        console.log(chalk.green(`  Build URL: ${easBuild.buildUrl}`));
    if (easBuild.qrCodePngPath) {
        console.log(chalk.gray("  Scannable QR (open this image and scan with the phone camera — most reliable):"));
        console.log(chalk.cyan(`  ${easBuild.qrCodePngPath}`));
    }
    if (easBuild.qrCodeAscii) {
        console.log(chalk.gray("  Terminal QR (larger cells than before; may still be hard to scan — use PNG above if needed):"));
        console.log(easBuild.qrCodeAscii);
    }
    if (easBuild.logPath)
        console.log(chalk.gray(`  Build log: ${easBuild.logPath}`));
}
function logTestFlightSubmitToConsole(result, blankLineBeforeTitle) {
    const title = blankLineBeforeTitle ? "\n  TestFlight submit queued." : "  TestFlight submit queued.";
    console.log(chalk.green.bold(title));
    console.log(chalk.green(`  ${result.detail}`));
    if (result.logPath)
        console.log(chalk.gray(`  Submit log: ${result.logPath}`));
}
function extractBuilderBlockers(builder) {
    if (!builder?.notes?.length)
        return [];
    const blockerPattern = /(blocked|failed|could not|no resolvable|no files changed|review commands|cannot|error)/i;
    return builder.notes.filter((note) => blockerPattern.test(note)).slice(0, 6);
}
function isNoOpPacketText(text) {
    const t = text.trim().toLowerCase();
    return (/no files changed.*already present/.test(t) ||
        /^nothing to do\b/.test(t) ||
        /^no-op\b/.test(t));
}
function packetBriefCounts(packet) {
    const counts = {
        mustShip: 0,
        shouldShip: 0,
        unresolvedGaps: 0,
        monetization: 0,
        edgeFunctions: 0,
        runtime: 0,
        total: 0,
    };
    for (const item of packet?.items ?? []) {
        if (item.status !== "open")
            continue;
        if (isNoOpPacketText(item.text))
            continue;
        if (item.section === "runtime")
            counts.runtime++;
        else if (item.section === "must" || item.section === "qa")
            counts.mustShip++;
        else if (item.section === "should")
            counts.shouldShip++;
        else if (item.section === "gaps" || item.section === "builder")
            counts.unresolvedGaps++;
        else if (item.section === "monetization")
            counts.monetization++;
        else if (item.section === "edge")
            counts.edgeFunctions++;
    }
    counts.total =
        counts.mustShip +
            counts.shouldShip +
            counts.unresolvedGaps +
            counts.monetization +
            counts.edgeFunctions +
            counts.runtime;
    return counts;
}
function safeLen(arr) {
    return Array.isArray(arr) ? arr.length : 0;
}
function blockedChecklistCount(release) {
    return safeLen((release?.releaseChecklist ?? []).filter((i) => i.status === "blocked"));
}
function postCursorPipelineStages(profile) {
    if (profile === "investor") {
        return ["independent_qa", "release_agent", "growth_operator", "investor_panel"];
    }
    return ["independent_qa", "release_agent"];
}
/** Stabilize loops never run growth/investor after Cursor — only QA + release gates. */
function postCursorStagesForLoop(profile, stabilize) {
    if (stabilize)
        return ["independent_qa", "release_agent"];
    return postCursorPipelineStages(profile);
}
/** Ship-quality release candidate: QA ship + release_agent green + no blocked release checklist rows. */
function releaseCandidateVerdict(qa, release) {
    if (!qa || qa.recommendation !== "ship") {
        return { yes: false, reason: `independent_qa not ship (${qa?.recommendation ?? "missing"})` };
    }
    if (Array.isArray(qa.blockers) && qa.blockers.length > 0) {
        return {
            yes: false,
            reason: `independent_qa still lists ${qa.blockers.length} blocker(s) (e.g. Maestro) — not a clean QA gate yet`,
        };
    }
    if (!release) {
        return { yes: false, reason: "release_agent output missing" };
    }
    if (release.status === "blocked_by_qa") {
        return { yes: false, reason: "release_agent blocked_by_qa" };
    }
    if (release.status === "blocked_pre_release") {
        return { yes: false, reason: "release_agent blocked_pre_release (QA ship; brief/builder/checklist)" };
    }
    const blocked = blockedChecklistCount(release);
    if (blocked > 0) {
        return { yes: false, reason: `${blocked} blocked row(s) on release checklist` };
    }
    if (release.status === "approved" || release.status === "auto_approved" || release.status === "awaiting_approval") {
        return { yes: true, reason: `release status=${release.status}` };
    }
    return { yes: false, reason: `release status=${release.status ?? "?"}` };
}
function logReleaseCandidateLine(qa, release) {
    const v = releaseCandidateVerdict(qa, release);
    if (v.yes) {
        console.log(chalk.green.bold(`\n  RELEASE_CANDIDATE: YES  (${v.reason})`));
    }
    else {
        console.log(chalk.red.bold(`\n  RELEASE_CANDIDATE: NO  (${v.reason})`));
    }
}
function logInvestorScoreLine(investor) {
    if (!investor?.investors?.length) {
        console.log(chalk.gray("\n  INVESTOR_PANEL: (no output this run — stage skipped or not executed)"));
        return;
    }
    const grades = investor.investors.map((i) => `${i.displayName ?? "investor"}=${i.grade ?? "?"}`).join(" · ");
    const bar = investor.meetsMinimumGradeA ? chalk.green("meets A- bar: YES") : chalk.yellow("meets A- bar: NO");
    console.log(chalk.bold(`\n  INVESTOR_SCORES: ${grades}`));
    console.log(chalk.gray(`  worst=${investor.worstGrade ?? "?"} · ${bar}`));
    const d = investor.combinedRefinementDirectives?.length ?? 0;
    if (d > 0) {
        console.log(chalk.gray(`  refinement directives queued: ${d} (fed into next product stages when refinement runs)`));
    }
}
async function readBriefMetrics(briefPath) {
    let raw = "";
    try {
        raw = await readFile(briefPath, "utf8");
    }
    catch {
        return { open: 0, checked: 0, total: 0 };
    }
    let section = "other";
    let open = 0;
    let checked = 0;
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "### Must Ship (Phase 1)")
            section = "must";
        else if (trimmed === "### Should Ship (stretch)")
            section = "should";
        else if (trimmed === "## Unresolved Gaps (Cursor should fix these)")
            section = "gaps";
        else if (trimmed === "## Monetization Integration")
            section = "monetization";
        else if (trimmed === "## Edge Function Rate Limiting")
            section = "edge";
        else if (trimmed === "## Runtime Failures To Fix First")
            section = "runtime";
        else if (trimmed.startsWith("## ") || trimmed.startsWith("### "))
            section = "other";
        if (section === "other")
            continue;
        if (trimmed.startsWith("- [ ]"))
            open++;
        if (trimmed.startsWith("- [x]"))
            checked++;
    }
    return { open, checked, total: open + checked };
}
async function findLatestPipelineRunId(foundryDir) {
    const outRoot = join(foundryDir, "out");
    let names;
    try {
        names = await readdir(outRoot);
    }
    catch {
        return undefined;
    }
    let best;
    for (const id of names) {
        try {
            const st = await stat(join(outRoot, id, "run.json"));
            if (!best || st.mtimeMs > best.ms)
                best = { id, ms: st.mtimeMs };
        }
        catch {
            /* not a run dir */
        }
    }
    return best?.id;
}
async function tryReadJson(path) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    }
    catch {
        return undefined;
    }
}
/** Readable snapshot: packet, brief, last QA/release/investor — without running the pipeline. */
async function printFoundryStatusDashboard(repoPath) {
    const foundryDir = join(repoPath, ".foundry");
    const briefPath = join(foundryDir, "CURSOR_BRIEF.md");
    const brief = await readBriefMetrics(briefPath);
    const bar = "═".repeat(56);
    console.log(chalk.bold.cyan(`\n${bar}`));
    console.log(chalk.bold.cyan("  FOUNDRY STATUS (read-only snapshot)"));
    console.log(chalk.bold.cyan(`${bar}`));
    console.log(chalk.gray(`  Repo: ${repoPath}\n`));
    const wpPath = join(foundryDir, "WORK_PACKET.json");
    const wpRaw = await tryReadJson(wpPath);
    const wp = wpRaw;
    console.log(chalk.bold.white("  ACTIVE WORK PACKET"));
    if (!wp?.items?.length) {
        console.log(chalk.gray("    (no WORK_PACKET.json — run a pipeline + loop to generate one)\n"));
    }
    else {
        const open = wp.items.filter((i) => i.status === "open");
        console.log(chalk.gray(`    Frozen for outer-cycle scope · packet run ${wp.runId ?? "?"} · ${open.length} open / ${wp.items.length} total`));
        console.log(chalk.gray("    Inner Cursor passes only target these lines (not the whole brief backlog at once).\n"));
        open.forEach((it, i) => {
            const tag = [it.source, it.section].filter(Boolean).join("/") || "item";
            console.log(chalk.yellow(`    ${i + 1}. [${tag}] ${truncateForDisplay(it.text ?? "", 118)}`));
        });
        console.log("");
        if (wp.manualOnly?.length) {
            console.log(chalk.bold.white("  MANUAL-ONLY (outside packet closure)"));
            wp.manualOnly.slice(0, 8).forEach((line, i) => {
                console.log(chalk.gray(`    ${i + 1}. ${truncateForDisplay(line, 118)}`));
            });
            console.log("");
        }
    }
    console.log(chalk.bold.white("  BRIEF (tracked sections)"));
    console.log(chalk.gray(`    Open: ${brief.open} · Checked: ${brief.checked} · Total: ${brief.total}  →  ${join(foundryDir, "CURSOR_BRIEF.md")}`));
    if (brief.open > 0) {
        const bl = await sampleUncheckedBriefLines(briefPath, 15);
        if (bl.length > 0) {
            console.log(chalk.gray("    Open `- [ ]` lines:"));
            bl.forEach((line, i) => console.log(chalk.yellow(`      ${i + 1}. ${truncateForDisplay(line, 112)}`)));
        }
        console.log(chalk.gray(`    Mirror: ${join(foundryDir, "OPEN_TRACKED_BRIEF.md")} (from last release_agent run)`));
    }
    console.log("");
    const runId = await findLatestPipelineRunId(foundryDir);
    if (!runId) {
        console.log(chalk.bold.white("  LAST PIPELINE RUN"));
        console.log(chalk.gray("    (no .foundry/out/<run>/ yet — run `foundry run` once)\n"));
        console.log(chalk.bold.dim(`${bar}\n`));
        return;
    }
    const outDir = join(foundryDir, "out", runId);
    const qa = (await tryReadJson(join(outDir, "independent_qa", "output.json")));
    const release = (await tryReadJson(join(outDir, "release_agent", "output.json")));
    const investor = (await tryReadJson(join(outDir, "investor_panel", "output.json")));
    console.log(chalk.bold.white(`  LAST PIPELINE RUN  (${runId})`));
    const rec = qa?.recommendation ?? "missing";
    const bl = qa?.blockers ?? [];
    console.log(rec === "ship" && bl.length === 0
        ? chalk.green(`    independent_qa: ${rec} · score=${qa?.score ?? "—"} · blockers: none`)
        : chalk.yellow(`    independent_qa: ${rec} · score=${qa?.score ?? "—"} · blockers: ${bl.length}`));
    bl.slice(0, 6).forEach((b, i) => console.log(chalk.yellow(`      ${i + 1}. ${truncateForDisplay(b, 110)}`)));
    if (bl.length > 6)
        console.log(chalk.gray(`      … +${bl.length - 6} more`));
    const maestroCheck = qa?.checks?.find((c) => c.name === "maestro_smoke");
    if (maestroCheck && typeof maestroCheck === "object" && "details" in maestroCheck) {
        const d = String(maestroCheck.details ?? "");
        if (d && d.length > 20) {
            console.log(chalk.gray(`    Maestro check: ${truncateForDisplay(d.replace(/\s+/g, " ").trim(), 140)}`));
        }
    }
    console.log(chalk.gray(`    Artifacts: ${outDir}`));
    console.log("");
    console.log(chalk.bold.white("  RELEASE"));
    const rs = release?.status ?? "missing";
    console.log(chalk.gray(`    release_agent.status: ${rs}`));
    const blockedRows = (release?.releaseChecklist ?? []).filter((r) => r.status === "blocked");
    blockedRows.slice(0, 6).forEach((row, i) => {
        console.log(chalk.yellow(`      blocked ${i + 1}. ${truncateForDisplay(row.item + (row.notes ? ` — ${row.notes}` : ""), 108)}`));
    });
    console.log("");
    console.log(chalk.bold.white("  INVESTOR (same run, if stage ran)"));
    if (!investor?.investors?.length && !(investor?.combinedRefinementDirectives?.length ?? 0)) {
        console.log(chalk.gray("    (no investor_panel output in this run — use `foundry loop --profile investor`)\n"));
    }
    else {
        console.log(chalk.gray(`    meets_A-=${investor.meetsMinimumGradeA ? "yes" : "no"} · worst=${investor.worstGrade ?? "?"} · directives=${investor.combinedRefinementDirectives?.length ?? 0}`));
        (investor.investors ?? []).slice(0, 4).forEach((inv) => {
            console.log(chalk.gray(`      ${inv.displayName ?? "?"}: ${inv.grade ?? "?"}`));
        });
        const dirs = investor.combinedRefinementDirectives ?? [];
        dirs.slice(0, 5).forEach((d, i) => {
            console.log(chalk.cyan(`      D${i + 1}. ${truncateForDisplay(d, 110)}`));
        });
        if (dirs.length > 5)
            console.log(chalk.gray(`      … +${dirs.length - 5} more directives`));
        console.log("");
    }
    console.log(chalk.bold.white("  WHY THIS DOES NOT ALL CONVERGE AT ONCE"));
    console.log(chalk.gray("    • Work packet is one frozen slice per outer cycle — Maestro, monetization, and brief items are separate goals."));
    console.log(chalk.gray("    • Investor directives refine upstream stages (product_definition, etc.); they do not auto-remove packet rows."));
    console.log(chalk.gray("    • `foundry/*` builder branches and main are a merge/push gate — not conflicting feature code unless you have real merge conflicts."));
    console.log(chalk.gray("    • Maestro in CI/pipeline needs a simulator + app + Metro (or use `qa_automation.maestro.pipeline_command` → e.g. npm preflight)."));
    console.log("");
    console.log(chalk.bold.white("  COMMANDS"));
    console.log(chalk.gray("    foundry status --repo .          ← this dashboard"));
    console.log(chalk.gray("    foundry run --repo . --quiet     ← pipeline without per-stage log spam"));
    console.log(chalk.bold.dim(`${bar}\n`));
}
async function buildWorkPacketForRun(params) {
    const briefPath = join(params.foundryDir, "CURSOR_BRIEF.md");
    let briefOpenItems = await readOpenBriefItems(briefPath);
    if (params.stabilize) {
        briefOpenItems = filterBriefItemsForStabilizePhase(briefOpenItems, params.pipelineQa);
    }
    const qaSeparated = separateManualAndCodeItems([
        ...(params.pipelineQa?.blockers ?? []),
        ...(params.pipelineQa?.manualTasks ?? []),
    ]);
    const builderSeparated = separateManualAndCodeItems([
        ...extractBuilderBlockers(params.builder),
        ...params.builderRemainingBlockers,
    ]);
    return createWorkPacket({
        repoPath: params.repoPath,
        runId: params.runId,
        briefOpenItems,
        checkedBriefItems: await readCheckedBriefItems(briefPath),
        qaCodeBlockers: qaSeparated.code,
        builderCodeBlockers: builderSeparated.code,
        manualOnly: [...qaSeparated.manual, ...builderSeparated.manual],
        codeChanged: false,
    });
}
function parseCommittedChangesFromBuilder(builder) {
    if (!builder?.notes?.length)
        return 0;
    for (const note of builder.notes) {
        const m = /Committed\s+(\d+)\s+change\(s\)/i.exec(note);
        if (m?.[1])
            return Number.parseInt(m[1], 10) || 0;
    }
    return 0;
}
function isTestLikePath(path) {
    if (/^\.maestro\//i.test(path))
        return true;
    /** QA harness scripts are “test-like” infrastructure. */
    if (/^scripts\/(qa-device|maestro-preflight)\.sh$/i.test(path))
        return true;
    return /(^|\/)(test|tests|__tests__)\/|(\.|-)(test|spec)\.[a-z0-9]+$/i.test(path);
}
function isProductFeaturePath(path) {
    if (path.startsWith(".foundry/"))
        return false;
    if (path.startsWith(".maestro-debug/"))
        return false;
    /** `.maestro/*.yaml` is E2E infra — counts as product for feature work, but `isTestLikePath` also true for QA-repair gates. */
    if (isTestLikePath(path) && !/^\.maestro\//i.test(path))
        return false;
    if (/^(docs|scripts)\//i.test(path))
        return false;
    /** Committed Maestro flows (not generated `.maestro-debug/`). Counts as product when QA is driven by E2E. */
    if (/^\.maestro\//i.test(path))
        return true;
    // Monorepo apps
    if (/^apps\/[^/]+\/(src|app)\//i.test(path))
        return true;
    /** Expo/native app configuration can be the product fix for release build failures. */
    if (/^apps\/[^/]+\/(app\.config\.[cm]?[jt]s|app\.json|eas\.json|package\.json)$/i.test(path))
        return true;
    if (/^packages\/[^/]+\/src\//i.test(path))
        return true;
    if (/^supabase\/(functions|migrations)\//i.test(path))
        return true;
    // Expo / RN at repo root (mobileRoot ".") and common adjunct roots
    if (/^(app|src|components|hooks|lib|screens|services|constants|types|features|modules|navigation|utils|contexts|providers|theme|styles|shared|platform|config|plugins)\//i.test(path))
        return true;
    return false;
}
function isMonetizationLikePath(path) {
    return /(paywall|pricing|price|subscription|purchase|billing|entitlement|revenuecat|analytics|usagegate)/i.test(path);
}
function parseAdaptiveDirectiveSignals(builder) {
    if (!builder?.notes?.length)
        return { loaded: 0, active: 0 };
    for (const note of builder.notes) {
        const m = /Adaptive resolver memory updated:\s*(\d+)\s+active\s+\((\d+)\s+loaded this run\)/i.exec(note);
        if (m) {
            return {
                active: Number.parseInt(m[1] ?? "0", 10) || 0,
                loaded: Number.parseInt(m[2] ?? "0", 10) || 0,
            };
        }
    }
    return { loaded: 0, active: 0 };
}
function buildIterationProgress(brief, builder, qa, release, investor, packet, 
/** Last Cursor agent pass may touch files without updating the codegen `builder` stage artifact — count those for convergence. */
cursorAgentChangedFileCount) {
    const fromBuilderStage = safeLen(builder?.changes?.filesCreated) + safeLen(builder?.changes?.filesModified);
    const fromCursor = cursorAgentChangedFileCount ?? 0;
    const filesChanged = Math.max(fromBuilderStage, fromCursor);
    const committedChanges = parseCommittedChangesFromBuilder(builder);
    const adaptive = parseAdaptiveDirectiveSignals(builder);
    return {
        packetOpen: workPacketOpenCount(packet),
        packetClosed: workPacketClosedCount(packet),
        packetReopened: workPacketReopenCount(packet),
        briefOpen: brief.open,
        briefChecked: brief.checked,
        briefTotal: brief.total,
        feedbackAddressed: safeLen(builder?.plan?.feedbackAddressed),
        gapsAddressed: safeLen(builder?.plan?.gapsAddressed),
        filesChanged,
        committedChanges,
        adaptiveDirectivesLoaded: adaptive.loaded,
        adaptiveDirectivesActiveTotal: adaptive.active,
        investorDirectives: safeLen(investor?.combinedRefinementDirectives),
        qaBlockers: safeLen(qa?.blockers),
        qaManualTasks: safeLen(qa?.manualTasks),
        blockedChecklist: blockedChecklistCount(release),
    };
}
function deltaLabel(curr, prev) {
    if (prev === undefined)
        return "Δ n/a";
    const delta = curr - prev;
    const sign = delta > 0 ? "+" : "";
    return `Δ ${sign}${delta}`;
}
function logIterationProgress(progress, prev, builder, qa, release, investor, stagnantStreak) {
    const progressing = [];
    const notProgressing = [];
    if (prev) {
        if (progress.packetOpen < prev.packetOpen)
            progressing.push(`packet_open ${prev.packetOpen}→${progress.packetOpen}`);
        else
            notProgressing.push(`packet_open ${progress.packetOpen} (no decrease)`);
        if (progress.packetClosed > prev.packetClosed)
            progressing.push(`packet_closed ${prev.packetClosed}→${progress.packetClosed}`);
        if (progress.briefOpen < prev.briefOpen)
            progressing.push(`brief_open ${prev.briefOpen}→${progress.briefOpen}`);
        else
            notProgressing.push(`brief_open ${progress.briefOpen} (no decrease)`);
        if (progress.briefChecked > prev.briefChecked)
            progressing.push(`brief_checked ${prev.briefChecked}→${progress.briefChecked}`);
        else
            notProgressing.push(`brief_checked ${progress.briefChecked} (no increase)`);
        if (progress.qaBlockers < prev.qaBlockers)
            progressing.push(`qa_blockers ${prev.qaBlockers}→${progress.qaBlockers}`);
        if (progress.blockedChecklist < prev.blockedChecklist)
            progressing.push(`release_blocked ${prev.blockedChecklist}→${progress.blockedChecklist}`);
        if (progress.adaptiveDirectivesActiveTotal < prev.adaptiveDirectivesActiveTotal) {
            progressing.push(`adaptive_active ${prev.adaptiveDirectivesActiveTotal}→${progress.adaptiveDirectivesActiveTotal}`);
        }
    }
    const state = stagnantStreak >= 2
        ? chalk.red("STUCK")
        : progressing.length > 0
            ? chalk.green("PROGRESSING")
            : chalk.yellow("NOT PROGRESSING");
    console.log(chalk.bold.dim(`\n  ╭ Convergence board · ${state}`));
    console.log(chalk.gray(`  │ Addressed/coded: packet_closed=${progress.packetClosed} (${deltaLabel(progress.packetClosed, prev?.packetClosed)}) · files_changed=${progress.filesChanged} (${deltaLabel(progress.filesChanged, prev?.filesChanged)}) · committed_changes=${progress.committedChanges} (${deltaLabel(progress.committedChanges, prev?.committedChanges)}) · feedback_addressed=${progress.feedbackAddressed} (${deltaLabel(progress.feedbackAddressed, prev?.feedbackAddressed)}) · gaps_addressed=${progress.gapsAddressed} (${deltaLabel(progress.gapsAddressed, prev?.gapsAddressed)})`));
    console.log(chalk.gray(`  │ Remaining: packet_open=${progress.packetOpen} (${deltaLabel(progress.packetOpen, prev?.packetOpen)}) · brief_open=${progress.briefOpen}/${progress.briefTotal} (${deltaLabel(progress.briefOpen, prev?.briefOpen)}) · brief_checked=${progress.briefChecked} (${deltaLabel(progress.briefChecked, prev?.briefChecked)}) · release_blocked_items=${progress.blockedChecklist} · qa_blockers=${progress.qaBlockers}`));
    console.log(chalk.gray(`  │ Investor directives: current=${progress.investorDirectives} (${deltaLabel(progress.investorDirectives, prev?.investorDirectives)}) · adaptive_loaded=${progress.adaptiveDirectivesLoaded} · adaptive_active=${progress.adaptiveDirectivesActiveTotal} (${deltaLabel(progress.adaptiveDirectivesActiveTotal, prev?.adaptiveDirectivesActiveTotal)})`));
    const qaLine = qa?.score !== undefined
        ? `recommendation=${qa.recommendation} · score=${qa.score} · blockers=${progress.qaBlockers} · manual_tasks=${progress.qaManualTasks}`
        : "missing";
    console.log(chalk.gray(`  │ QA: ${qaLine}`));
    if (investor) {
        const grades = (investor.investors ?? [])
            .map((i) => `${i.displayName ?? "investor"}=${i.grade ?? "?"}`)
            .join(", ");
        const directives = safeLen(investor.combinedRefinementDirectives);
        console.log(chalk.gray(`  │ Investor: round=${investor.refinementRound ?? 0} · worst=${investor.worstGrade ?? "?"} · meets_A-=${investor.meetsMinimumGradeA ? "yes" : "no"} · directives=${directives}${grades ? ` · ${grades}` : ""}`));
    }
    else {
        console.log(chalk.gray("  │ Investor: missing"));
    }
    if (progress.briefOpen > 0) {
        console.log(chalk.gray("  │ Why remaining can persist: the packet is frozen for this cycle, while the broader brief backlog may stay deferred until the next cycle."));
    }
    if (progress.packetReopened > 0) {
        console.log(chalk.yellow(`  │ Reopened within packet: ${progress.packetReopened}`));
    }
    if (builder?.commit?.sha) {
        console.log(chalk.gray(`  │ Latest builder commit: ${builder.commit.sha.slice(0, 7)}`));
    }
    const blocked = (release?.releaseChecklist ?? [])
        .filter((item) => item.status === "blocked")
        .slice(0, 3);
    if (blocked.length > 0) {
        blocked.forEach((item, idx) => {
            console.log(chalk.gray(`  │ Blocked #${idx + 1}: ${truncateForDisplay(`${item.item} — ${item.notes ?? ""}`, 120)}`));
        });
    }
    if (progressing.length > 0) {
        console.log(chalk.green(`  │ Progressing: ${truncateForDisplay(progressing.join(" · "), 130)}`));
    }
    if (notProgressing.length > 0) {
        console.log(chalk.yellow(`  │ Not progressing: ${truncateForDisplay(notProgressing.join(" · "), 130)}`));
    }
    if (stagnantStreak >= 2) {
        console.log(chalk.red("  │ Stuck: no net closure across key metrics for multiple iterations."));
    }
    console.log(chalk.bold.dim("  ╯"));
}
function buildUnblockGuidance(repoPath, foundryDir, pipelineQa, releaseOutput, builderOutput, builderRemainingBlockers) {
    const sources = [
        ...(pipelineQa?.blockers ?? []),
        ...(pipelineQa?.manualTasks ?? []),
        ...(pipelineQa?.warnings ?? []),
        ...extractBuilderBlockers(builderOutput),
        ...builderRemainingBlockers,
        ...(releaseOutput?.notes ?? []),
        ...((releaseOutput?.releaseChecklist ?? []).map((item) => `${item.item} ${item.notes ?? ""}`)),
    ].join("\n");
    const humanSteps = [];
    const automatableSteps = [];
    if (releaseOutput?.status === "awaiting_approval" && releaseOutput.approvalFile) {
        humanSteps.push(`Approve this release snapshot interactively: re-run \`foundry ship\` or \`foundry loop\` in a TTY and answer the approval prompt (or manually create ${join(repoPath, releaseOutput.approvalFile)}).`);
    }
    if (/maestro cli .*not available|install maestro cli|manual tool setup: install maestro/i.test(sources)) {
        humanSteps.push('Install Maestro once: curl -Ls "https://get.maestro.mobile.dev" | bash');
        humanSteps.push('Persist PATH once: echo \'export PATH="$HOME/.maestro/bin:$PATH"\' >> ~/.bashrc && echo \'export PATH="$HOME/.maestro/bin:$PATH"\' >> ~/.zshrc');
        humanSteps.push('Activate now: export PATH="$HOME/.maestro/bin:$PATH" && hash -r && maestro --version');
    }
    if (/create or restore maestro flows|flow path .* does not exist/i.test(sources)) {
        humanSteps.push("Create/restore Maestro flows in `.maestro/` and run `maestro test '.maestro'`");
    }
    if (/no bundle url present|ipa .*without (an )?embedded js bundle|built without a js bundle/i.test(sources)) {
        humanSteps.push("Rebuild iOS artifact with embedded JS bundle: `eas build --profile preview --platform ios`");
        humanSteps.push("Re-run smoke on the new build artifact (not a dev client requiring Metro)");
    }
    if (/subscription backend|revenuecat|in-app purchase|iap/i.test(sources)) {
        humanSteps.push("Configure billing backend (RevenueCat/IAP): create products/entitlements and wire API keys in environment");
    }
    if (/notification|reminder|expo-notifications/i.test(sources)) {
        automatableSteps.push("Foundry can install/package code path for notifications; you still need push credentials provisioning");
        humanSteps.push("After code changes, configure push credentials for notifications in Apple/Expo");
    }
    if (/@react-native-community\/netinfo|netinfo/i.test(sources)) {
        automatableSteps.push("Install missing runtime dependency: `npx expo install @react-native-community/netinfo`");
    }
    const briefBlocked = (releaseOutput?.releaseChecklist ?? []).find((item) => item.item.toLowerCase().includes("tracked cursor_brief items") && item.status === "blocked");
    if (briefBlocked) {
        // The "rerun the loop" wording was misleading — `foundry run` is one shot.
        // The thing that actually iterates (Cursor closes brief items between
        // pipeline cycles, then re-runs QA + release + investor_panel) is
        // `foundry loop --cursor-auto --profile investor`.
        automatableSteps.push(`Run \`foundry loop --cursor-auto --profile investor\` from ${foundryDir.replace(/\.foundry$/, "")} — Cursor closes the open brief items between pipeline cycles, then re-pitches when the contract converges.`);
        automatableSteps.push(`Tracked items live at ${join(foundryDir, "CURSOR_BRIEF.md")} (mirror: ${join(foundryDir, "OPEN_TRACKED_BRIEF.md")}).`);
        const lines = releaseOutput?.openTrackedBriefLines ?? [];
        if (lines.length > 0) {
            lines.slice(0, 8).forEach((L, i) => automatableSteps.push(`Open brief ${i + 1}: ${L}`));
        }
    }
    return {
        humanSteps: [...new Set(humanSteps)],
        automatableSteps: [...new Set(automatableSteps)],
    };
}
function printUnblockGuidance(g) {
    if (g.humanSteps.length === 0 && g.automatableSteps.length === 0)
        return;
    if (g.humanSteps.length > 0) {
        console.log(chalk.bold.yellow("\n  REQUIRES HUMAN ACTION (step-by-step)"));
    }
    g.humanSteps.forEach((step, i) => {
        console.log(chalk.yellow(`  ${i + 1}. ${truncateForDisplay(step, 140)}`));
    });
    if (g.automatableSteps.length > 0) {
        console.log(chalk.bold.cyan("\n  AUTOMATABLE BY FOUNDRY/CURSOR"));
        g.automatableSteps.forEach((step, i) => {
            console.log(chalk.cyan(`  ${i + 1}. ${truncateForDisplay(step, 140)}`));
        });
    }
    console.log("");
}
async function promoteReleaseBranchOrStop(repoPath, manifest, foundryConfig) {
    const builder = await readStageJson(repoPath, manifest, "builder");
    const fallbackBuilder = builder?.branchName
        ? builder
        : { branchName: foundryConfig.project.foundry?.builder_branch };
    const promotion = await promoteApprovedBranch(repoPath, manifest, fallbackBuilder);
    if (promotion.status === "promoted") {
        console.log(chalk.green(`  Release branch promotion: ${promotion.detail}`));
        if (promotion.logPath)
            console.log(chalk.gray(`  Promotion log: ${promotion.logPath}`));
        return true;
    }
    if (promotion.status === "skipped") {
        console.log(chalk.yellow(`  Release branch promotion skipped: ${promotion.detail}`));
        if (promotion.logPath)
            console.log(chalk.gray(`  Promotion log: ${promotion.logPath}`));
        return true;
    }
    console.log(chalk.red(`  Release branch promotion failed: ${promotion.detail}`));
    if (promotion.logPath)
        console.log(chalk.red(`  Promotion log: ${promotion.logPath}`));
    return false;
}
function isYes(input) {
    return /^(y|yes)$/i.test(input.trim());
}
function isEasReleaseEligible(foundryConfig) {
    const repoType = foundryConfig.project.repo_type.toLowerCase();
    if (/^(web_data_platform|web_app|node|python|enterprise)/i.test(repoType))
        return false;
    return true;
}
async function promptReleaseApproval(approvalPath) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.log(chalk.red("\n  Release approval needs an interactive terminal (stdin/stdout TTY). Re-run without piping, or approve manually:"));
        console.log(chalk.gray(`  mkdir -p ${dirname(approvalPath)} && touch ${approvalPath}\n`));
        return false;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await rl.question(chalk.cyan(`  Approve this release snapshot? [y/N]: `));
        if (!isYes(answer)) {
            console.log(chalk.yellow("\n  Release approval declined — stopping here.\n"));
            return false;
        }
        await mkdir(dirname(approvalPath), { recursive: true });
        await writeFile(approvalPath, `${new Date().toISOString()}\n`, "utf8");
        console.log(chalk.green(`\n  Approval recorded: ${approvalPath}\n`));
        return true;
    }
    finally {
        rl.close();
    }
}
async function promptReleaseActions(repoPath, easSettings, foundryConfig) {
    if (!isEasReleaseEligible(foundryConfig)) {
        console.log(chalk.gray("\n  EAS/TestFlight actions skipped: project repo_type is not mobile/Expo."));
        return { buildEas: false, submitTestFlight: false };
    }
    console.log(chalk.bold("\n  Release actions"));
    console.log(chalk.gray(`  Foundry will only spend an EAS build if you confirm here. Config default is build_on_approval=${String(easSettings.buildOnApproval)} (${easSettings.platform}/${easSettings.profile}).`));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const buildAnswer = await rl.question(chalk.cyan("  Run an EAS build now? [y/N]: "));
        const buildEas = isYes(buildAnswer);
        let submitTestFlight = false;
        if (easSettings.platform !== "android") {
            const submitAnswer = await rl.question(chalk.cyan("  Submit an iOS build to TestFlight now? [y/N]: "));
            submitTestFlight = isYes(submitAnswer);
        }
        if (!buildEas && !submitTestFlight) {
            console.log(chalk.gray("  No EAS/TestFlight action selected. Release branch promotion can still proceed."));
        }
        return { buildEas, submitTestFlight };
    }
    finally {
        rl.close();
    }
}
async function logPipelineSnapshot(repoPath, manifest, label, briefOpen, cached) {
    const snap = await getPipelineSnapshotForConsole(repoPath, manifest, {
        maxBlockers: 25,
        blockerMaxLen: 105,
        briefOpenTotal: briefOpen,
    });
    console.log(chalk.bold.dim(`\n  ╭ ${label} · ${snap.runId}`));
    console.log(chalk.white(`  │ Build: ${snap.buildLine}`));
    if (snap.briefOpenTotal !== undefined) {
        console.log(chalk.gray(`  │ Brief: ${snap.briefOpenTotal} open checklist items (tracked sections)`));
        if (snap.briefOpenTotal > 0) {
            const blines = await sampleUncheckedBriefLines(join(repoPath, ".foundry", "CURSOR_BRIEF.md"), 12);
            blines.forEach((line, i) => {
                console.log(chalk.yellow(`  │   ${i + 1}. ${truncateForDisplay(line, 98)}`));
            });
            if (blines.length === 0 && snap.briefOpenTotal > 0) {
                console.log(chalk.gray("  │   (lines not listed — see .foundry/OPEN_TRACKED_BRIEF.md after release_agent)"));
            }
        }
    }
    if (snap.builderBranch?.startsWith("foundry/")) {
        console.log(chalk.yellow(`  │ Builder branch pending merge: ${snap.builderBranch} (fixes do not land on your main branch until merged)`));
    }
    console.log(chalk.bold.dim("  ╯"));
    await logShipGateConsole(repoPath, manifest, cached);
}
function logInnerLoopTargets(inner, maxInner, openWorkItems, buildTargetLines, pipelineQa) {
    console.log(chalk.bold.cyan(`\n  ▸ Cursor builder inner ${inner}/${maxInner} (then full pipeline + QA)`));
    console.log(chalk.gray(`  Open work-packet items: ${openWorkItems}`));
    const n = buildTargetLines.length;
    console.log(chalk.bold.white(`  Build targets (${n}):`));
    if (n === 0) {
        console.log(chalk.gray("    (none — driving QA blockers, feedback queue, or brief closure only)"));
    }
    else {
        buildTargetLines.forEach((line, i) => {
            console.log(chalk.white(`    ${i + 1}. ${truncateForDisplay(line, 118)}`));
        });
    }
    const rec = pipelineQa?.recommendation ?? "unknown";
    const score = pipelineQa?.score;
    const lastQa = score !== undefined ? `Last pipeline QA: ${rec} · score=${score}` : `Last pipeline QA: ${rec}`;
    console.log(chalk.gray(`  ${lastQa}`));
    console.log(chalk.gray(`  Next pipeline QA will run: ${summarizeCoreQaPlanForConsole(pipelineQa)}`));
    const blockers = pipelineQa?.blockers ?? [];
    if (blockers.length === 0) {
        console.log(chalk.green("  Pipeline QA blockers: none"));
        return;
    }
    console.log(chalk.yellow(`  Pipeline QA blockers (${blockers.length}) — drive these to 0 for ship:`));
    blockers.forEach((b, i) => {
        console.log(chalk.yellow(`    ${i + 1}. ${truncateForDisplay(b, 102)}`));
    });
}
const program = new Command();
const FOUNDRY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const STRICT_RESET_CONSOLIDATE_STAGES = [
    "repo_inventory",
    "current_state_audit",
    "baseline_app_shell",
    "market_gap_analysis",
    "first_principles",
    "flywheel_designer",
    "product_definition",
    "monetization_architect",
    "feedback_agent",
    "builder",
];
/** `foundry loop --stabilize`: skip upstream scope stages; converge on tests + ship gates. */
const STABILIZE_PHASE1_STAGES = ["builder", "independent_qa", "release_agent"];
program.name("foundry").description("Agentic orchestrator CLI").version("0.0.1");
async function exists(p) {
    try {
        await access(p);
        return true;
    }
    catch {
        return false;
    }
}
function resolveRepoPath(repo) {
    return resolve(repo ?? process.cwd());
}
const FOUNDRY_GITIGNORE_ENTRIES = [
    ".foundry/.pipeline-stage-cache.json",
    ".foundry/APPROVAL_REQUIRED.md",
    ".foundry/feedback-ledger.json",
    ".foundry/LATEST_INSTALL.md",
    ".foundry/CURSOR_BRIEF.md",
    ".foundry/CURSOR_BUILDER_REPORT.md",
    ".foundry/CURSOR_QA_REPORT.md",
    ".foundry/automation/",
    ".foundry/out/",
    ".foundry/releases/",
    ".foundry/approvals/",
    ".maestro-debug/",
];
async function ensureFoundryGitignore(repoPath) {
    const gitignorePath = join(repoPath, ".gitignore");
    let raw = "";
    try {
        raw = await readFile(gitignorePath, "utf8");
    }
    catch {
        raw = "";
    }
    const existing = new Set(raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    const missing = FOUNDRY_GITIGNORE_ENTRIES.filter((entry) => !existing.has(entry));
    if (missing.length === 0)
        return;
    const prefix = raw.trim().length > 0 ? `${raw.replace(/\s*$/, "")}\n\n` : "";
    const block = [
        "# Foundry generated files",
        ...missing,
        "",
    ].join("\n");
    await writeFile(gitignorePath, `${prefix}${block}`, "utf8");
}
async function readRepoEnv(repoPath) {
    const out = {};
    for (const abs of [join(repoPath, ".env"), join(repoPath, ".env.local")]) {
        try {
            const raw = await readFile(abs, "utf8");
            for (const line of raw.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("#"))
                    continue;
                const idx = trimmed.indexOf("=");
                if (idx <= 0)
                    continue;
                const key = trimmed.slice(0, idx).trim();
                let value = trimmed.slice(idx + 1).trim();
                if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1);
                }
                out[key] = value;
            }
        }
        catch {
            /* ignore missing local env files */
        }
    }
    return out;
}
function feedbackLedgerPath(repoPath) {
    return join(repoPath, ".foundry", "feedback-ledger.json");
}
async function readFeedbackLedger(repoPath) {
    const abs = feedbackLedgerPath(repoPath);
    try {
        const raw = await readFile(abs, "utf8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.items))
            return { updatedAt: "", items: [] };
        return {
            updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
            items: parsed.items,
        };
    }
    catch {
        return { updatedAt: "", items: [] };
    }
}
async function writeFeedbackLedger(repoPath, ledger) {
    const abs = feedbackLedgerPath(repoPath);
    await mkdir(join(repoPath, ".foundry"), { recursive: true });
    await writeFile(abs, JSON.stringify(ledger, null, 2), "utf8");
}
function feedbackIdFromSummary(summary) {
    const slug = summary
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 36) || "item";
    return `manual-${Date.now().toString(36)}-${slug}`;
}
function describeFeedbackItem(item) {
    return [
        `[${item.status}]`,
        item.shouldImplement ? "implement=yes" : "implement=no",
        `${item.type}/${item.priority}`,
        item.id,
        "-",
        truncateForDisplay(item.summary, 110),
    ].join(" ");
}
async function updateFeedbackItem(repoPath, id, mutate) {
    const ledger = await readFeedbackLedger(repoPath);
    const idx = ledger.items.findIndex((item) => item.id === id);
    if (idx < 0)
        return undefined;
    ledger.items[idx] = mutate(ledger.items[idx]);
    ledger.updatedAt = new Date().toISOString();
    await writeFeedbackLedger(repoPath, ledger);
    return ledger.items[idx];
}
async function deleteFeedbackItem(repoPath, id) {
    const ledger = await readFeedbackLedger(repoPath);
    const nextItems = ledger.items.filter((item) => item.id !== id);
    if (nextItems.length === ledger.items.length)
        return false;
    ledger.items = nextItems;
    ledger.updatedAt = new Date().toISOString();
    await writeFeedbackLedger(repoPath, ledger);
    return true;
}
async function reviewFeedbackLedger(repoPath, includeClosed = false) {
    const ledger = await readFeedbackLedger(repoPath);
    const items = ledger.items.filter((item) => {
        if (item.shouldImplement)
            return false;
        if (includeClosed)
            return true;
        return item.status === "open";
    });
    if (items.length === 0) {
        console.log(chalk.gray(includeClosed
            ? "No undecided feedback items to review."
            : "No open undecided feedback items to review."));
        return;
    }
    console.log(chalk.bold(`Feedback review: ${feedbackLedgerPath(repoPath)}`));
    console.log(chalk.gray("Actions: [y] implement  [Enter]/[n] skip  [d] delete  [q] quit\n"));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let implemented = 0;
    let skipped = 0;
    let deleted = 0;
    try {
        for (let index = 0; index < items.length; index++) {
            const current = items[index];
            console.log(chalk.bold(`${index + 1}/${items.length} ${current.id}`));
            console.log(`  status: ${current.status} · implement=${current.shouldImplement ? "yes" : "no"} · ${current.type}/${current.priority}`);
            console.log(`  source: ${current.source}`);
            console.log(`  actionable: ${current.repoActionable ? "yes" : "no"} · latest=${current.presentInLatestCollection ? "yes" : "no"} · seen=${current.seenCount}`);
            console.log(`  summary: ${current.summary}`);
            if (current.implementationNote)
                console.log(chalk.gray(`  note: ${truncateForDisplay(current.implementationNote, 140)}`));
            const answer = (await rl.question(chalk.cyan("  Action [y/n/d/q]: "))).trim().toLowerCase();
            if (answer === "q") {
                console.log(chalk.yellow("\nStopped feedback review early."));
                break;
            }
            if (answer === "d") {
                const ok = await deleteFeedbackItem(repoPath, current.id);
                if (ok) {
                    deleted++;
                    console.log(chalk.red("  Deleted from ledger.\n"));
                }
                else {
                    console.log(chalk.red("  Item was not found; skipping.\n"));
                }
                continue;
            }
            if (answer === "y") {
                await updateFeedbackItem(repoPath, current.id, (item) => ({
                    ...item,
                    status: "open",
                    shouldImplement: true,
                    repoActionable: true,
                    lastSeenAt: new Date().toISOString(),
                }));
                implemented++;
                console.log(chalk.green("  Marked for implementation.\n"));
                continue;
            }
            skipped++;
            console.log(chalk.gray("  Skipped.\n"));
        }
    }
    finally {
        rl.close();
    }
    console.log(chalk.bold(`Review complete: implement=${implemented} · skipped=${skipped} · deleted=${deleted}`));
}
async function syncFeedbackSources(repoPath) {
    const foundryDir = join(repoPath, ".foundry");
    if (!(await exists(foundryDir))) {
        console.error(chalk.red("Missing .foundry/ in target repo. Run `foundry init` first."));
        process.exit(1);
    }
    const spinner = ora("Syncing feedback sources (ledger + Supabase + logs)...").start();
    let manifest;
    try {
        manifest = await runPipeline({
            repoPath,
            pipelineName: "feedback-sync",
            foundryRoot: FOUNDRY_ROOT,
        });
        spinner.succeed("Feedback sync complete.");
    }
    catch (err) {
        spinner.fail(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
    const feedbackOutput = await readStageJson(repoPath, manifest, "feedback_agent");
    const summary = {
        runId: manifest.runId,
        collectedAt: feedbackOutput?.collectedAt,
        totalItems: feedbackOutput?.ledgerSummary?.totalItems,
        openItems: feedbackOutput?.ledgerSummary?.openItems,
        implementNowItems: feedbackOutput?.ledgerSummary?.implementNowItems,
        sources: feedbackOutput?.sources,
    };
    console.log(chalk.gray(`  Run: ${summary.runId}`));
    if (summary.collectedAt)
        console.log(chalk.gray(`  Collected at: ${summary.collectedAt}`));
    if (summary.totalItems !== undefined) {
        console.log(chalk.gray(`  Feedback items: total=${summary.totalItems} · open=${summary.openItems ?? 0} · implement-now=${summary.implementNowItems ?? 0}`));
    }
    if (summary.sources?.length) {
        console.log(chalk.gray("  Sources:"));
        for (const source of summary.sources) {
            console.log(chalk.gray(`    - ${source.name ?? "unknown"}: count=${source.itemCount ?? 0} · available=${String(source.available ?? false)}`));
        }
    }
    const supabaseSource = summary.sources?.find((source) => source.name === "supabase");
    if (supabaseSource && !supabaseSource.available) {
        const repoEnv = await readRepoEnv(repoPath);
        const hasUrl = Boolean(process.env.SUPABASE_URL ||
            repoEnv.SUPABASE_URL ||
            process.env.EXPO_PUBLIC_SUPABASE_URL ||
            repoEnv.EXPO_PUBLIC_SUPABASE_URL);
        const hasKey = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || repoEnv.SUPABASE_SERVICE_ROLE_KEY);
        if (!hasUrl || !hasKey) {
            const missing = [
                !hasUrl ? "SUPABASE_URL (or EXPO_PUBLIC_SUPABASE_URL)" : null,
                !hasKey ? "SUPABASE_SERVICE_ROLE_KEY" : null,
            ].filter(Boolean);
            console.log(chalk.yellow(`  Supabase feedback unavailable: missing ${missing.join(" and ")} in current env or repo .env/.env.local.`));
        }
        else {
            console.log(chalk.yellow("  Supabase feedback unavailable even though credentials were found. Check service-role access, network, and that `feedback_events` or `feedback` exists."));
        }
    }
    return summary;
}
async function runApprovedReleaseActions(repoPath, foundryConfig, manifest, releaseStatus, releaseActionChoices) {
    if (!(await promoteReleaseBranchOrStop(repoPath, manifest, foundryConfig))) {
        return { ok: false, retryLoop: false };
    }
    const easSettings = resolveEasBuildSettings(foundryConfig);
    const choices = releaseActionChoices !== undefined
        ? releaseActionChoices
        : await promptReleaseActions(repoPath, easSettings, foundryConfig);
    if (choices.buildEas) {
        if (!isEasReleaseEligible(foundryConfig)) {
            console.log(chalk.yellow("  EAS build skipped: project repo_type is not mobile/Expo."));
            return { ok: true, retryLoop: false };
        }
        const easBuild = await maybeRunApprovedEasBuild(repoPath, foundryConfig, manifest, releaseStatus, { force: true });
        if (easBuild.status === "started" || easBuild.status === "already_started") {
            logEasQueuedToConsole(easBuild, false);
        }
        else if (easBuild.status === "failed") {
            console.log(chalk.red(`  EAS build not started: ${easBuild.detail}`));
            if (easBuild.logPath)
                console.log(chalk.red(`  Build log: ${easBuild.logPath}`));
            console.log(chalk.yellow("  The EAS build log is kept under .foundry/releases/<timestamp>/. A subsequent full loop cycle can backfill Expo logs, ingest the failure into feedback_agent, and queue repo-fixable errors for Cursor automatically."));
            return {
                ok: false,
                retryLoop: true,
                failureKey: `eas-build:${easBuild.detail}`,
                failureLogPath: easBuild.logPath,
            };
        }
    }
    if (choices.submitTestFlight) {
        const submit = await maybeSubmitLatestToTestFlight(repoPath, foundryConfig, manifest, releaseStatus);
        if (submit.status === "started" || submit.status === "already_started") {
            logTestFlightSubmitToConsole(submit, !choices.buildEas);
        }
        else if (submit.status === "failed") {
            console.log(chalk.red(`  TestFlight submit not started: ${submit.detail}`));
            if (submit.logPath)
                console.log(chalk.red(`  Submit log: ${submit.logPath}`));
            console.log(chalk.yellow("  The submit log is kept under .foundry/releases/<timestamp>/; the next `foundry loop` will ingest it via feedback_agent and queue repo-fixable errors for Cursor."));
            return {
                ok: false,
                retryLoop: false,
                failureKey: `testflight-submit:${submit.detail}`,
                failureLogPath: submit.logPath,
            };
        }
        else {
            console.log(chalk.yellow(`  TestFlight submit skipped: ${submit.detail}`));
        }
    }
    return { ok: true, retryLoop: false };
}
// ── init ────────────────────────────────────────────────────────────
program
    .command("init")
    .option("--repo <path>", "Path to target repo (defaults to current directory)")
    .description("Initialize .foundry config in a repo")
    .action(async ({ repo }) => {
    const repoPath = resolveRepoPath(repo);
    const foundryDir = join(repoPath, ".foundry");
    const projectYaml = join(foundryDir, "project.yaml");
    const metricsYaml = join(foundryDir, "metrics.yaml");
    const gatesYaml = join(foundryDir, "gates.yaml");
    await mkdir(foundryDir, { recursive: true });
    if (!(await exists(projectYaml))) {
        await writeFile(projectYaml, [
            "project_name: your-project",
            'repo_type: "web_app"',
            'north_star: "define a measurable outcome"',
            "constraints:",
            '  - "replace me"',
            "core_differentiators:",
            '  - "replace me"',
            "foundry: {}",
            "  # Optional: one git branch for all builder cycles until you merge the release to main.",
            "  # builder_branch: foundry/release",
            "  # Optional: skip investor_panel until QA ships, no blockers, brief complete, work packet closed.",
            "  # investor_panel_when_release_ready: true",
            "cursor_automation:",
            "  enabled: true",
            '  builder_model: "auto"',
            '  builder_fast_model: "auto"',
            "  max_inner_loops: 12",
            "  timeout_minutes: 45",
            "qa_automation:",
            "  maestro:",
            "    enabled: false",
            "    required: false",
            '    command: "maestro"',
            '    flow_path: ".maestro"',
            "    install_if_missing: true",
            "release_automation:",
            "  eas:",
            "    build_on_approval: false",
            '    command: "eas"',
            '    profile: "preview"',
            '    platform: "ios"',
            "    non_interactive: true",
            "",
        ].join("\n"), "utf8");
    }
    if (!(await exists(metricsYaml))) {
        await writeFile(metricsYaml, [
            "metrics:",
            "  - key: d1_retention",
            "    target: 0.25",
            "  - key: scan_success_rate",
            "    target: 0.9",
            "",
        ].join("\n"), "utf8");
    }
    if (!(await exists(gatesYaml))) {
        await writeFile(gatesYaml, [
            "require_human_approval:",
            "  - release_agent.submit_testflight",
            "  - supabase.apply_migrations_prod",
            "  - growth_operator.deploy_paid_ads",
            "",
        ].join("\n"), "utf8");
    }
    await ensureFoundryGitignore(repoPath);
    console.log(chalk.green("Initialized .foundry/ in: ") + chalk.cyan(foundryDir));
    console.log(chalk.gray("Next: edit .foundry/project.yaml to match the app."));
});
// ── stages ──────────────────────────────────────────────────────────
program
    .command("stages")
    .description("List all registered stages")
    .action(() => {
    const names = listRegisteredStageNames();
    console.log(chalk.bold(`Registered stages (${names.length}):\n`));
    for (const name of names) {
        console.log("  " + chalk.cyan(name));
    }
});
// ── status ──────────────────────────────────────────────────────────
program
    .command("status")
    .option("--repo <path>", "Path to target repo (defaults to current directory)")
    .description("Print work packet, brief counts, and latest pipeline QA/release/investor snapshot (no pipeline run)")
    .action(async ({ repo }) => {
    const repoPath = resolveRepoPath(repo);
    const foundryDir = join(repoPath, ".foundry");
    if (!(await exists(foundryDir))) {
        console.error(chalk.red("Missing .foundry/ in target repo. Run `foundry init --repo <path>` first."));
        process.exit(1);
    }
    await printFoundryStatusDashboard(repoPath);
});
// ── run ─────────────────────────────────────────────────────────────
program
    .command("run")
    .option("--repo <path>", "Path to target repo (defaults to current directory)")
    .option("--pipeline <name>", "Pipeline name (default.yaml)", "default")
    .option("--quiet", "Suppress per-stage log lines; print a compact stage summary + ship gate after the run")
    .option("--investor-refinement", "Enable YAML investor_refinement loop (re-run stages up to max_rounds until investor_panel meets A- bar)")
    .description("Run a pipeline against a repo")
    .action(async ({ repo, pipeline, investorRefinement, quiet, }) => {
    const repoPath = resolveRepoPath(repo);
    const foundryDir = join(repoPath, ".foundry");
    if (!(await exists(foundryDir))) {
        console.error(chalk.red("Missing .foundry/ in target repo. Run `foundry init --repo <path>` first."));
        process.exit(1);
    }
    const foundryRoot = FOUNDRY_ROOT;
    const spinner = ora(quiet ? "Running pipeline (quiet)..." : "Running pipeline...").start();
    let manifest;
    try {
        manifest = await runPipeline({
            repoPath,
            pipelineName: pipeline,
            foundryRoot,
            allowInvestorRefinement: Boolean(investorRefinement),
            quiet: Boolean(quiet),
        });
        spinner.succeed("Pipeline finished.");
    }
    catch (err) {
        spinner.fail(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
    const passed = manifest.stages.filter((s) => s.status === "passed").length;
    const failed = manifest.stages.filter((s) => s.status === "failed").length;
    const skipped = manifest.stages.filter((s) => s.status === "skipped").length;
    const totalMs = manifest.stages.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
    console.log("");
    console.log(chalk.bold(`Pipeline: ${pipeline}  |  Run: ${manifest.runId}\n`));
    if (quiet) {
        const stageWidth = 25;
        for (const s of manifest.stages) {
            const icon = s.status === "passed" ? chalk.green("✓") : s.status === "failed" ? chalk.red("✗") : chalk.gray("○");
            const dur = s.durationMs !== undefined ? chalk.gray(` ${s.durationMs}ms`) : "";
            console.log(`  ${icon} ${s.stage.padEnd(stageWidth)}${dur}`);
        }
        console.log("");
    }
    if (manifest.status === "passed") {
        console.log(chalk.green.bold(`Pipeline passed`) + chalk.gray(` — ${passed} stages in ${totalMs}ms`));
    }
    else {
        console.log(chalk.red.bold(`Pipeline failed`) +
            chalk.gray(` — ${passed} passed, ${failed} failed, ${skipped} skipped`));
    }
    console.log(chalk.gray(`Artifacts: ${join(foundryDir, "out", manifest.runId)}`));
    if (quiet) {
        const pipelineQa = await readStageJson(repoPath, manifest, "independent_qa");
        const releaseOutput = await readStageJson(repoPath, manifest, "release_agent");
        const builderOutput = await readStageJson(repoPath, manifest, "builder");
        const builderRemainingBlockers = await readBuilderRemainingBlockers(repoPath);
        await logShipGateConsole(repoPath, manifest, { pipelineQa, release: releaseOutput });
        printUnblockGuidance(buildUnblockGuidance(repoPath, foundryDir, pipelineQa, releaseOutput, builderOutput, builderRemainingBlockers));
        logReleaseCandidateLine(pipelineQa, releaseOutput);
    }
});
// ── ship (one-shot release path) ───────────────────────────────────
program
    .command("ship")
    .option("--repo <path>", "Path to target repo (defaults to current directory)")
    .option("--pipeline <name>", "Pipeline name (default.yaml)", "default")
    .option("--no-wait", "Non-interactive convenience flag: when stdin/stdout is not a TTY, skip interactive EAS/TestFlight + release approval prompts and exit after printing next steps. In a TTY, prompts still run.")
    .option("--investor-refinement", "Enable YAML investor_refinement loop (same as `foundry run --investor-refinement`)")
    .description("Run the full pipeline once, require clean QA (ship + zero blockers), print manual release steps, then prompt interactively for EAS build / TestFlight submit and release approval (when ready)")
    .action(async ({ repo, pipeline, noWait, investorRefinement, }) => {
    const repoPath = resolveRepoPath(repo);
    const foundryDir = join(repoPath, ".foundry");
    if (!(await exists(foundryDir))) {
        console.error(chalk.red("Missing .foundry/ in target repo. Run `foundry init --repo <path>` first."));
        process.exit(1);
    }
    const foundryRoot = FOUNDRY_ROOT;
    const foundryConfig = await loadFoundryConfig(repoPath);
    const easSettings = resolveEasBuildSettings(foundryConfig);
    console.log(chalk.bold.cyan("\n  Foundry ship (one-shot)"));
    console.log(chalk.gray(`  Repo: ${repoPath}`));
    console.log(chalk.gray(`  Pipeline: ${pipeline}`));
    console.log(chalk.gray(`  No-wait: ${noWait ? "on (no approval poll / no EAS prompts)" : "off"}`));
    console.log(chalk.gray(`  EAS defaults: ${easSettings.platform}/${easSettings.profile} · build_on_approval=${String(easSettings.buildOnApproval)}\n`));
    const spinner = ora("Running full pipeline (includes independent_qa + release_agent)...").start();
    let manifest;
    try {
        manifest = await runPipeline({
            repoPath,
            pipelineName: pipeline,
            foundryRoot,
            allowInvestorRefinement: Boolean(investorRefinement),
        });
        spinner.succeed("Pipeline finished.");
    }
    catch (err) {
        spinner.fail(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
    const pipelineQa = await readStageJson(repoPath, manifest, "independent_qa");
    const releaseOutput = await readStageJson(repoPath, manifest, "release_agent");
    const builderOutput = await readStageJson(repoPath, manifest, "builder");
    const builderRemainingBlockers = await readBuilderRemainingBlockers(repoPath);
    await logShipGateConsole(repoPath, manifest, { pipelineQa, release: releaseOutput });
    printUnblockGuidance(buildUnblockGuidance(repoPath, foundryDir, pipelineQa, releaseOutput, builderOutput, builderRemainingBlockers));
    const qaRec = pipelineQa?.recommendation ?? "missing";
    const qaBlockers = pipelineQa?.blockers ?? [];
    if (qaRec !== "ship" || qaBlockers.length > 0) {
        console.log(chalk.red.bold("\n  Ship aborted: pipeline QA is not clean."));
        console.log(chalk.red(`  independent_qa recommendation=${qaRec}, blockers=${qaBlockers.length}. Fix tests, lint, typecheck, and Maestro (if enabled), then re-run \`foundry ship\`.`));
        console.log(chalk.gray(`  Artifacts: ${join(foundryDir, "out", manifest.runId)}\n`));
        process.exit(1);
    }
    logReleaseCandidateLine(pipelineQa, releaseOutput);
    const rel = releaseOutput?.status ?? "missing";
    if (rel === "blocked_by_qa" || rel === "blocked_pre_release") {
        console.log(chalk.red.bold("\n  Ship aborted: release_agent pre-release gates are not clear."));
        console.log(chalk.red(`  release_agent.status=${rel}. Complete the blocked checklist rows (brief, builder branch, etc.) shown above, then re-run \`foundry ship\`.`));
        console.log(chalk.gray(`  Review: ${join(foundryDir, "APPROVAL_REQUIRED.md")}`));
        console.log(chalk.gray(`  Artifacts: ${join(foundryDir, "out", manifest.runId)}\n`));
        process.exit(1);
    }
    if (rel === "awaiting_approval" && releaseOutput?.approvalFile) {
        const approvalPath = join(repoPath, releaseOutput.approvalFile);
        const easSettings = resolveEasBuildSettings(foundryConfig);
        console.log(chalk.yellow.bold("\n  RELEASE READY — APPROVAL REQUIRED"));
        console.log(chalk.yellow(`  Review: ${join(foundryDir, "APPROVAL_REQUIRED.md")}`));
        let presolvedReleaseChoices;
        if (noWait && (!process.stdin.isTTY || !process.stdout.isTTY)) {
            console.log(chalk.gray("\n  --no-wait: skipping interactive approval/EAS prompts (no TTY). Re-run `foundry ship` in an interactive terminal to approve, or run EAS yourself.\n"));
            console.log(chalk.gray(`  Artifacts: ${join(foundryDir, "out", manifest.runId)}\n`));
            process.exit(0);
        }
        if (isEasReleaseEligible(foundryConfig)) {
            console.log(chalk.bold.cyan("\n  Release actions (interactive)"));
            console.log(chalk.gray("  Choose EAS/TestFlight now; Foundry runs your choices after you approve below and the builder branch is merged."));
        }
        presolvedReleaseChoices = await promptReleaseActions(repoPath, easSettings, foundryConfig);
        const approved = await promptReleaseApproval(approvalPath);
        if (!approved) {
            console.log(chalk.gray(`  Artifacts: ${join(foundryDir, "out", manifest.runId)}\n`));
            process.exit(1);
        }
        const result = await runApprovedReleaseActions(repoPath, foundryConfig, manifest, "approved", presolvedReleaseChoices);
        console.log(chalk.gray(`\n  Artifacts: ${join(foundryDir, "out", manifest.runId)}`));
        process.exit(result.ok ? 0 : 1);
    }
    if (rel === "approved" || rel === "auto_approved") {
        console.log(chalk.green.bold("\n  Release already approved — running promotion / optional EAS actions"));
        const result = await runApprovedReleaseActions(repoPath, foundryConfig, manifest, rel);
        console.log(chalk.gray(`\n  Artifacts: ${join(foundryDir, "out", manifest.runId)}`));
        process.exit(result.ok ? 0 : 1);
    }
    console.log(chalk.yellow(`\n  Release status is '${rel}' — no approval wait or EAS prompt for this state.`));
    console.log(chalk.gray(`  Artifacts: ${join(foundryDir, "out", manifest.runId)}\n`));
    process.exit(0);
});
// ── feedback ────────────────────────────────────────────────────────
const feedbackProgram = new Command("feedback").description("Manage the durable feedback ledger");
feedbackProgram
    .command("list")
    .option("--repo <path>", "Path to target repo (defaults to current directory)")
    .option("--all", "Show resolved and ignored items too")
    .description("List feedback ledger items")
    .action(async (opts) => {
    const repoPath = resolveRepoPath(opts.repo);
    const ledger = await readFeedbackLedger(repoPath);
    const items = opts.all ? ledger.items : ledger.items.filter((item) => item.status === "open");
    console.log(chalk.bold(`Feedback ledger: ${feedbackLedgerPath(repoPath)}\n`));
    if (items.length === 0) {
        console.log(chalk.gray(opts.all ? "No ledger items." : "No open ledger items."));
        return;
    }
    for (const item of items) {
        const color = item.status === "resolved" ? chalk.green : item.status === "ignored" ? chalk.gray : chalk.yellow;
        console.log(color(`  ${describeFeedbackItem(item)}`));
        if (item.implementationNote)
            console.log(chalk.gray(`    note: ${truncateForDisplay(item.implementationNote, 110)}`));
    }
});
feedbackProgram
    .command("add")
    .option("--repo <path>", "Path to target repo (defaults to current directory)")
    .requiredOption("--summary <text>", "Feedback summary")
    .option("--type <type>", "Feedback type", "feature_request")
    .option("--priority <priority>", "Priority", "medium")
    .option("--implement", "Mark this new item shouldImplement=true")
    .option("--note <text>", "Optional implementation note")
    .description("Add a feedback item to the durable ledger")
    .action(async (opts) => {
    const repoPath = resolveRepoPath(opts.repo);
    const type = opts.type;
    const priority = opts.priority;
    if (!["bug", "feature_request", "complaint", "praise", "crash"].includes(type)) {
        console.error(chalk.red(`Unsupported feedback type: ${opts.type}`));
        process.exit(1);
    }
    if (!["high", "medium", "low"].includes(priority)) {
        console.error(chalk.red(`Unsupported priority: ${opts.priority}`));
        process.exit(1);
    }
    const ledger = await readFeedbackLedger(repoPath);
    const now = new Date().toISOString();
    const item = {
        id: feedbackIdFromSummary(opts.summary),
        type,
        summary: opts.summary.trim(),
        priority,
        source: "manual:cli",
        timestamp: now,
        firstSeenAt: now,
        lastSeenAt: now,
        seenCount: 1,
        status: "open",
        repoActionable: type !== "praise",
        shouldImplement: Boolean(opts.implement) || type === "bug" || type === "crash",
        implementationNote: opts.note,
        presentInLatestCollection: true,
    };
    ledger.items.unshift(item);
    ledger.updatedAt = now;
    await writeFeedbackLedger(repoPath, ledger);
    console.log(chalk.green(`Added: ${describeFeedbackItem(item)}`));
});
feedbackProgram
    .command("review")
    .option("--repo <path>", "Path to target repo (defaults to current directory)")
    .option("--all", "Include resolved and ignored items too")
    .option("--no-sync", "Skip refreshing from feedback sources before review")
    .description("Interactively review feedback items and choose what to implement")
    .action(async (opts) => {
    const repoPath = resolveRepoPath(opts.repo);
    if (opts.sync !== false)
        await syncFeedbackSources(repoPath);
    await reviewFeedbackLedger(repoPath, Boolean(opts.all));
});
feedbackProgram
    .command("sync")
    .option("--repo <path>", "Path to target repo (defaults to current directory)")
    .description("Refresh feedback from Supabase, logs, and other sources into the ledger")
    .action(async (opts) => {
    const repoPath = resolveRepoPath(opts.repo);
    await syncFeedbackSources(repoPath);
});
feedbackProgram
    .command("implement")
    .option("--repo <path>", "Path to target repo (defaults to current directory)")
    .argument("<id>", "Ledger item id")
    .option("--note <text>", "Optional implementation note")
    .description("Mark an open feedback item for implementation")
    .action(async (id, opts) => {
    const repoPath = resolveRepoPath(opts.repo);
    const updated = await updateFeedbackItem(repoPath, id, (item) => ({
        ...item,
        status: item.status === "ignored" ? "open" : item.status,
        shouldImplement: true,
        repoActionable: true,
        implementationNote: opts.note ?? item.implementationNote,
        lastSeenAt: new Date().toISOString(),
    }));
    if (!updated) {
        console.error(chalk.red(`Feedback item not found: ${id}`));
        process.exit(1);
    }
    console.log(chalk.green(`Updated: ${describeFeedbackItem(updated)}`));
});
feedbackProgram
    .command("resolve")
    .option("--repo <path>", "Path to target repo (defaults to current directory)")
    .argument("<id>", "Ledger item id")
    .option("--note <text>", "Optional resolution note")
    .description("Mark a feedback item resolved")
    .action(async (id, opts) => {
    const repoPath = resolveRepoPath(opts.repo);
    const updated = await updateFeedbackItem(repoPath, id, (item) => ({
        ...item,
        status: "resolved",
        shouldImplement: false,
        implementationNote: opts.note ?? item.implementationNote,
        lastSeenAt: new Date().toISOString(),
    }));
    if (!updated) {
        console.error(chalk.red(`Feedback item not found: ${id}`));
        process.exit(1);
    }
    console.log(chalk.green(`Resolved: ${describeFeedbackItem(updated)}`));
});
feedbackProgram
    .command("ignore")
    .option("--repo <path>", "Path to target repo (defaults to current directory)")
    .argument("<id>", "Ledger item id")
    .option("--note <text>", "Optional ignore note")
    .description("Ignore a feedback item")
    .action(async (id, opts) => {
    const repoPath = resolveRepoPath(opts.repo);
    const updated = await updateFeedbackItem(repoPath, id, (item) => ({
        ...item,
        status: "ignored",
        shouldImplement: false,
        implementationNote: opts.note ?? item.implementationNote,
        lastSeenAt: new Date().toISOString(),
    }));
    if (!updated) {
        console.error(chalk.red(`Feedback item not found: ${id}`));
        process.exit(1);
    }
    console.log(chalk.green(`Ignored: ${describeFeedbackItem(updated)}`));
});
feedbackProgram
    .command("reopen")
    .option("--repo <path>", "Path to target repo (defaults to current directory)")
    .argument("<id>", "Ledger item id")
    .option("--implement", "Also mark shouldImplement=true")
    .option("--note <text>", "Optional note")
    .description("Reopen a resolved/ignored feedback item")
    .action(async (id, opts) => {
    const repoPath = resolveRepoPath(opts.repo);
    const updated = await updateFeedbackItem(repoPath, id, (item) => ({
        ...item,
        status: "open",
        shouldImplement: opts.implement ? true : item.shouldImplement,
        implementationNote: opts.note ?? item.implementationNote,
        lastSeenAt: new Date().toISOString(),
    }));
    if (!updated) {
        console.error(chalk.red(`Feedback item not found: ${id}`));
        process.exit(1);
    }
    console.log(chalk.green(`Reopened: ${describeFeedbackItem(updated)}`));
});
program.addCommand(feedbackProgram);
const PRODUCT_LEDGER_STATUSES = [
    "core_mvp",
    "evidence_needed",
    "later_expansion",
    "do_not_build_yet",
    "rejected",
];
function productLedgerPath(repoPath) {
    return join(repoPath, ".foundry", "product-ledger.json");
}
async function readProductLedgerCli(repoPath) {
    try {
        const raw = await readFile(productLedgerPath(repoPath), "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.items))
            return parsed;
    }
    catch {
        /* fall through */
    }
    return { version: 1, updatedAt: "", items: [] };
}
async function writeProductLedgerCli(repoPath, file) {
    await mkdir(join(repoPath, ".foundry"), { recursive: true });
    await writeFile(productLedgerPath(repoPath), JSON.stringify(file, null, 2), "utf8");
}
function manualResolutionsCliPath(repoPath) {
    return join(repoPath, ".foundry", "convergence-resolutions.json");
}
async function readManualResolutionsCli(repoPath) {
    try {
        const raw = await readFile(manualResolutionsCliPath(repoPath), "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.resolutions))
            return parsed;
    }
    catch {
        /* fall through */
    }
    return { version: 1, updatedAt: "", resolutions: [] };
}
async function writeManualResolutionsCli(repoPath, file) {
    await mkdir(join(repoPath, ".foundry"), { recursive: true });
    await writeFile(manualResolutionsCliPath(repoPath), `${JSON.stringify(file, null, 2)}\n`, "utf8");
}
function ledgerStatusColor(status) {
    switch (status) {
        case "core_mvp":
            return chalk.green;
        case "evidence_needed":
            return chalk.cyan;
        case "later_expansion":
            return chalk.blue;
        case "do_not_build_yet":
            return chalk.yellow;
        case "rejected":
            return chalk.gray;
    }
}
function describeLedgerItem(item) {
    return `${item.id.padEnd(40)} [${item.status}] ${truncateForDisplay(item.name, 80)}`;
}
const ledgerProgram = new Command("ledger").description("Inspect and update `.foundry/product-ledger.json` (parked features, evidence-gated unlocks)");
ledgerProgram
    .command("list")
    .option("--repo <path>", "Path to target repo (defaults to current directory)")
    .option("--status <status>", "Filter by status (core_mvp|evidence_needed|later_expansion|do_not_build_yet|rejected)")
    .description("List product ledger items grouped by status")
    .action(async (opts) => {
    const repoPath = resolveRepoPath(opts.repo);
    const ledger = await readProductLedgerCli(repoPath);
    if (ledger.items.length === 0) {
        console.log(chalk.gray("Product ledger is empty. Run `foundry run` to populate it."));
        return;
    }
    console.log(chalk.bold(`Product ledger: ${productLedgerPath(repoPath)}`));
    console.log(chalk.gray(`Updated: ${ledger.updatedAt || "—"}\n`));
    const filter = opts.status;
    if (filter && !PRODUCT_LEDGER_STATUSES.includes(filter)) {
        console.error(chalk.red(`Unknown status: ${filter}. Use one of: ${PRODUCT_LEDGER_STATUSES.join(", ")}`));
        process.exit(1);
    }
    for (const status of PRODUCT_LEDGER_STATUSES) {
        if (filter && status !== filter)
            continue;
        const items = ledger.items.filter((i) => i.status === status);
        if (items.length === 0)
            continue;
        const color = ledgerStatusColor(status);
        console.log(color.bold(`  ${status} (${items.length})`));
        for (const item of items) {
            console.log(color(`    ${describeLedgerItem(item)}`));
            if (item.reason)
                console.log(chalk.gray(`      reason: ${truncateForDisplay(item.reason, 110)}`));
            if (item.reentryCondition) {
                console.log(chalk.gray(`      reentry: ${truncateForDisplay(item.reentryCondition, 110)}`));
            }
        }
        console.log("");
    }
});
ledgerProgram
    .command("park")
    .option("--repo <path>", "Path to target repo (defaults to current directory)")
    .requiredOption("--name <text>", "Feature name to park")
    .option("--reason <text>", "Why this is being parked (default: 'manual park')")
    .option("--status <status>", "Park status: do_not_build_yet (default) | later_expansion | evidence_needed | rejected", "do_not_build_yet")
    .option("--reentry <text>", "Re-entry condition (when this feature can be revisited)")
    .option("--linked-loop <text>", "Singular loop this is parked relative to")
    .description("Park (do not delete) a feature into the product ledger")
    .action(async (opts) => {
    const repoPath = resolveRepoPath(opts.repo);
    const status = (opts.status ?? "do_not_build_yet");
    if (!PRODUCT_LEDGER_STATUSES.includes(status) || status === "core_mvp") {
        console.error(chalk.red(`--status must be one of: do_not_build_yet | later_expansion | evidence_needed | rejected (got ${opts.status}).`));
        process.exit(1);
    }
    const ledger = await readProductLedgerCli(repoPath);
    const id = opts.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "item";
    const now = new Date().toISOString();
    const existing = ledger.items.find((i) => i.id === id);
    const next = existing
        ? {
            ...existing,
            name: opts.name,
            status,
            reason: opts.reason ?? existing.reason,
            reentryCondition: opts.reentry ?? existing.reentryCondition,
            linkedLoop: opts.linkedLoop ?? existing.linkedLoop,
            lastSeenAt: now,
        }
        : {
            id,
            name: opts.name,
            source: "manual",
            status,
            reason: opts.reason ?? "Manually parked via `foundry ledger park`.",
            reentryCondition: opts.reentry,
            linkedLoop: opts.linkedLoop,
            linkedObjections: [],
            firstSeenAt: now,
            lastSeenAt: now,
            refinementRound: 0,
        };
    const items = [next, ...ledger.items.filter((i) => i.id !== id)];
    await writeProductLedgerCli(repoPath, { version: 1, updatedAt: now, items });
    const color = ledgerStatusColor(status);
    console.log(color(`Parked: ${describeLedgerItem(next)}`));
});
ledgerProgram
    .command("promote")
    .option("--repo <path>", "Path to target repo (defaults to current directory)")
    .argument("<id>", "Ledger item id (slug)")
    .option("--status <status>", "Promote to: core_mvp | evidence_needed | later_expansion | do_not_build_yet | rejected", "core_mvp")
    .option("--note <text>", "Optional reason for the promotion (replaces existing reason)")
    .description("Move a ledger item to a different status (e.g. promote to `core_mvp` once an evidence gate is met)")
    .action(async (id, opts) => {
    const repoPath = resolveRepoPath(opts.repo);
    const status = (opts.status ?? "core_mvp");
    if (!PRODUCT_LEDGER_STATUSES.includes(status)) {
        console.error(chalk.red(`--status must be one of: ${PRODUCT_LEDGER_STATUSES.join(", ")}`));
        process.exit(1);
    }
    const ledger = await readProductLedgerCli(repoPath);
    const existing = ledger.items.find((i) => i.id === id);
    if (!existing) {
        console.error(chalk.red(`Ledger item not found: ${id}`));
        process.exit(1);
    }
    const now = new Date().toISOString();
    const updated = {
        ...existing,
        status,
        reason: opts.note ?? existing.reason,
        lastSeenAt: now,
    };
    const items = [updated, ...ledger.items.filter((i) => i.id !== id)];
    await writeProductLedgerCli(repoPath, { version: 1, updatedAt: now, items });
    const color = ledgerStatusColor(status);
    console.log(color(`Promoted ${id} → ${status}`));
});
program.addCommand(ledgerProgram);
const convergenceProgram = new Command("convergence").description("Inspect convergence_contract state (singular loop, MVP boundary, open investor objections)");
convergenceProgram
    .command("status")
    .option("--repo <path>", "Path to target repo (defaults to current directory)")
    .description("Print the latest convergence_contract status and open objections")
    .action(async (opts) => {
    const repoPath = resolveRepoPath(opts.repo);
    const outRoot = join(repoPath, ".foundry", "out");
    let runDirs;
    try {
        runDirs = await readdir(outRoot);
    }
    catch {
        console.error(chalk.red("No `.foundry/out` runs yet. Run `foundry run` first."));
        process.exit(1);
    }
    runDirs.sort((a, b) => b.localeCompare(a));
    let contract;
    let foundIn;
    for (const runId of runDirs) {
        const candidates = [
            join(outRoot, runId, "convergence_contract", "output.json"),
        ];
        try {
            const entries = await readdir(join(outRoot, runId));
            for (const e of entries) {
                if (e.endsWith("_convergence_contract"))
                    candidates.push(join(outRoot, runId, e, "output.json"));
            }
        }
        catch {
            /* no entries */
        }
        for (const candidate of candidates) {
            try {
                const raw = await readFile(candidate, "utf8");
                contract = JSON.parse(raw);
                foundIn = candidate;
                break;
            }
            catch {
                /* try next */
            }
        }
        if (contract)
            break;
    }
    if (!contract) {
        console.error(chalk.red("No convergence_contract output found. Run a pipeline that includes `convergence_contract`."));
        process.exit(1);
    }
    console.log(chalk.bold(`Convergence contract: ${foundIn}`));
    console.log("");
    console.log(chalk.bold(`  Thesis: ${contract.productThesis}`));
    console.log(chalk.gray(`  Target: ${contract.targetUser}`));
    console.log(chalk.gray(`  Loop: ${contract.singularLoop.name}`));
    console.log(chalk.gray(`  North-star: ${contract.singularLoop.northStarMetric.key} (target: ${contract.singularLoop.northStarMetric.target})`));
    console.log("");
    console.log(contract.isConverged
        ? chalk.green.bold(`  CONVERGED (round ${contract.refinementRound})`)
        : chalk.yellow.bold(`  NOT YET CONVERGED (round ${contract.refinementRound})`));
    if (contract.convergenceWarnings.length > 0) {
        console.log(chalk.yellow("\n  Convergence warnings:"));
        for (const w of contract.convergenceWarnings) {
            console.log(chalk.yellow(`    - ${w}`));
        }
    }
    console.log(chalk.bold("\n  Must ship (Phase 1):"));
    for (const item of contract.mvpBoundary.mustShip) {
        console.log(`    - ${item}`);
    }
    if (contract.mvpBoundary.mustNotShipYet.length > 0) {
        console.log(chalk.gray("\n  Parked (do_not_build_yet — see `foundry ledger list`):"));
        for (const item of contract.mvpBoundary.mustNotShipYet.slice(0, 8)) {
            console.log(chalk.gray(`    - ${item}`));
        }
        if (contract.mvpBoundary.mustNotShipYet.length > 8) {
            console.log(chalk.gray(`    … +${contract.mvpBoundary.mustNotShipYet.length - 8} more`));
        }
    }
    console.log(chalk.bold("\n  Open investor objections:"));
    if (contract.openObjections.length === 0) {
        console.log(chalk.green("    (none tracked)"));
    }
    else {
        const unresolved = contract.openObjections.filter((o) => o.status === "open" || o.status === "regressed");
        for (const o of contract.openObjections) {
            const color = o.status === "resolved"
                ? chalk.green
                : o.status === "reduced"
                    ? chalk.cyan
                    : o.status === "regressed"
                        ? chalk.red
                        : chalk.yellow;
            console.log(color(`    [${o.status}] ${o.id} (r${o.firstSeenRound}→r${o.lastSeenRound})`));
            console.log(chalk.gray(`      ${truncateForDisplay(o.objection, 110)}`));
            console.log(chalk.gray(`      need: ${truncateForDisplay(o.requiredEvidence, 110)}`));
        }
        if (unresolved.length > 0) {
            console.log(chalk.gray(`\n    To mark a real-evidence objection as resolved (e.g. you shipped a Yuka benchmark):`));
            console.log(chalk.gray(`      foundry convergence resolve ${unresolved[0]?.id} --evidence "<url|doc|metric>"`));
        }
    }
    if (contract.autoResolvedEvidence && contract.autoResolvedEvidence.length > 0) {
        console.log(chalk.bold("\n  Auto-resolved this run:"));
        for (const e of contract.autoResolvedEvidence) {
            console.log(chalk.green(`    ${e.objectionId}`));
            console.log(chalk.gray(`      ${truncateForDisplay(e.evidence, 110)}`));
        }
    }
    if (contract.panelFingerprint !== undefined) {
        console.log(chalk.gray(`\n  Panel fingerprint: ${contract.panelFingerprint || "(none — no panel ingested yet)"}`));
    }
    console.log(chalk.bold("\n  Evidence gates:"));
    for (const g of contract.evidenceGates) {
        console.log(`    ${chalk.bold(g.id)}: ${g.claim}`);
        console.log(chalk.gray(`      threshold: ${g.threshold}`));
    }
    // Pending manual resolutions (written by `foundry convergence resolve` since
    // the last pipeline run; will be applied on next `foundry run`).
    const pending = await readManualResolutionsCli(repoPath);
    if (pending.resolutions.length > 0) {
        console.log(chalk.bold("\n  Pending manual resolutions (apply on next `foundry run`):"));
        for (const r of pending.resolutions) {
            console.log(chalk.cyan(`    ${r.objectionId}${r.resolvedBy ? ` (by ${r.resolvedBy})` : ""}`));
            console.log(chalk.gray(`      ${truncateForDisplay(r.evidence, 110)}`));
        }
    }
    console.log("");
});
convergenceProgram
    .command("resolve <objectionId>")
    .option("--repo <path>", "Path to target repo (defaults to current directory)")
    .option("--evidence <text>", "Concrete evidence proving the objection is addressed (URL, doc, metric)")
    .option("--by <name>", "Who resolved this objection (for audit)")
    .description("Manually mark an investor objection as resolved with evidence. Use for objections the contract cannot prove on its own (benchmarks, retention numbers, etc.). Run `foundry convergence status` to find IDs.")
    .action(async (objectionId, opts) => {
    const repoPath = resolveRepoPath(opts.repo);
    if (!opts.evidence || opts.evidence.trim().length < 8) {
        console.error(chalk.red("Refusing to resolve without concrete evidence. Pass --evidence with a URL, doc, or metric (≥8 chars)."));
        process.exit(1);
    }
    const file = await readManualResolutionsCli(repoPath);
    const now = new Date().toISOString();
    const idx = file.resolutions.findIndex((r) => r.objectionId === objectionId);
    const entry = {
        objectionId,
        evidence: opts.evidence.trim(),
        resolvedAt: now,
        ...(opts.by ? { resolvedBy: opts.by } : {}),
    };
    if (idx >= 0)
        file.resolutions[idx] = entry;
    else
        file.resolutions.push(entry);
    file.updatedAt = now;
    await writeManualResolutionsCli(repoPath, file);
    console.log(chalk.green(`✔ Marked ${objectionId} as resolved. Re-run \`foundry run\` to recompute convergence.`));
    console.log(chalk.gray(`  evidence: ${entry.evidence}`));
    if (opts.by)
        console.log(chalk.gray(`  by: ${opts.by}`));
    console.log(chalk.gray(`  stored at: ${join(repoPath, ".foundry", "convergence-resolutions.json")} (commit this file)`));
});
convergenceProgram
    .command("unresolve <objectionId>")
    .option("--repo <path>", "Path to target repo (defaults to current directory)")
    .description("Remove a manual resolution. The objection will be re-evaluated against contract state on next run.")
    .action(async (objectionId, opts) => {
    const repoPath = resolveRepoPath(opts.repo);
    const file = await readManualResolutionsCli(repoPath);
    const before = file.resolutions.length;
    file.resolutions = file.resolutions.filter((r) => r.objectionId !== objectionId);
    if (file.resolutions.length === before) {
        console.error(chalk.yellow(`No manual resolution found for ${objectionId}.`));
        process.exit(1);
    }
    file.updatedAt = new Date().toISOString();
    await writeManualResolutionsCli(repoPath, file);
    console.log(chalk.green(`✔ Removed manual resolution for ${objectionId}.`));
});
program.addCommand(convergenceProgram);
// ── loop ────────────────────────────────────────────────────────────
program
    .command("loop")
    .option("--repo <path>", "Path to target repo (defaults to current directory)")
    .option("--pipeline <name>", "Pipeline name (default.yaml)", "default")
    .option("--feedback-interval <minutes>", "Minutes between feedback cycles", "15")
    .option("--max-cycles <n>", "Maximum number of loop cycles (0=unlimited)", "0")
    .option("--cursor-auto", "Run Cursor builder between pipeline cycles (QA is pipeline independent_qa only)")
    .option("--builder-model <name>", "Override Cursor primary builder model")
    .option("--cursor-command <cmd>", "Override Cursor agent CLI command")
    .option("--max-inner-loops <n>", "Max builder inner iterations per cycle (each ends with a full pipeline re-run)")
    .option("--profile <name>", "release = optimize for shippable RC (QA + release gates); investor = same + re-run growth_operator & investor_panel after each Cursor pass, and enable investor_refinement on phase-1 full runs", "release")
    .option("--no-wait", "Skip sleeps: no delay between outer cycles, no delay on failed phase-1 retry; release approval is interactive in a TTY (no touch-file polling), otherwise skipped without a TTY")
    .option("--quick-phase1", "Legacy: phase 1 only runs consolidate-through-builder (no QA/release/investor until after Cursor). Default is a full pipeline phase 1.")
    .option("--stabilize", "Freeze scope: each outer cycle runs only builder → independent_qa → release_agent (no market/gap/product/monetization/feedback regen). Cursor focuses on QA green (tests/lint/typecheck/Maestro) first; brief backlog in the packet is narrowed until ship+0 blockers. Ignores feedback-queue churn for loop continuation.")
    .description("Autonomous loop: full pipeline (default) → optional Cursor inner iterations → post-Cursor QA/release (and investor stages in investor profile). Prints RELEASE_CANDIDATE: YES/NO each cycle.")
    .action(async (opts) => {
    const repoPath = resolveRepoPath(opts.repo);
    const foundryDir = join(repoPath, ".foundry");
    const feedbackIntervalMs = parseInt(opts.feedbackInterval, 10) * 60 * 1000;
    const maxCycles = parseInt(opts.maxCycles, 10);
    const profileRaw = (opts.profile ?? "release").toLowerCase();
    if (profileRaw !== "release" && profileRaw !== "investor") {
        console.error(chalk.red(`Unknown --profile "${opts.profile}" (use release or investor).`));
        process.exit(1);
    }
    if (opts.stabilize && opts.quickPhase1) {
        console.error(chalk.red("Use either --stabilize or --quick-phase1, not both."));
        process.exit(1);
    }
    const stabilize = Boolean(opts.stabilize);
    const loopProfile = stabilize ? "release" : profileRaw === "investor" ? "investor" : "release";
    const noWait = opts.wait === false;
    if (!(await exists(foundryDir))) {
        console.error(chalk.red("Missing .foundry/ in target repo. Run `foundry init --repo <path>` first."));
        process.exit(1);
    }
    const foundryRoot = FOUNDRY_ROOT;
    const foundryConfig = await loadFoundryConfig(repoPath);
    const easSettings = resolveEasBuildSettings(foundryConfig);
    const cursorSettings = resolveCursorAutomationSettings(foundryConfig, {
        enabled: opts.cursorAuto ? true : undefined,
        builderModel: opts.builderModel,
        command: opts.cursorCommand,
        maxInnerLoops: opts.maxInnerLoops ? parseInt(opts.maxInnerLoops, 10) : undefined,
    });
    let cycle = 0;
    console.log(chalk.bold.cyan("\n🔄 Foundry Autonomous Loop"));
    console.log(chalk.gray(`  Repo: ${repoPath}`));
    console.log(chalk.gray(`  Pipeline: ${opts.pipeline}`));
    console.log(chalk.gray(`  Profile: ${loopProfile} (release = RC gates; investor = + investor_panel after Cursor + refinement on phase 1)`));
    if (stabilize) {
        console.log(chalk.cyan(`  Stabilize: on — phase 1 = ${STABILIZE_PHASE1_STAGES.join(" → ")} only; brief packet narrowed until QA ship + 0 blockers; feedback queue ignored for loop continuation`));
        if (profileRaw === "investor") {
            console.log(chalk.yellow("  Note: --stabilize overrides investor post-Cursor stages (no investor_panel each inner pass)."));
        }
    }
    console.log(chalk.gray(`  Phase 1: ${stabilize ? "stabilize (builder → QA → release_agent)" : opts.quickPhase1 ? "quick (builder brief only)" : "full pipeline (default)"}`));
    console.log(chalk.gray(`  No-wait mode: ${noWait ? "on (no sleeps / no approval polling)" : "off"}`));
    console.log(chalk.gray(`  Feedback interval: ${opts.feedbackInterval}m (ignored when --no-wait)`));
    console.log(chalk.gray(`  Max cycles: ${maxCycles || "unlimited"}\n`));
    if (cursorSettings.enabled) {
        const preflight = await preflightCursorCommand(cursorSettings.command, repoPath);
        if (!preflight.ok) {
            console.error(chalk.red(preflight.detail));
            process.exit(1);
        }
        const modelPreflight = await preflightCursorModels(cursorSettings.command, repoPath, [
            cursorSettings.builderModel,
            cursorSettings.builderFastModel,
            cursorSettings.builderEconomyModel,
        ]);
        if (!modelPreflight.ok) {
            console.error(chalk.red(modelPreflight.detail));
            process.exit(1);
        }
        console.log(chalk.gray(`  Cursor builder model (primary): ${cursorSettings.builderModel}`));
        console.log(chalk.gray(`  Cursor builder model (fast): ${cursorSettings.builderFastModel}`));
        console.log(chalk.gray(cursorSettings.useBuilderEconomyNearRelease
            ? `  Near-release economy: on — uses \`${cursorSettings.builderEconomyModel}\` when QA ship + no code blockers + release is awaiting_approval only (not while brief is still open — set FOUNDRY_USE_BUILDER_ECONOMY=0 to disable)`
            : "  Near-release economy: off (FOUNDRY_USE_BUILDER_ECONOMY=0 or project.yaml use_builder_economy_near_release: false)"));
        console.log(chalk.gray("  Pipeline `builder` + `independent_qa` run codegen/shell (no LLM). Only the Cursor builder step uses models."));
        console.log(chalk.gray(`  Inner pass 1 = primary (or economy near-release); passes 2+ = fast unless stalled or economy applies.`));
        console.log(chalk.gray(`  Cursor max inner loops: ${cursorSettings.maxInnerLoops}\n`));
    }
    if (easSettings.buildOnApproval) {
        console.log(chalk.gray(`  EAS build after approval: ${easSettings.platform}/${easSettings.profile}\n`));
    }
    let lastReleaseFailureKey = "";
    let repeatedReleaseFailureCount = 0;
    while (true) {
        cycle++;
        let abortLoop = false;
        if (maxCycles > 0 && cycle > maxCycles) {
            console.log(chalk.yellow(`\nReached max cycles (${maxCycles}). Stopping.`));
            break;
        }
        console.log(chalk.bold(`\n${"═".repeat(60)}`));
        console.log(chalk.bold.cyan(`  CYCLE ${cycle}`) + chalk.gray(` — ${new Date().toLocaleTimeString()}`));
        console.log(chalk.bold(`${"═".repeat(60)}\n`));
        await backfillExpoBuildViews(repoPath, foundryConfig);
        const phase1Label = stabilize
            ? `Phase 1: Stabilize (${STABILIZE_PHASE1_STAGES.join(" → ")})...`
            : opts.quickPhase1
                ? "Phase 1: Consolidating features and refreshing CURSOR_BRIEF..."
                : loopProfile === "investor"
                    ? "Phase 1: Full pipeline (investor refinement enabled)..."
                    : "Phase 1: Full pipeline (release candidate path)...";
        const pipelineSpinner = ora(phase1Label).start();
        let manifest;
        try {
            manifest = await runPipeline({
                repoPath,
                pipelineName: opts.pipeline,
                foundryRoot,
                quiet: true,
                allowInvestorRefinement: stabilize ? false : loopProfile === "investor",
                stagesOverride: stabilize
                    ? [...STABILIZE_PHASE1_STAGES]
                    : opts.quickPhase1
                        ? [...STRICT_RESET_CONSOLIDATE_STAGES]
                        : undefined,
            });
            pipelineSpinner.succeed("Pipeline complete.");
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            pipelineSpinner.fail(msg);
            if (/ENOSPC|no space left on device/i.test(msg)) {
                console.log(chalk.red.bold("\n  DISK FULL (ENOSPC)"));
                console.log(chalk.red("  Foundry could not write `.foundry/out/*` artifacts for this run."));
                console.log(chalk.red("  Free disk space (or delete old `.foundry/out/*` runs), then re-run the loop.\n"));
                break;
            }
            if (!noWait) {
                console.log(chalk.yellow("Waiting before retry..."));
                await sleep(feedbackIntervalMs);
            }
            continue;
        }
        const printManifest = (m) => {
            const stages = m.stages;
            const stageWidth = 25;
            for (const s of stages) {
                const icon = s.status === "passed" ? chalk.green("✓")
                    : s.status === "failed" ? chalk.red("✗")
                        : s.status === "skipped" ? chalk.gray("○")
                            : chalk.yellow("…");
                const name = s.stage.padEnd(stageWidth);
                const reuse = s.reused ? chalk.gray(" reused") : "";
                const duration = s.durationMs !== undefined ? chalk.gray(`${s.durationMs}ms`) : "";
                console.log(`  ${icon} ${name} ${duration}${reuse}`);
            }
        };
        printManifest(manifest);
        const briefPath = join(foundryDir, "CURSOR_BRIEF.md");
        let releaseOutput = await readStageJson(repoPath, manifest, "release_agent");
        let builderOutput = await readStageJson(repoPath, manifest, "builder");
        let investorOutput = await readStageJson(repoPath, manifest, "investor_panel");
        let briefCounts = await countCriticalBriefItems(briefPath);
        let briefMetrics = await readBriefMetrics(briefPath);
        let pipelineQa = await readStageJson(repoPath, manifest, "independent_qa");
        let feedbackOutput = await readStageJson(repoPath, manifest, "feedback_agent");
        let builderRemainingBlockers = await readBuilderRemainingBlockers(repoPath);
        let workPacket = await buildWorkPacketForRun({
            repoPath,
            foundryDir,
            runId: manifest.runId,
            pipelineQa,
            builder: builderOutput,
            builderRemainingBlockers,
            stabilize,
        });
        let previousProgress;
        let stagnantStreak = 0;
        await logPipelineSnapshot(repoPath, manifest, "After pipeline", briefCounts.total, {
            pipelineQa,
            release: releaseOutput,
        });
        if (builderOutput?.status === "blocked" || builderOutput?.status === "failed") {
            const blockers = extractBuilderBlockers(builderOutput);
            if (blockers.length > 0) {
                console.log(chalk.red(`  Builder blockers (${blockers.length}):`));
                blockers.forEach((b, i) => {
                    console.log(chalk.red(`    ${i + 1}. ${truncateForDisplay(b, 120)}`));
                });
            }
        }
        printUnblockGuidance(buildUnblockGuidance(repoPath, foundryDir, pipelineQa, releaseOutput, builderOutput, builderRemainingBlockers));
        console.log(chalk.gray(`  Work packet: ${workPacketSummaryLine(workPacket)}`));
        const initialProgress = buildIterationProgress(briefMetrics, builderOutput, pipelineQa, releaseOutput, investorOutput, workPacket);
        logIterationProgress(initialProgress, previousProgress, builderOutput, pipelineQa, releaseOutput, investorOutput, stagnantStreak);
        previousProgress = initialProgress;
        if (cursorSettings.enabled) {
            let implementNowFeedbackCount = feedbackOutput?.ledgerSummary?.implementNowItems ?? 0;
            let activePacketCounts = packetBriefCounts(workPacket);
            if (pipelineQa?.recommendation === "ship" && implementNowFeedbackCount === 0 && activePacketCounts.total === 0) {
                const parts = [
                    "Skipping Cursor builder inner loop: pipeline `independent_qa` recommends ship and no active work-packet or feedback items remain.",
                ];
                console.log(chalk.cyan(`  ${parts.join(" ")}`));
            }
            else if (implementNowFeedbackCount > 0 && !stabilize) {
                console.log(chalk.cyan(`  ${implementNowFeedbackCount} feedback item(s) are queued for implementation; continuing Cursor builder even though QA is green.`));
            }
            else if (pipelineQa?.recommendation === "ship" && activePacketCounts.total > 0) {
                console.log(chalk.cyan(`  QA is green, but ${activePacketCounts.total} active work-packet item(s) remain open; continuing Cursor builder before release approval.`));
            }
            if (qaNeedsPremiumCursorBuilder(pipelineQa)) {
                const em = resolveEffectiveInnerLoopMax(cursorSettings.maxInnerLoops, pipelineQa);
                console.log(chalk.gray(`  QA repair mode: up to ${em} inner pass(es) with primary builder until ship + tests green (FOUNDRY_QA_FIX_MAX_INNER_LOOPS / FOUNDRY_QA_FIX_MAX_INNER_CAP).`));
            }
            let inner = 0;
            let previousSignature = "";
            let repeatedNoProgressCount = 0;
            while (shouldRunCursorAutomation(releaseOutput?.status, activePacketCounts, pipelineQa?.recommendation, implementNowFeedbackCount, { stabilize })) {
                if (releaseOutput?.status === "awaiting_approval" &&
                    pipelineQa?.recommendation === "ship" &&
                    (pipelineQa?.blockers?.length ?? 0) === 0) {
                    console.log(chalk.cyan("\n  Release is awaiting_approval with QA ship + 0 blockers — skipping further Cursor passes and going to the approval prompt."));
                    break;
                }
                const effectiveMaxInner = resolveEffectiveInnerLoopMax(cursorSettings.maxInnerLoops, pipelineQa);
                if (inner >= effectiveMaxInner) {
                    console.log(chalk.yellow(`\n  Inner loop cap reached (${effectiveMaxInner} pass(es)) — ${qaNeedsPremiumCursorBuilder(pipelineQa)
                        ? stabilize
                            ? "QA/tests still need work; next outer cycle re-runs builder → independent_qa → release_agent."
                            : "QA/tests still need work; next outer cycle will re-run the full pipeline."
                        : "continuing outer loop on next cycle."}`));
                    break;
                }
                inner++;
                const prePacketOpen = workPacketOpenCount(workPacket);
                const preQaBlockers = pipelineQa?.blockers?.length ?? 0;
                const briefSamples = sampleOpenPacketItems(workPacket, 14);
                logInnerLoopTargets(inner, effectiveMaxInner, activePacketCounts.total, briefSamples, pipelineQa);
                console.log(chalk.gray(`  Packet mix: must=${activePacketCounts.mustShip} · should=${activePacketCounts.shouldShip} · gaps=${activePacketCounts.unresolvedGaps} · monetization=${activePacketCounts.monetization} · edge=${activePacketCounts.edgeFunctions} · backlog=${briefCounts.total}`));
                const focusAbs = join(repoPath, ".foundry", "automation", manifest.runId, `iteration-${inner}-focus.md`);
                await mkdir(dirname(focusAbs), { recursive: true });
                await writeFile(focusAbs, formatIterationFocusMarkdown({
                    inner,
                    maxInner: effectiveMaxInner,
                    briefCounts: activePacketCounts,
                    briefSamples,
                    pipelineQa,
                    builderRemainingBlockers,
                    stabilize,
                    openTrackedBriefSample: await sampleUncheckedBriefLines(briefPath, 14),
                }), "utf8");
                console.log(chalk.gray(`  Longer context: ${focusAbs}`));
                const qaCodeBlockerCount = separateManualAndCodeItems(pipelineQa?.blockers ?? []).code.length;
                const builderChoice = chooseBuilderModel(cursorSettings, activePacketCounts, pipelineQa, repeatedNoProgressCount, inner, stabilize ? 0 : implementNowFeedbackCount, releaseOutput?.status);
                const builderSpinner = ora(`Cursor builder agent (${builderChoice.model})`).start();
                console.log(chalk.gray(`  Builder model reason: ${builderChoice.reason}`));
                console.log(chalk.gray(`  Live builder log: ${join(repoPath, ".foundry", "automation", manifest.runId, "builder.log")}`));
                const builderRun = await runBuilderAgent(repoPath, manifest, cursorSettings, builderChoice.model, {
                    innerLoopIndex: inner,
                });
                if (builderRun.ok) {
                    builderSpinner.succeed("Cursor builder agent completed.");
                    console.log(chalk.gray(`  Builder log: ${builderRun.logPath}`));
                    const crs = await summarizeCursorBuilderReportMd(repoPath);
                    console.log(chalk.cyan(`  Cursor builder report: ${crs}`));
                    if (!builderRun.hadCodeChanges) {
                        console.log(chalk.red.bold("\n  ABORTING: NO REAL CODE CHANGES"));
                        console.log(chalk.red("  Cursor completed but did not modify any non-generated app/backend files."));
                        if (builderRun.implementationRetryUsed) {
                            console.log(chalk.gray("  (An automatic implementation retry with the primary builder model already ran.)"));
                        }
                        if (builderRun.statusHint) {
                            console.log(chalk.gray(`  Git: ${builderRun.statusHint}`));
                        }
                        console.log(chalk.red("  Packet items cannot be closed without code. Stopping Foundry to avoid token burn.\n"));
                        abortLoop = true;
                        break;
                    }
                    const qaHasMaestroBlocker = (pipelineQa?.blockers ?? []).some((b) => /maestro smoke flows failed/i.test(b)) ||
                        (pipelineQa?.manualTasks ?? []).some((t) => /\bmaestro\b/i.test(t));
                    const qaRepairRelaxFileRules = stabilize || qaNeedsPremiumCursorBuilder(pipelineQa) || qaHasMaestroBlocker;
                    const changedProductFiles = builderRun.changedFiles.filter(isProductFeaturePath);
                    if (changedProductFiles.length === 0) {
                        const hasTestTouch = builderRun.changedFiles.some(isTestLikePath);
                        if (inner >= 2 && hasTestTouch) {
                            console.log(chalk.yellow("\n  Inner refinement: no non-test product-path edits; test-only changes kept (pass 2+ allows QA/test hardening without new feature files)."));
                        }
                        else if (inner === 1 && qaRepairRelaxFileRules && hasTestTouch) {
                            console.log(chalk.yellow("\n  QA repair / stabilize: test-only changes on pass 1 — allowed (e.g. `.maestro/` flows, snapshots, mocks)."));
                        }
                        else if (inner === 1 &&
                            qaRepairRelaxFileRules &&
                            builderRun.changedFiles.length > 0 &&
                            builderRun.changedFiles.every((p) => p.startsWith(".foundry/") && !p.startsWith(".foundry/out/"))) {
                            console.log(chalk.yellow("\n  QA repair / stabilize pass 1: only `.foundry/` files changed (e.g. project.yaml). Continuing once — next pass should change app code, Jest tests under __tests__/*.test.*, or `.maestro/` flows so independent_qa can improve."));
                        }
                        else {
                            console.log(chalk.red.bold("\n  ABORTING: NO PRODUCT FEATURE CHANGES"));
                            console.log(chalk.red("  Cursor changed files, but none counted as product feature paths (app/src code under apps/, packages/, supabase/, or common repo roots like src/, app/, screens/, etc)."));
                            console.log(chalk.red(inner < 2 && !qaRepairRelaxFileRules
                                ? "  Stopping Foundry so the first pass targets real feature work, not metadata-only churn."
                                : "  Stopping Foundry — add product-path changes or test updates under recognized test paths."));
                            console.log("");
                            abortLoop = true;
                            break;
                        }
                    }
                    const nonMonetizationFeatureFiles = changedProductFiles.filter((path) => !isMonetizationLikePath(path));
                    const nonMonetizationOpenPacketTargets = activePacketCounts.mustShip +
                        activePacketCounts.shouldShip +
                        activePacketCounts.unresolvedGaps +
                        activePacketCounts.edgeFunctions +
                        activePacketCounts.runtime;
                    const monetizationOnlyProductChange = changedProductFiles.length > 0 && nonMonetizationFeatureFiles.length === 0;
                    if (nonMonetizationOpenPacketTargets > 0 && monetizationOnlyProductChange) {
                        console.log(chalk.red.bold("\n  ABORTING: MONETIZATION-ONLY CHANGES"));
                        console.log(chalk.red(`  Open work packet still lists ${nonMonetizationOpenPacketTargets} non-monetization target(s) (must/QA, should, gaps/builder, edge, runtime), but Cursor only changed monetization/analytics-oriented product files.`));
                        console.log(chalk.red("  Scope should match the packet: touch at least one non-monetization product path while those rows stay open, or close/descope them explicitly."));
                        console.log(chalk.gray("  (When the only open packet rows are monetization, monetization-only edits are allowed — one Cursor pass may still not clear every row; the outer loop can run again.)"));
                        console.log("");
                        abortLoop = true;
                        break;
                    }
                    const changedTestFiles = builderRun.changedFiles.filter(isTestLikePath);
                    if (changedTestFiles.length === 0) {
                        if (qaRepairRelaxFileRules) {
                            console.log(chalk.gray("\n  QA repair / stabilize: no test-path edits in this commit — continuing (product, Maestro, or config fixes often clear failing tests without touching __tests__)."));
                        }
                        else if (inner >= 2 && changedProductFiles.length > 0) {
                            console.log(chalk.yellow("\n  Inner refinement: commit has no test-path edits — continuing (pass 2+; product paths already changed this commit)."));
                        }
                        else {
                            console.log(chalk.red.bold("\n  ABORTING: NO TEST CHANGES"));
                            console.log(chalk.red("  First inner pass (or no product-path edits this commit): include test updates under __tests__ or *.test.* when you change behavior."));
                            console.log(chalk.red("  Pass 2+ skips this rule if non-test product files changed — use pass 1 for test + feature together.\n"));
                            abortLoop = true;
                            break;
                        }
                    }
                    const changedForLog = builderRun.changedFiles.filter((p) => !p.startsWith(".maestro-debug/"));
                    console.log(chalk.gray(`  Code files changed: ${changedForLog.length ? changedForLog.slice(0, 8).join(", ") : "(none)"}`));
                    if (builderRun.pushWarning) {
                        console.log(chalk.yellow(`  Push: committed locally but could not push to origin — ${builderRun.pushWarning.replace(/\n/g, "\n  ")}`));
                    }
                }
                else {
                    builderSpinner.fail(`Cursor builder agent failed (exit ${builderRun.exitCode}).`);
                    console.log(chalk.red(`  Builder log: ${builderRun.logPath}`));
                    if (builderRun.stderr?.trim()) {
                        console.log(chalk.red(`  ${builderRun.stderr.trim().replace(/\n/g, "\n  ")}`));
                    }
                    const agentBlob = `${builderRun.stderr}\n${builderRun.stdout}`;
                    if (/Cannot find module '@anysphere\/file-service/i.test(agentBlob)) {
                        console.log(chalk.yellow("\n  Cursor `agent` failed to load a native dependency. Reinstall/update Cursor (CLI bundled with the app), verify CPU arch matches the binary, or set `cursor_automation.command` / FOUNDRY_CURSOR_AGENT_CMD to a working agent path."));
                    }
                    abortLoop = true;
                    break;
                }
                const postStages = postCursorStagesForLoop(loopProfile, stabilize);
                const rerunSpinner = ora(`Re-running after Cursor: ${postStages.join(" → ")}...`).start();
                try {
                    manifest = await runPipeline({
                        repoPath,
                        pipelineName: opts.pipeline,
                        foundryRoot,
                        quiet: true,
                        allowInvestorRefinement: false,
                        stagesOverride: postStages,
                    });
                    rerunSpinner.succeed("Post-Cursor pipeline re-run complete.");
                    printManifest(manifest);
                }
                catch (err) {
                    rerunSpinner.fail(err instanceof Error ? err.message : String(err));
                    break;
                }
                releaseOutput = await readStageJson(repoPath, manifest, "release_agent");
                const rerunBuilderOutput = await readStageJson(repoPath, manifest, "builder");
                if (rerunBuilderOutput) {
                    builderOutput = rerunBuilderOutput;
                }
                investorOutput = await readStageJson(repoPath, manifest, "investor_panel");
                briefCounts = await countCriticalBriefItems(briefPath);
                briefMetrics = await readBriefMetrics(briefPath);
                pipelineQa = await readStageJson(repoPath, manifest, "independent_qa");
                feedbackOutput = await readStageJson(repoPath, manifest, "feedback_agent");
                implementNowFeedbackCount = feedbackOutput?.ledgerSummary?.implementNowItems ?? 0;
                builderRemainingBlockers = await readBuilderRemainingBlockers(repoPath);
                workPacket = await refreshWorkPacket(repoPath, workPacket, {
                    briefOpenItems: stabilize
                        ? filterBriefItemsForStabilizePhase(await readOpenBriefItems(briefPath), pipelineQa)
                        : await readOpenBriefItems(briefPath),
                    checkedBriefItems: await readCheckedBriefItems(briefPath),
                    qaCodeBlockers: separateManualAndCodeItems([
                        ...(pipelineQa?.blockers ?? []),
                        ...(pipelineQa?.manualTasks ?? []),
                    ]).code,
                    builderCodeBlockers: separateManualAndCodeItems([
                        ...extractBuilderBlockers(builderOutput),
                        ...builderRemainingBlockers,
                    ]).code,
                    manualOnly: [
                        ...separateManualAndCodeItems([
                            ...(pipelineQa?.blockers ?? []),
                            ...(pipelineQa?.manualTasks ?? []),
                            ...extractBuilderBlockers(builderOutput),
                            ...builderRemainingBlockers,
                        ]).manual,
                    ],
                    codeChanged: builderRun.hadCodeChanges,
                });
                activePacketCounts = packetBriefCounts(workPacket);
                const postQaBlockers = pipelineQa?.blockers?.length ?? 0;
                await logPipelineSnapshot(repoPath, manifest, "After pipeline (post-Cursor)", briefCounts.total, {
                    pipelineQa,
                    release: releaseOutput,
                });
                printUnblockGuidance(buildUnblockGuidance(repoPath, foundryDir, pipelineQa, releaseOutput, builderOutput, builderRemainingBlockers));
                console.log(chalk.gray(`  Work packet: ${workPacketSummaryLine(workPacket)}`));
                const currentProgress = buildIterationProgress(briefMetrics, builderOutput, pipelineQa, releaseOutput, investorOutput, workPacket, builderRun.changedFiles.length);
                if (previousProgress &&
                    currentProgress.packetOpen >= previousProgress.packetOpen &&
                    currentProgress.packetClosed <= previousProgress.packetClosed &&
                    currentProgress.qaBlockers >= previousProgress.qaBlockers &&
                    currentProgress.blockedChecklist >= previousProgress.blockedChecklist) {
                    if (!qaMaestroSmokeOnlyShipGreen(pipelineQa)) {
                        stagnantStreak++;
                    }
                }
                else {
                    stagnantStreak = 0;
                }
                logIterationProgress(currentProgress, previousProgress, builderOutput, pipelineQa, releaseOutput, investorOutput, stagnantStreak);
                previousProgress = currentProgress;
                if (stagnantStreak >= 3) {
                    console.log(chalk.red.bold("\n  CONVERGENCE STALLED"));
                    console.log(chalk.red("  No net closure across packet/release/QA metrics for multiple iterations."));
                    console.log(chalk.red(`  Review unresolved items in: ${join(foundryDir, "WORK_PACKET.md")}`));
                    console.log(chalk.red("  Stopping inner loop to avoid churn; the next outer cycle will build a fresh packet.\n"));
                    break;
                }
                console.log(chalk.gray(`  Δ vs start of inner iter: packet ${prePacketOpen}→${workPacketOpenCount(workPacket)} · QA blockers ${preQaBlockers}→${postQaBlockers} · ${pipelineQa?.recommendation ?? "?"}`));
                const packetClosedThisPass = Math.max(0, prePacketOpen - workPacketOpenCount(workPacket));
                if (inner === 1 && prePacketOpen >= 8 && packetClosedThisPass === 0) {
                    console.log(chalk.yellow.bold("\n  WARNING: NO PACKET ITEMS CLOSED ON FIRST PASS"));
                    console.log(chalk.yellow(`  ${packetClosedThisPass}/${prePacketOpen} packet items closed — consider tightening the Cursor prompt or packet scope; continuing inner loop.`));
                }
                const combinedItems = [
                    ...(pipelineQa?.blockers ?? []),
                    ...(pipelineQa?.manualTasks ?? []),
                    ...(pipelineQa?.warnings ?? []),
                    ...builderRemainingBlockers,
                ];
                const separated = separateManualAndCodeItems(combinedItems);
                if (separated.manual.length > 0) {
                    console.log(chalk.yellow.bold("\n  MANUAL TASKS DETECTED"));
                    for (const item of separated.manual.slice(0, 8)) {
                        console.log(chalk.yellow(`  - ${item}`));
                    }
                    if (separated.code.length === 0 && workPacketOpenCount(workPacket) === 0) {
                        console.log(chalk.yellow("  Only manual external tasks remain. Stopping automation to avoid burning more Cursor quota.\n"));
                        break;
                    }
                    if (separated.code.length > 0) {
                        console.log(chalk.yellow("  Continuing because repo-fixable code blockers still remain.\n"));
                    }
                    else {
                        console.log(chalk.yellow("  Manual-only warnings noted; no pipeline QA code blockers — inner loop driven by brief / recommendation state.\n"));
                    }
                }
                const signature = JSON.stringify({
                    packetOpen: workPacketOpenCount(workPacket),
                    pipelineQaRecommendation: pipelineQa?.recommendation ?? "missing",
                    qaBlockers: separated.code,
                    builderRemainingBlockers: separateManualAndCodeItems(builderRemainingBlockers).code,
                });
                const pipelineQaShip = pipelineQa?.recommendation === "ship";
                if (signature === previousSignature) {
                    repeatedNoProgressCount++;
                }
                else {
                    repeatedNoProgressCount = 0;
                }
                previousSignature = signature;
                if (!pipelineQaShip && repeatedNoProgressCount >= 2) {
                    console.log(chalk.yellow.bold("\n  AUTOMATION STALLED"));
                    console.log(chalk.yellow("  The loop produced the same blocker state three times in a row."));
                    console.log(chalk.yellow("  Stopping now to avoid burning more Cursor quota."));
                    console.log(chalk.yellow(`  Builder report: ${join(foundryDir, "CURSOR_BUILDER_REPORT.md")}`));
                    console.log(chalk.yellow(`  Pipeline QA: ${join(foundryDir, "out", manifest.runId)}/*/independent_qa/README.md\n`));
                    break;
                }
                if (workPacketOpenCount(workPacket) === 0 && briefCounts.total > 0 && inner < cursorSettings.maxInnerLoops) {
                    workPacket = await buildWorkPacketForRun({
                        repoPath,
                        foundryDir,
                        runId: manifest.runId,
                        pipelineQa,
                        builder: builderOutput,
                        builderRemainingBlockers,
                        stabilize,
                    });
                    activePacketCounts = packetBriefCounts(workPacket);
                    console.log(chalk.cyan(`  Next packet loaded: ${workPacketSummaryLine(workPacket)}`));
                }
            }
        }
        if (abortLoop &&
            releaseOutput?.status !== "awaiting_approval" &&
            releaseOutput?.status !== "approved" &&
            releaseOutput?.status !== "auto_approved") {
            break;
        }
        if (abortLoop) {
            console.log(chalk.yellow("\n  Inner loop aborted, but release is ready — continuing to approval prompt.\n"));
        }
        logReleaseCandidateLine(pipelineQa, releaseOutput);
        if (loopProfile === "investor") {
            logInvestorScoreLine(investorOutput);
        }
        if (releaseOutput?.status === "awaiting_approval") {
            console.log(chalk.yellow.bold("\n  RELEASE READY — APPROVAL REQUIRED"));
            console.log(chalk.yellow(`  Review: ${repoPath}/.foundry/APPROVAL_REQUIRED.md`));
            console.log(chalk.yellow(`  Pipeline QA certified (independent_qa recommends ship, score=${pipelineQa?.score ?? "?"}).\n`));
            if (releaseOutput.approvalFile) {
                const approvalPath = join(repoPath, releaseOutput.approvalFile);
                if (noWait && (!process.stdin.isTTY || !process.stdout.isTTY)) {
                    console.log(chalk.gray("  --no-wait: skipping interactive approval (no TTY). Re-run without --no-wait in an interactive terminal to approve, or create the approval file manually."));
                    console.log(chalk.gray("  Stopping now to avoid starting another cycle while a release is already awaiting approval.\n"));
                    break;
                }
                const easSettings = resolveEasBuildSettings(foundryConfig);
                if (isEasReleaseEligible(foundryConfig)) {
                    console.log(chalk.bold.cyan("\n  Release actions (interactive)"));
                    console.log(chalk.gray("  Choose EAS/TestFlight now; Foundry runs your choices after you approve below and the builder branch is merged."));
                }
                const presolvedReleaseChoices = await promptReleaseActions(repoPath, easSettings, foundryConfig);
                const approved = await promptReleaseApproval(approvalPath);
                if (!approved) {
                    console.log(chalk.gray("  Stopping: release approval was not granted.\n"));
                    break;
                }
                const releaseResult = await runApprovedReleaseActions(repoPath, foundryConfig, manifest, "approved", presolvedReleaseChoices);
                if (!releaseResult.ok) {
                    if (releaseResult.retryLoop) {
                        const key = releaseResult.failureKey ?? "release-action-failed";
                        repeatedReleaseFailureCount = key === lastReleaseFailureKey ? repeatedReleaseFailureCount + 1 : 1;
                        lastReleaseFailureKey = key;
                        if (repeatedReleaseFailureCount >= 2) {
                            console.log(chalk.red.bold("\n  RELEASE ACTION FAILURE REPEATED"));
                            console.log(chalk.red("  The same release action failed again after a feedback/build cycle. Stopping to avoid an infinite loop."));
                            if (releaseResult.failureLogPath)
                                console.log(chalk.red(`  Latest log: ${releaseResult.failureLogPath}`));
                            break;
                        }
                        console.log(chalk.yellow("\n  Release actions produced a fresh failure artifact. Continuing immediately into the next full loop cycle so Expo build logs can be ingested and repo-fixable errors can be queued for Cursor.\n"));
                        continue;
                    }
                    break;
                }
                break;
            }
        }
        else if (releaseOutput?.status === "approved" || releaseOutput?.status === "auto_approved") {
            console.log(chalk.green.bold("\n  Release approved — shipping"));
        }
        else if (releaseOutput?.status === "blocked_pre_release") {
            console.log(chalk.cyan("\n  Release not ready yet (pre-release gates): QA recommends ship."));
            console.log(chalk.cyan(`  independent_qa recommendation=${pipelineQa?.recommendation ?? "?"}, score=${pipelineQa?.score ?? "?"} — finish tracked CURSOR_BRIEF items, builder readiness, and checklist rows before approval.`));
            console.log(chalk.cyan(`  Builder report: ${join(foundryDir, "CURSOR_BUILDER_REPORT.md")}\n`));
        }
        else if (releaseOutput?.status === "blocked_by_qa") {
            const qaRecommendation = pipelineQa?.recommendation ?? "unknown";
            if (qaRecommendation !== "ship") {
                console.log(chalk.cyan("\n  Release blocked: pipeline `independent_qa` did not recommend ship."));
                console.log(chalk.cyan(`  recommendation=${qaRecommendation}, score=${pipelineQa?.score ?? "?"}. See this run's independent_qa README under .foundry/out/${manifest.runId}/`));
                console.log(chalk.cyan("  Fix tests, lint, typecheck, or Maestro (if required), then re-run. Cursor agents only help implement fixes — they are not a second QA gate.\n"));
            }
            else {
                console.log(chalk.cyan("\n  Release blocked: QA is green, but non-QA gates are still blocked."));
                console.log(chalk.cyan(`  independent_qa recommendation=${qaRecommendation}, score=${pipelineQa?.score ?? "?"}; builder status=${builderOutput?.status ?? "unknown"}.`));
                const blockers = extractBuilderBlockers(builderOutput);
                if (blockers.length > 0) {
                    console.log(chalk.cyan("  Active builder blockers:"));
                    blockers.forEach((b, i) => {
                        console.log(chalk.cyan(`    ${i + 1}. ${truncateForDisplay(b, 120)}`));
                    });
                }
                console.log(chalk.cyan(`  Builder report: ${join(foundryDir, "CURSOR_BUILDER_REPORT.md")}\n`));
            }
        }
        const feedbackStage = manifest.stages.find((s) => s.stage === "feedback_agent");
        if (feedbackStage?.status === "passed") {
            console.log(chalk.gray(noWait
                ? "\n  Feedback collected. Next cycle immediately (--no-wait)."
                : `\n  Feedback collected. Next cycle in ${opts.feedbackInterval} minutes.`));
        }
        // Summary
        console.log(chalk.gray(`\n  Run: ${manifest.runId}`));
        console.log(chalk.gray(`  Artifacts: ${join(foundryDir, "out", manifest.runId)}`));
        console.log(chalk.gray(`  CURSOR_BRIEF: ${join(foundryDir, "CURSOR_BRIEF.md")}`));
        console.log(chalk.gray(`  CURSOR_BUILDER_REPORT: ${join(foundryDir, "CURSOR_BUILDER_REPORT.md")}`));
        console.log(chalk.gray(`  PIPELINE_QA: recommendation=${pipelineQa?.recommendation ?? "missing"}, score=${pipelineQa?.score ?? "—"}`));
        console.log(chalk.gray(`  Legacy optional notes (ignored for ship): ${join(foundryDir, "CURSOR_QA_REPORT.md")}`));
        if (releaseOutput?.status === "approved" || releaseOutput?.status === "auto_approved") {
            const releaseResult = await runApprovedReleaseActions(repoPath, foundryConfig, manifest, releaseOutput?.status);
            if (!releaseResult.ok) {
                if (releaseResult.retryLoop) {
                    const key = releaseResult.failureKey ?? "release-action-failed";
                    repeatedReleaseFailureCount = key === lastReleaseFailureKey ? repeatedReleaseFailureCount + 1 : 1;
                    lastReleaseFailureKey = key;
                    if (repeatedReleaseFailureCount >= 2) {
                        console.log(chalk.red.bold("\n  RELEASE ACTION FAILURE REPEATED"));
                        console.log(chalk.red("  The same release action failed again after a feedback/build cycle. Stopping to avoid an infinite loop."));
                        if (releaseResult.failureLogPath)
                            console.log(chalk.red(`  Latest log: ${releaseResult.failureLogPath}`));
                        break;
                    }
                    console.log(chalk.yellow("\n  Release actions produced a fresh failure artifact. Continuing immediately into the next full loop cycle so Expo build logs can be ingested and repo-fixable errors can be queued for Cursor.\n"));
                    continue;
                }
                break;
            }
            break;
        }
        if (maxCycles > 0 && cycle >= maxCycles)
            break;
        if (noWait) {
            console.log(chalk.gray("\n  --no-wait: starting next cycle immediately (Ctrl+C to stop).\n"));
        }
        else {
            console.log(chalk.gray(`\n  Sleeping ${opts.feedbackInterval} minutes until next cycle...`));
            console.log(chalk.gray(`  Press Ctrl+C to stop.\n`));
            await sleep(feedbackIntervalMs);
        }
    }
    console.log(chalk.bold.cyan("\nLoop finished."));
});
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
const normalizedArgv = process.argv.filter((arg, index) => !(index >= 2 && arg === "--"));
program.parseAsync(normalizedArgv);
