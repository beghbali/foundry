import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { writeStageJson, writeStageMarkdown } from "./artifacts.js";
import { loadFoundryConfig } from "./config.js";
import { STAGES_ELIGIBLE_FOR_REUSE, computeRepoFingerprint, fingerprintStageInput, isStageReuseEnabled, rememberStageOutput, tryGetReusableStageOutput, } from "./pipelineStageCache.js";
import { getStageInput, } from "./stageInputs.js";
import { getStageRegistry } from "./registry.js";
function defaultLogger() {
    return (msg, meta) => {
        if (meta !== undefined)
            console.log(msg, meta);
        else
            console.log(msg);
    };
}
function quietPipelineLogger() {
    return () => {
        /* loop mode: avoid per-stage console noise */
    };
}
async function writeRunManifest(outDir, manifest) {
    try {
        await mkdir(outDir, { recursive: true });
        await writeFile(join(outDir, "run.json"), JSON.stringify(manifest, null, 2), "utf8");
    }
    catch (err) {
        const e = err;
        if (e?.code === "ENOSPC") {
            throw new Error(`ENOSPC: no space left on device while writing Foundry run manifest (${join(outDir, "run.json")}). ` +
                "Free disk space (or delete old `.foundry/out/*` runs) and re-run.");
        }
        throw err;
    }
}
/**
 * Load pipeline YAML from `<foundryRoot>/pipelines/<name>.yaml`.
 */
export async function loadPipelineYaml(foundryRoot, pipelineName) {
    const pipelinePath = resolve(foundryRoot, "pipelines", `${pipelineName}.yaml`);
    const raw = await readFile(pipelinePath, "utf8");
    const doc = YAML.parse(raw);
    if (!doc?.stages || !Array.isArray(doc.stages)) {
        throw new Error(`Invalid pipeline YAML: ${pipelinePath} (expected stages: string[])`);
    }
    let investor_refinement;
    const ir = doc.investor_refinement;
    if (ir && typeof ir.restart_from === "string" && ir.restart_from.trim()) {
        const mr = Number(ir.max_rounds);
        if (Number.isFinite(mr) && mr >= 1 && mr <= 20) {
            investor_refinement = { restart_from: ir.restart_from.trim(), max_rounds: Math.floor(mr) };
        }
    }
    return { stages: doc.stages, investor_refinement };
}
/** Shape must stay aligned with `investor_panel` stage `output.json` (avoid core→stages import cycle). */
const InvestorPanelRunnerShape = z.object({
    meetsMinimumGradeA: z.boolean(),
    combinedRefinementDirectives: z.array(z.string()),
    investors: z.array(z.object({
        displayName: z.string(),
        grade: z.string(),
        response: z.string(),
    })),
});
const BuilderRunnerShape = z.object({
    status: z.enum(["ok", "partial", "blocked", "failed"]).optional(),
    changes: z.object({
        filesCreated: z.array(z.string()).optional(),
        filesModified: z.array(z.string()).optional(),
        filesSkipped: z.array(z.string()).optional(),
    }).optional(),
});
const IndependentQaRunnerShape = z.object({
    recommendation: z.string().optional(),
    blockers: z.array(z.string()).optional(),
});
/**
 * Shape must stay aligned with `convergence_contract` stage `output.json`
 * (avoid core→stages import cycle). Only the fields the runner gates on are
 * validated.
 */
const ConvergenceContractRunnerShape = z.object({
    isConverged: z.boolean(),
    refinementRound: z.number().int().min(0),
    convergenceWarnings: z.array(z.string()).default([]),
    openObjections: z
        .array(z.object({
        id: z.string(),
        status: z.enum(["open", "reduced", "resolved", "regressed"]),
        objection: z.string(),
        firstSeenRound: z.number().int().min(0),
        lastSeenRound: z.number().int().min(0),
    }))
        .default([]),
    mvpBoundary: z
        .object({
        mustShip: z.array(z.string()).default([]),
        mustNotShipYet: z.array(z.string()).default([]),
    })
        .default({ mustShip: [], mustNotShipYet: [] }),
});
function investorPanelMeetsBar(out) {
    const p = InvestorPanelRunnerShape.safeParse(out);
    return p.success && p.data.meetsMinimumGradeA;
}
async function countOpenTrackedBriefItems(repoPath) {
    const briefPath = join(repoPath, ".foundry", "CURSOR_BRIEF.md");
    let raw = "";
    try {
        raw = await readFile(briefPath, "utf8");
    }
    catch {
        return 0;
    }
    let openTrackedItems = 0;
    let section = "other";
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
        if (!trimmed.startsWith("- [ ]"))
            continue;
        if (section === "other")
            continue;
        openTrackedItems++;
    }
    return openTrackedItems;
}
async function shouldDeferInvestorRefinementToCursor(repoPath, priorOutputs) {
    const builder = BuilderRunnerShape.safeParse(priorOutputs["builder"]);
    const qa = IndependentQaRunnerShape.safeParse(priorOutputs["independent_qa"]);
    if (!builder.success || !qa.success)
        return { defer: false };
    const qaGreen = qa.data.recommendation === "ship";
    const builderReady = builder.data.status === "ok" || builder.data.status === "partial";
    const deterministicFilesChanged = (builder.data.changes?.filesCreated?.length ?? 0) + (builder.data.changes?.filesModified?.length ?? 0);
    const openBriefItems = await countOpenTrackedBriefItems(repoPath);
    const onlyCursorWorkRemains = builderReady && qaGreen && deterministicFilesChanged === 0 && openBriefItems > 0;
    if (!onlyCursorWorkRemains)
        return { defer: false };
    return {
        defer: true,
        reason: `QA already recommends ship, deterministic builder changes are exhausted, and ` +
            `${openBriefItems} tracked CURSOR_BRIEF item(s) remain. Deferring investor refinement to Cursor packet execution.`,
    };
}
async function countOpenWorkPacketItems(repoPath) {
    try {
        const raw = await readFile(join(repoPath, ".foundry", "WORK_PACKET.json"), "utf8");
        const j = JSON.parse(raw);
        const open = (j.items ?? []).filter((i) => i.status === "open" && !isNonActionablePacketText(i.text ?? "")).length;
        return { open, filePresent: true };
    }
    catch {
        return { open: 0, filePresent: false };
    }
}
function isNonActionablePacketText(text) {
    const t = text.trim().toLowerCase();
    return (/external to the repository/.test(t) ||
        /not by product code/.test(t) ||
        /shell_session_update/.test(t) ||
        /repository-wide hygiene warnings/.test(t) ||
        /non-blocking.*outside/.test(t) ||
        /playwright chromium was not installed/.test(t) ||
        /\benospc\b/.test(t));
}
async function shouldSkipInvestorPanelStage(repoPath, priorOutputs, projectFoundry) {
    const builderRaw = priorOutputs["builder"];
    const builder = BuilderRunnerShape.safeParse(builderRaw);
    const qa = IndependentQaRunnerShape.safeParse(priorOutputs["independent_qa"]);
    const convergenceRaw = priorOutputs["convergence_contract"];
    const convergence = ConvergenceContractRunnerShape.safeParse(convergenceRaw);
    const convergenceInPipeline = convergenceRaw !== undefined;
    if (builderRaw !== undefined) {
        if (!builder.success) {
            return {
                skip: true,
                cause: "builder",
                reason: "Builder output is present but invalid; investor_panel deferred.",
            };
        }
        if (builder.data.status !== "ok" && builder.data.status !== "partial") {
            return {
                skip: true,
                cause: "builder",
                reason: "Builder is not in a ready state. Investor pitch deferred until deterministic implementation is complete.",
            };
        }
    }
    // `builder` omitted (e.g. post-Cursor pipeline slice: QA → release → growth → investor) — gate on QA only.
    if (!qa.success || qa.data.recommendation !== "ship") {
        return {
            skip: true,
            cause: "qa",
            reason: "Pipeline QA is not yet ship-certified. Investor pitch deferred until QA passes.",
        };
    }
    const blockers = qa.data.blockers ?? [];
    if (blockers.length > 0) {
        return {
            skip: true,
            cause: "qa",
            reason: `Pipeline QA still lists ${blockers.length} blocker(s); investor_panel deferred until smoke/tests are clean.`,
        };
    }
    // CONVERGENCE GATE — applies by default whenever `convergence_contract` is in the pipeline.
    // Investors must only see the panel when the pitch reflects what is actually built and when
    // every objection raised by a previous round has been resolved or reduced. Anything weaker
    // would let the panel grade aspirational scope instead of the current product+repo state.
    if (convergenceInPipeline) {
        if (!convergence.success) {
            return {
                skip: true,
                cause: "convergence",
                reason: "convergence_contract output is present but invalid; investor_panel deferred until the contract validates.",
            };
        }
        if (!convergence.data.isConverged) {
            const w = convergence.data.convergenceWarnings.length;
            return {
                skip: true,
                cause: "convergence",
                reason: `Convergence gate: contract is not converged (round ${convergence.data.refinementRound}, ${w} warning(s)). Investor pitch must match a converged contract — see \`foundry convergence status\`.`,
            };
        }
        const unresolvedObjections = convergence.data.openObjections.filter((o) => o.status === "open" || o.status === "regressed");
        if (unresolvedObjections.length > 0) {
            const sample = unresolvedObjections.slice(0, 3).map((o) => o.id).join(", ");
            return {
                skip: true,
                cause: "convergence",
                reason: `Convergence gate: ${unresolvedObjections.length} open/regressed investor objection(s) from prior round(s) (${sample}${unresolvedObjections.length > 3 ? ", …" : ""}). Resolve them before re-pitching — see \`foundry convergence status\`.`,
            };
        }
    }
    // RELEASE-READINESS GATE — open brief / open packet items mean the must-ship scope (which the
    // contract derived from prior investor input) hasn't actually been built yet. With
    // `convergence_contract` in the pipeline this is enforced by default; without it, opt in
    // via project.yaml `foundry.investor_panel_when_release_ready: true`.
    const enforceReleaseReadiness = convergenceInPipeline || projectFoundry?.investor_panel_when_release_ready === true;
    if (enforceReleaseReadiness) {
        const briefOpen = await countOpenTrackedBriefItems(repoPath);
        if (briefOpen > 0) {
            return {
                skip: true,
                cause: "release_readiness",
                reason: `Release-readiness gate: ${briefOpen} tracked CURSOR_BRIEF item(s) still open. Pitch must reflect the built product (not aspirational scope) — close the brief before re-pitching.`,
            };
        }
        const packet = await countOpenWorkPacketItems(repoPath);
        /**
         * `WORK_PACKET.json` is helpful for convergence gating, but it may be missing in repos that
         * haven't yet persisted a packet snapshot (or when automation regenerates packets via markdown).
         * Do not hard-skip investor_panel solely because the packet JSON isn't present — we still want
         * pitch scoring once QA is clean and the tracked brief is complete.
         */
        if (packet.open > 0) {
            return {
                skip: true,
                cause: "release_readiness",
                reason: `Release-readiness gate: ${packet.open} open work-packet item(s). Pitch must reflect the built product — close the packet before re-pitching.`,
            };
        }
    }
    return { skip: false };
}
function buildInvestorRefinementContext(panel, round) {
    const p = InvestorPanelRunnerShape.safeParse(panel);
    const directives = p.success && p.data.combinedRefinementDirectives.length > 0
        ? p.data.combinedRefinementDirectives
        : ["Tighten product scope and monetization using investor_panel feedback."];
    const investorSummaries = p.success
        ? p.data.investors.map((i) => `${i.displayName} (${i.grade}): ${i.response}`).join("\n")
        : "";
    return { round, directives, investorSummaries };
}
/**
 * Execute a pipeline: create run dir, run stages in order, persist artifacts and run.json.
 */
export async function runPipeline(opts) {
    const { repoPath, pipelineName } = opts;
    const foundryRoot = opts.foundryRoot ?? process.cwd();
    const log = opts.quiet ? quietPipelineLogger() : opts.logger ?? defaultLogger();
    const config = await loadFoundryConfig(repoPath);
    const pipelineDoc = await loadPipelineYaml(foundryRoot, pipelineName);
    const stageNames = opts.stagesOverride?.length ? opts.stagesOverride : pipelineDoc.stages;
    const registry = getStageRegistry();
    const unknown = stageNames.filter((s) => registry[s] === undefined);
    if (unknown.length) {
        throw new Error(`Unknown stages in pipeline: ${unknown.join(", ")}`);
    }
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = join(repoPath, ".foundry", "out", runId);
    await mkdir(outDir, { recursive: true });
    const manifest = {
        runId,
        repoPath,
        pipeline: pipelineName,
        status: "running",
        startedAt: new Date().toISOString(),
        stages: stageNames.map((name) => ({
            stage: name,
            status: "pending",
            startedAt: new Date().toISOString(),
        })),
    };
    await writeRunManifest(outDir, manifest);
    const priorOutputs = {};
    const baseCtx = {
        repoPath,
        runId,
        outDir,
        config,
        logger: log,
    };
    const stageIndex = (name) => stageNames.indexOf(name);
    const ctx = {
        ...baseCtx,
        stageIndex,
        readArtifact: async (relativePath) => {
            try {
                return await readFile(join(outDir, relativePath), "utf8");
            }
            catch {
                return undefined;
            }
        },
        writeArtifact: async (relativePath, data) => {
            const full = join(outDir, relativePath);
            try {
                await mkdir(dirname(full), { recursive: true });
                await writeFile(full, data, "utf8");
            }
            catch (err) {
                const e = err;
                if (e?.code === "ENOSPC") {
                    throw new Error(`ENOSPC: no space left on device while writing Foundry artifact (${full}). ` +
                        "Free disk space (or delete old `.foundry/out/*` runs) and re-run.");
                }
                throw err;
            }
        },
    };
    const inputCtx = { ...ctx, priorOutputs };
    const reuseStageNames = new Set(STAGES_ELIGIBLE_FOR_REUSE);
    let repoFingerprintPromise;
    async function runOneStage(i) {
        const stageName = stageNames[i];
        const stage = registry[stageName];
        const startedAt = new Date().toISOString();
        manifest.stages[i] = {
            stage: stageName,
            status: "running",
            startedAt,
        };
        await writeRunManifest(outDir, manifest);
        const t0 = performance.now();
        try {
            if (stageName === "investor_panel") {
                const investorGate = await shouldSkipInvestorPanelStage(repoPath, priorOutputs, config.project.foundry);
                if (investorGate.skip) {
                    const finishedAt = new Date().toISOString();
                    manifest.stages[i] = {
                        stage: stageName,
                        status: "skipped",
                        startedAt,
                        finishedAt,
                        durationMs: 0,
                        // Surface the gate reason in the manifest so callers (CLI, ship gate)
                        // can show "skipped because…" instead of a silent gap.
                        error: investorGate.reason,
                        skipCause: investorGate.cause,
                    };
                    await writeRunManifest(outDir, manifest);
                    // Persist a small README so `foundry status` / inspection make the gate visible.
                    try {
                        await writeStageMarkdown(ctx, "investor_panel", "README.md", [
                            "# Investor panel — SKIPPED",
                            "",
                            "The investor panel did not run this cycle because the product/repo state",
                            "does not yet support a faithful pitch.",
                            "",
                            `**Reason:** ${investorGate.reason ?? "(no reason recorded)"}`,
                            "",
                            "Run `foundry convergence status` and `foundry ledger list` to see what to",
                            "close before the next pitch. The next `foundry run` will re-evaluate and",
                            "run the panel automatically once the gate is clear.",
                            "",
                        ].join("\n"));
                    }
                    catch {
                        /* best-effort */
                    }
                    log("[runPipeline] skipping investor_panel", { reason: investorGate.reason });
                    return true;
                }
            }
            const rawInput = await getStageInput(stageName, inputCtx);
            const input = stage.inputSchema.parse(rawInput);
            let output;
            let durationMs = 0;
            let reused = false;
            if (isStageReuseEnabled() && reuseStageNames.has(stageName)) {
                repoFingerprintPromise ??= computeRepoFingerprint(repoPath);
                const repoFp = await repoFingerprintPromise;
                const inputFp = fingerprintStageInput(repoFp, input);
                const cached = await tryGetReusableStageOutput(repoPath, stageName, inputFp);
                if (cached !== undefined) {
                    output = stage.outputSchema.parse(cached);
                    reused = true;
                    durationMs = 0;
                }
            }
            if (!reused) {
                const rawOutput = await stage.run(ctx, input);
                output = stage.outputSchema.parse(rawOutput);
                durationMs = Math.round(performance.now() - t0);
                if (isStageReuseEnabled() && reuseStageNames.has(stageName)) {
                    repoFingerprintPromise ??= computeRepoFingerprint(repoPath);
                    const repoFp = await repoFingerprintPromise;
                    const inputFp = fingerprintStageInput(repoFp, input);
                    await rememberStageOutput(repoPath, stageName, inputFp, output);
                }
            }
            priorOutputs[stageName] = output;
            const finishedAt = new Date().toISOString();
            await writeStageJson(ctx, stageName, "output.json", output);
            if (reused) {
                const note = stageName === "builder"
                    ? [
                        "# Builder (reused)",
                        "",
                        "No work ran for this stage: composed inputs and git tree match a cached **ok/partial** builder run.",
                        "Set environment variable `FOUNDRY_DISABLE_STAGE_REUSE=true` to force codegen again.",
                    ].join("\n")
                    : [
                        "# Independent QA (reused)",
                        "",
                        "No work ran for this stage: inputs match a prior run that already recommended **ship**.",
                        "Set `FOUNDRY_DISABLE_STAGE_REUSE=true` to force lint/tests again.",
                    ].join("\n");
                await writeStageMarkdown(ctx, stageName, "README.md", note);
            }
            manifest.stages[i] = {
                stage: stageName,
                status: "passed",
                startedAt,
                finishedAt,
                durationMs,
                reused,
            };
            await writeRunManifest(outDir, manifest);
            return true;
        }
        catch (err) {
            const durationMs = Math.round(performance.now() - t0);
            const finishedAt = new Date().toISOString();
            const message = err instanceof Error ? err.message : String(err);
            manifest.stages[i] = {
                stage: stageName,
                status: "failed",
                startedAt,
                finishedAt,
                durationMs,
                error: message,
            };
            await writeRunManifest(outDir, manifest);
            for (let j = i + 1; j < stageNames.length; j++) {
                const sn = stageNames[j];
                manifest.stages[j] = {
                    stage: sn,
                    status: "skipped",
                    startedAt: new Date().toISOString(),
                    finishedAt: new Date().toISOString(),
                    durationMs: 0,
                };
            }
            return false;
        }
    }
    let pipelineFailedEarly = false;
    for (let i = 0; i < stageNames.length; i++) {
        const ok = await runOneStage(i);
        if (!ok) {
            pipelineFailedEarly = true;
            break;
        }
    }
    inputCtx.investorRefinementLoop = undefined;
    if (!pipelineFailedEarly && opts.allowInvestorRefinement && pipelineDoc.investor_refinement) {
        let investorRefinementDeferred = false;
        const ir = pipelineDoc.investor_refinement;
        const builderOut = BuilderRunnerShape.safeParse(priorOutputs["builder"]);
        // Decide whether to enter the refinement loop based on *why* investor_panel was skipped:
        //   - convergence: the contract can self-evolve via auto-resolve; refinement loop helps.
        //   - release_readiness: needs Cursor to close the brief; refinement can't help — short-circuit.
        //   - builder/qa: upstream failure; short-circuit.
        //   - not skipped: normal refinement path.
        const investorIdxForGuard = stageNames.indexOf("investor_panel");
        const panelStage = investorIdxForGuard >= 0 ? manifest.stages[investorIdxForGuard] : undefined;
        const panelSkipCause = panelStage?.status === "skipped" ? panelStage.skipCause : undefined;
        const panelGatedNonRetryable = panelSkipCause === "release_readiness" || panelSkipCause === "builder" || panelSkipCause === "qa";
        if (panelGatedNonRetryable) {
            log(`[runPipeline] skipping investor_refinement: investor_panel was gated (${panelSkipCause}). Refinement cannot move this — close the brief / fix QA / wait for builder.`);
        }
        else if (builderOut.success && (builderOut.data.status === "blocked" || builderOut.data.status === "failed")) {
            log("[runPipeline] skipping investor_refinement because builder is blocked/failed");
        }
        else {
            const deferToCursor = await shouldDeferInvestorRefinementToCursor(repoPath, priorOutputs);
            if (deferToCursor.defer) {
                investorRefinementDeferred = true;
                log("[runPipeline] skipping investor_refinement in this cycle", {
                    reason: deferToCursor.reason,
                });
            }
            else {
                const investorIdx = stageNames.indexOf("investor_panel");
                const restartIdx = stageNames.indexOf(ir.restart_from);
                if (investorIdx < 0) {
                    log("[runPipeline] investor_refinement in YAML but investor_panel missing from stages — ignoring refinement");
                }
                else if (restartIdx < 0) {
                    throw new Error(`investor_refinement.restart_from: unknown stage "${ir.restart_from}"`);
                }
                else if (restartIdx >= investorIdx) {
                    throw new Error(`investor_refinement.restart_from "${ir.restart_from}" must appear before investor_panel in the pipeline.`);
                }
                else {
                    let panelOut = priorOutputs["investor_panel"];
                    let refined = 0;
                    let lastSkipCause;
                    // Helper: did the panel actually run with a usable output this round?
                    const panelHasOutput = () => priorOutputs["investor_panel"] !== undefined;
                    while (refined < ir.max_rounds) {
                        // Stop conditions BEFORE starting another round:
                        //   - panel ran AND meets bar → done
                        //   - panel was skipped for a non-retryable reason → don't waste rounds
                        if (panelHasOutput() && investorPanelMeetsBar(panelOut))
                            break;
                        const currentSkipCause = manifest.stages[investorIdx]?.status === "skipped"
                            ? manifest.stages[investorIdx]?.skipCause
                            : undefined;
                        if (currentSkipCause === "release_readiness" ||
                            currentSkipCause === "builder" ||
                            currentSkipCause === "qa") {
                            lastSkipCause = currentSkipCause;
                            log(`[runPipeline] investor_refinement halting at round ${refined}: panel skipped (${currentSkipCause}); cannot recover via refinement.`);
                            break;
                        }
                        refined++;
                        inputCtx.investorRefinementLoop = buildInvestorRefinementContext(panelOut, refined);
                        for (let k = restartIdx; k <= investorIdx; k++) {
                            delete priorOutputs[stageNames[k]];
                        }
                        for (let k = restartIdx; k <= investorIdx; k++) {
                            const ok = await runOneStage(k);
                            if (!ok) {
                                pipelineFailedEarly = true;
                                break;
                            }
                        }
                        inputCtx.investorRefinementLoop = undefined;
                        if (pipelineFailedEarly)
                            break;
                        panelOut = priorOutputs["investor_panel"];
                        lastSkipCause =
                            manifest.stages[investorIdx]?.status === "skipped"
                                ? manifest.stages[investorIdx]?.skipCause
                                : undefined;
                        const deferAfterRound = await shouldDeferInvestorRefinementToCursor(repoPath, priorOutputs);
                        if (deferAfterRound.defer) {
                            investorRefinementDeferred = true;
                            log("[runPipeline] deferring remaining investor_refinement rounds to Cursor", {
                                round: refined,
                                reason: deferAfterRound.reason,
                            });
                            break;
                        }
                    }
                    // Failure cases after the loop:
                    //   - panel ran but didn't meet bar → existing behaviour (fail with grades)
                    //   - panel never ran (release-readiness gate) → don't fail the pipeline; the
                    //     skipped-with-reason on the manifest already tells the user what to do.
                    //     Failing the pipeline here would block `foundry run` even though everything
                    //     else (incl. release_agent gating) is doing the right thing.
                    const refinementGavenUpDueToReleaseReadiness = lastSkipCause === "release_readiness" || lastSkipCause === "builder" || lastSkipCause === "qa";
                    if (!pipelineFailedEarly &&
                        !investorRefinementDeferred &&
                        !refinementGavenUpDueToReleaseReadiness &&
                        panelHasOutput() &&
                        !investorPanelMeetsBar(panelOut)) {
                        const finishedAt = new Date().toISOString();
                        const last = manifest.stages[investorIdx];
                        manifest.stages[investorIdx] = {
                            stage: "investor_panel",
                            status: "failed",
                            startedAt: last?.startedAt ?? finishedAt,
                            finishedAt,
                            durationMs: last?.durationMs ?? 0,
                            error: `Investor panel: after ${ir.max_rounds} refinement round(s), grades remain below A-band (minimum A-). See investor_panel/README.md.`,
                        };
                        await writeRunManifest(outDir, manifest);
                        pipelineFailedEarly = true;
                    }
                }
            }
        }
    }
    const anyFailed = pipelineFailedEarly || manifest.stages.some((s) => s.status === "failed");
    manifest.status = anyFailed ? "failed" : "passed";
    manifest.finishedAt = new Date().toISOString();
    await writeRunManifest(outDir, manifest);
    return manifest;
}
