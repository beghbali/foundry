import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeStageMarkdown } from "@foundry/core/artifacts";
import { domainSummaryLine, getDomainPersonas, getDomainPrimaryUserAction, getDomainVocabulary, } from "@foundry/core/projectDomain";
import { StageInputCompositionSchema, } from "@foundry/core/stageInputs";
import { z } from "zod";
import { FirstPrinciplesOutputSchema } from "./first_principles.js";
import { FlywheelOutputSchema } from "./flywheel_designer.js";
/**
 * Local hint schemas (minimal duplicates of the relevant `product_definition` and
 * `investor_panel` output shapes) — kept here to avoid an import cycle:
 *   product_definition ↔ convergence_contract ↔ investor_panel
 * Only the fields convergence_contract actually consumes are validated.
 */
const ProductDefinitionHintSchema = z.object({
    oneLiner: z.string().optional(),
    targetUser: z.string().optional(),
    coreWorkflows: z
        .array(z.object({
        name: z.string(),
        steps: z.array(z.string()),
        successMetric: z.string(),
    }))
        .default([]),
    scope: z
        .object({
        mustShip: z.array(z.string()).default([]),
        shouldShip: z.array(z.string()).default([]),
        wontShip: z.array(z.string()).default([]),
    })
        .default({ mustShip: [], shouldShip: [], wontShip: [] }),
});
const InvestorPanelHintSchema = z.object({
    pitchBrief: z.string().optional(),
    refinementRound: z.number().int().min(0).default(0),
    combinedRefinementDirectives: z.array(z.string()).default([]),
    /**
     * When `true`, the panel mean grade is at or above the configured target
     * (e.g. mean >= B+ for autonomous_investor_convergence). Below-target panels
     * still seed contract objections from individual sub-target investors, but
     * the combined refinement directives become *advisory* and stop blocking
     * convergence. Without this conditional, `combinedRefinementDirectives` were
     * always seeded, so even an at-target panel kept the contract un-converged.
     */
    meetsInvestorTarget: z.boolean().optional(),
    investors: z
        .array(z.object({
        id: z.string(),
        displayName: z.string(),
        grade: z.string(),
        response: z.string(),
    }))
        .default([]),
});
/**
 * `convergence_contract` is Foundry's MVP convergence engine.
 *
 * It produces a single source of truth that downstream stages (product_definition,
 * monetization_architect, builder, investor_panel) consume to keep the app narrow,
 * track investor objections, and prevent feature sprawl. Features that are not in
 * the MVP loop are *parked* (not deleted) into `.foundry/product-ledger.json` with
 * an explicit re-entry condition.
 *
 * This is intentionally generic so every Foundry-built app gets the same convergence
 * pressure: define one loop, prove it, then unlock parked surface area.
 */
const PRODUCT_LEDGER_FILENAME = "product-ledger.json";
const MANUAL_RESOLUTIONS_FILENAME = "convergence-resolutions.json";
const MAX_MUST_SHIP = 8;
const MAX_LEDGER_RETENTION_PER_BUCKET = 64;
// ---------------- schemas ----------------
export const SingularLoopSchema = z.object({
    name: z.string(),
    trigger: z.string(),
    steps: z.array(z.string()).min(3).max(7),
    reward: z.string(),
    repeatPrompt: z.string(),
    northStarMetric: z.object({
        key: z.string(),
        definition: z.string(),
        target: z.string(),
    }),
});
export const MvpBoundarySchema = z.object({
    mustShip: z.array(z.string()).max(MAX_MUST_SHIP),
    mustNotShipYet: z.array(z.string()),
    maxCoreWorkflows: z.number().int().min(1).max(2),
    maxPrimaryUserPromises: z.number().int().min(1).max(2),
});
export const EvidenceGateSchema = z.object({
    id: z.string(),
    claim: z.string(),
    metric: z.string(),
    threshold: z.string(),
    unlocks: z.array(z.string()),
});
export const ObjectionStatusSchema = z.enum(["open", "reduced", "resolved", "regressed"]);
export const OpenObjectionSchema = z.object({
    id: z.string(),
    source: z.string(),
    objection: z.string(),
    status: ObjectionStatusSchema,
    firstSeenRound: z.number().int().min(0),
    lastSeenRound: z.number().int().min(0),
    requiredEvidence: z.string(),
    /**
     * Fingerprint of the panel run that surfaced this objection. Lets us age out
     * objections that originated from a panel two-or-more generations stale —
     * if the current panel doesn't repeat them and the prior panel didn't either,
     * the original objection is no longer evidence and we drop it.
     *
     * Empty string for objections introduced before fingerprinting was added.
     */
    introducedByPanelFingerprint: z.string().default(""),
});
export const LedgerStatusSchema = z.enum([
    "core_mvp",
    "evidence_needed",
    "later_expansion",
    "do_not_build_yet",
    "rejected",
]);
export const ProductLedgerItemSchema = z.object({
    id: z.string(),
    name: z.string(),
    source: z.enum([
        "convergence_contract",
        "investor_feedback",
        "user_feedback",
        "kill_list",
        "flywheel_phase2",
        "manual",
    ]),
    status: LedgerStatusSchema,
    reason: z.string(),
    reentryCondition: z.string().optional(),
    linkedLoop: z.string().optional(),
    linkedObjections: z.array(z.string()).default([]),
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
    refinementRound: z.number().int().min(0).default(0),
});
export const ProductLedgerFileSchema = z.object({
    version: z.literal(1),
    updatedAt: z.string(),
    items: z.array(ProductLedgerItemSchema),
});
export const ConvergenceContractOutputSchema = z.object({
    productThesis: z.string(),
    targetUser: z.string(),
    primaryJobToBeDone: z.string(),
    singularLoop: SingularLoopSchema,
    mvpBoundary: MvpBoundarySchema,
    evidenceGates: z.array(EvidenceGateSchema),
    openObjections: z.array(OpenObjectionSchema),
    convergenceWarnings: z.array(z.string()),
    isConverged: z.boolean(),
    ledgerSummary: z.object({
        ledgerPath: z.string(),
        totalItems: z.number().int().min(0),
        coreMvpCount: z.number().int().min(0),
        evidenceNeededCount: z.number().int().min(0),
        laterExpansionCount: z.number().int().min(0),
        doNotBuildYetCount: z.number().int().min(0),
        rejectedCount: z.number().int().min(0),
    }),
    refinementRound: z.number().int().min(0),
    /**
     * Fingerprint of the `investor_panel` output that was ingested when this
     * contract was built. Used to detect *new* panel evidence vs a stale panel
     * from a previous run — without this, the contract would re-ingest the same
     * objections as `open` every run and never converge.
     *
     * Empty string when no panel has been ingested.
     */
    panelFingerprint: z.string().default(""),
    /**
     * Per-objection evidence the contract used to auto-resolve from its own state
     * (parked feature, narrowed scope, instrumented metric). Surfaced for audit so
     * users can see *why* convergence flipped without a new panel run.
     */
    autoResolvedEvidence: z
        .array(z.object({
        objectionId: z.string(),
        evidence: z.string(),
    }))
        .default([]),
});
// ---------------- helpers ----------------
function slugify(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "item";
}
function nowIso() {
    return new Date().toISOString();
}
function ledgerPath(repoPath) {
    return join(repoPath, ".foundry", PRODUCT_LEDGER_FILENAME);
}
export function manualResolutionsPath(repoPath) {
    return join(repoPath, ".foundry", MANUAL_RESOLUTIONS_FILENAME);
}
/**
 * Manual evidence the user has supplied for objections that the contract
 * cannot prove from its own state (e.g. "we shipped the Yuka benchmark, here's
 * the doc"). Written by `foundry convergence resolve` and read by the contract
 * stage to mark the matching objection `resolved` with the supplied evidence.
 *
 * Lives at `.foundry/convergence-resolutions.json` — committed alongside the
 * project so resolutions persist across runs and machines.
 */
export const ManualResolutionsFileSchema = z.object({
    version: z.literal(1),
    updatedAt: z.string(),
    resolutions: z.array(z.object({
        objectionId: z.string(),
        evidence: z.string(),
        resolvedAt: z.string(),
        resolvedBy: z.string().optional(),
    })),
});
export async function readManualResolutions(repoPath) {
    try {
        const raw = await readFile(manualResolutionsPath(repoPath), "utf8");
        const parsed = ManualResolutionsFileSchema.safeParse(JSON.parse(raw));
        if (parsed.success)
            return parsed.data;
    }
    catch {
        /* missing or unreadable; treat as empty */
    }
    return { version: 1, updatedAt: nowIso(), resolutions: [] };
}
export async function writeManualResolutions(repoPath, file) {
    const dir = join(repoPath, ".foundry");
    await mkdir(dir, { recursive: true });
    await writeFile(manualResolutionsPath(repoPath), `${JSON.stringify(file, null, 2)}\n`, "utf8");
}
async function readProductLedger(repoPath) {
    try {
        const raw = await readFile(ledgerPath(repoPath), "utf8");
        const parsed = ProductLedgerFileSchema.safeParse(JSON.parse(raw));
        if (parsed.success)
            return parsed.data;
    }
    catch {
        /* fall through */
    }
    return { version: 1, updatedAt: "", items: [] };
}
async function writeProductLedger(repoPath, file) {
    await mkdir(join(repoPath, ".foundry"), { recursive: true });
    await writeFile(ledgerPath(repoPath), JSON.stringify(file, null, 2), "utf8");
}
function mergeLedger(prior, seeds, refinementRound) {
    const ts = nowIso();
    const byId = new Map();
    for (const item of prior.items)
        byId.set(item.id, item);
    for (const seed of seeds) {
        const id = slugify(seed.name);
        const existing = byId.get(id);
        if (existing) {
            byId.set(id, {
                ...existing,
                name: seed.name,
                source: seed.source,
                status: seed.status,
                reason: seed.reason,
                reentryCondition: seed.reentryCondition ?? existing.reentryCondition,
                linkedLoop: seed.linkedLoop ?? existing.linkedLoop,
                linkedObjections: Array.from(new Set([...(existing.linkedObjections ?? []), ...(seed.linkedObjections ?? [])])),
                lastSeenAt: ts,
                refinementRound,
            });
        }
        else {
            byId.set(id, {
                id,
                name: seed.name,
                source: seed.source,
                status: seed.status,
                reason: seed.reason,
                reentryCondition: seed.reentryCondition,
                linkedLoop: seed.linkedLoop,
                linkedObjections: seed.linkedObjections ?? [],
                firstSeenAt: ts,
                lastSeenAt: ts,
                refinementRound,
            });
        }
    }
    // Cap retention per bucket so the ledger doesn't grow unboundedly across runs.
    const buckets = {
        core_mvp: [],
        evidence_needed: [],
        later_expansion: [],
        do_not_build_yet: [],
        rejected: [],
    };
    for (const item of byId.values())
        buckets[item.status].push(item);
    for (const key of Object.keys(buckets)) {
        buckets[key].sort((a, b) => (b.lastSeenAt > a.lastSeenAt ? 1 : -1));
        buckets[key] = buckets[key].slice(0, MAX_LEDGER_RETENTION_PER_BUCKET);
    }
    const merged = [].concat(...Object.values(buckets));
    return { version: 1, updatedAt: ts, items: merged };
}
// ---------------- objection tracking ----------------
function objectionSeed(text) {
    return slugify(text
        .replace(/^[\W_]*[A-Z][a-z]+ refinement r\d+[\W_]*/i, "")
        .replace(/[^a-zA-Z0-9 ]+/g, " ")
        .trim()
        .split(/\s+/)
        .slice(0, 8)
        .join("-"));
}
/**
 * Per-investor objection grades that genuinely block convergence. Above the
 * `BLOCKING_GRADE_BAR`, the panel said the pitch is broadly fine and we don't
 * need to track them as `open` (they may still surface as panel directives
 * for *improvement* — which we capture separately).
 */
const BLOCKING_GRADES = new Set(["F", "D-", "D", "D+", "C-", "C", "C+", "B-", "B"]);
const POSITIVE_PHRASES = /^(yes|the best|interesting|promising|useful|great|strong|love|excited|exciting|solid|smart|nice|wonderful)/i;
/**
 * Build objection seeds the right way:
 *   - Each below-bar investor contributes ONE consolidated objection (their
 *     full critique) so we don't fragment one paragraph into 6 mini-objections
 *     that the auto-resolver can't reason about.
 *   - The panel's `combinedRefinementDirectives` (already deduped by the panel)
 *     each contribute one objection — these are the actionable items.
 *   - Above-bar investors are noted as supporters but don't produce blocking
 *     objections.
 *
 * This caps total objections at roughly `(blocking_investors + ~6 directives)`,
 * which keeps `foundry convergence status` readable and the auto-resolver
 * effective.
 */
function collectObjectionSeeds(panel, ir) {
    const seeds = [];
    if (panel) {
        // Below-target investors always seed objections (their feedback is the
        // resolution target). Above-target investors are noted as supporters.
        for (const inv of panel.investors) {
            if (!BLOCKING_GRADES.has(inv.grade))
                continue;
            const text = inv.response.trim();
            if (text.length < 12)
                continue;
            seeds.push({
                source: `${inv.id}:${inv.grade}:r${panel.refinementRound}`,
                text,
            });
        }
        // Combined refinement directives only block convergence when the panel
        // is *below target*. At target, they're advisory polish notes; treating
        // them as objections kept good panels from converging.
        if (panel.meetsInvestorTarget !== true) {
            for (const directive of panel.combinedRefinementDirectives) {
                const t = directive.trim();
                if (t.length < 12)
                    continue;
                if (POSITIVE_PHRASES.test(t) && !/\b(but|however|although|still|yet|need|must|should|require)\b/i.test(t)) {
                    continue;
                }
                seeds.push({ source: `directive:r${panel.refinementRound}`, text: t });
            }
        }
    }
    if (ir) {
        // The refinement loop's own directives stay blocking — they are the
        // explicit "fix this before re-grading" signal from the runner.
        for (const directive of ir.directives) {
            const t = directive.trim();
            if (t.length < 12)
                continue;
            seeds.push({ source: `directive:r${ir.round}`, text: t });
        }
    }
    return seeds;
}
/**
 * Fingerprint a panel by its grades + responses + directives. If this matches
 * the prior contract's `panelFingerprint`, the panel hasn't changed since we
 * last ingested it and we must NOT re-mark its objections as fresh `open`.
 *
 * Returns "" when there is no panel to ingest.
 */
function fingerprintPanel(panel) {
    if (!panel)
        return "";
    const stable = {
        refinementRound: panel.refinementRound,
        investors: panel.investors.map((i) => ({ id: i.id, grade: i.grade, response: i.response })),
        directives: [...panel.combinedRefinementDirectives].sort(),
    };
    return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
}
/** Hard cap on tracked objections — the panel grade is what matters; the list
 *  exists to drive resolution work, not to be an audit log. */
const MAX_TRACKED_OBJECTIONS = 16;
function reconcileObjections(prior, seeds, refinementRound, panelIsFresh, currentPanelFingerprint, priorPanelFingerprint) {
    const byId = new Map();
    for (const o of prior)
        byId.set(o.id, { ...o });
    // STALE PANEL: don't re-promote prior objections to `open` just because the
    // same panel output is still on disk. Carry priors forward unchanged. We
    // still allow auto-resolve below (called separately) to *clear* objections
    // when contract evidence justifies it.
    if (!panelIsFresh) {
        return rankObjections(Array.from(byId.values())).slice(0, MAX_TRACKED_OBJECTIONS);
    }
    const seenThisRound = new Set();
    for (const seed of seeds) {
        const id = objectionSeed(seed.text);
        if (!id)
            continue;
        seenThisRound.add(id);
        const existing = byId.get(id);
        if (existing) {
            existing.lastSeenRound = refinementRound;
            existing.source = seed.source;
            existing.objection = seed.text;
            // Re-stamp with the current panel fingerprint — this objection is still
            // being raised by the latest grader, so it's "live" again.
            existing.introducedByPanelFingerprint = currentPanelFingerprint;
            existing.status = existing.status === "resolved" ? "regressed" : "open";
        }
        else {
            byId.set(id, {
                id,
                source: seed.source,
                objection: seed.text,
                status: "open",
                firstSeenRound: refinementRound,
                lastSeenRound: refinementRound,
                requiredEvidence: requiredEvidenceFor(seed.text),
                introducedByPanelFingerprint: currentPanelFingerprint,
            });
        }
    }
    for (const [id, o] of byId.entries()) {
        if (seenThisRound.has(id))
            continue;
        // AGE-OUT: objection is no longer evidence from the latest panel grading.
        // Drop it when EITHER:
        //   - it was introduced by a panel two-or-more generations stale (not the
        //     current panel and not the immediately prior panel), OR
        //   - it has no fingerprint at all (legacy data from before fingerprinting
        //     was added) AND the current panel is fresh — it didn't reappear in
        //     this fresh ingest, so we have no evidence the latest grader still
        //     cares about it.
        const fp = o.introducedByPanelFingerprint ?? "";
        const isStaleGeneration = fp !== "" && fp !== currentPanelFingerprint && fp !== priorPanelFingerprint;
        const isLegacyNotRepeated = fp === "" && currentPanelFingerprint !== "";
        if (isStaleGeneration || isLegacyNotRepeated) {
            byId.delete(id);
            continue;
        }
        if (refinementRound > o.lastSeenRound) {
            // Objection no longer surfaced in current round → mark as reduced or resolved.
            o.status = o.status === "open" || o.status === "regressed" ? "reduced" : "resolved";
        }
    }
    return rankObjections(Array.from(byId.values())).slice(0, MAX_TRACKED_OBJECTIONS);
}
/** Surface unresolved objections first; within each bucket, most-recent first. */
function rankObjections(items) {
    const order = {
        regressed: 0,
        open: 1,
        reduced: 2,
        resolved: 3,
    };
    return [...items].sort((a, b) => {
        const so = order[a.status] - order[b.status];
        if (so !== 0)
            return so;
        return b.lastSeenRound - a.lastSeenRound;
    });
}
/**
 * Auto-resolve objections the contract can demonstrably address from its own
 * state. Conservative on purpose: anything requiring real-world evidence
 * (retention numbers, latency on device, side-by-side benchmark vs Yuka, etc.)
 * stays `open` until a fresh panel re-grades against shipped product.
 *
 * Returns the (mutated) objection list and an audit trail of what evidence
 * was used. This is what lets the loop converge between Cursor passes without
 * needing a panel re-run for every parked feature.
 */
/**
 * The contract is "tight" — meaning narrative/clarity objections that hinge on
 * scope discipline can be considered resolved by structural evidence alone —
 * when ALL of:
 *   - exactly one singular loop (always true by schema)
 *   - mustShip count is at or below the must-ship cap (`NARRATIVE_TIGHT_MUSTSHIP`)
 *   - parked list has real items (≥ 2)
 *   - the product thesis is concise (≤ NARRATIVE_TIGHT_THESIS_CHARS)
 *
 * Previously narrative tightness used a stricter threshold (5) than the
 * structural cap (`MAX_MUST_SHIP = 8`), so a contract with 6–8 must-ship
 * items was structurally valid but kept seeding narrative objections that
 * blocked `isConverged: true`. Aligning the two thresholds removes that gap.
 */
const NARRATIVE_TIGHT_MUSTSHIP = MAX_MUST_SHIP;
const NARRATIVE_TIGHT_THESIS_CHARS = 240;
function isContractNarrative_Tight(draft) {
    return (draft.mustShip.length > 0 &&
        draft.mustShip.length <= NARRATIVE_TIGHT_MUSTSHIP &&
        draft.mustNotShipYet.length >= 2 &&
        draft.productThesis.length <= NARRATIVE_TIGHT_THESIS_CHARS);
}
function autoResolveObjections(objections, draft, config, monetization) {
    const evidence = [];
    const mustShipLower = draft.mustShip.map((s) => s.toLowerCase()).join(" \n ");
    const parkedLower = draft.mustNotShipYet.map((s) => s.toLowerCase()).join(" \n ");
    const metrics = config.metrics?.metrics ?? [];
    const monAny = monetization;
    const monGates = Array.isArray(monAny?.gates) ? monAny.gates : [];
    const monPricing = monAny?.pricing ?? {};
    const monAnalytics = Array.isArray(monAny?.analyticsEvents)
        ? monAny.analyticsEvents
        : [];
    const tight = isContractNarrative_Tight(draft);
    for (const o of objections) {
        if (o.status === "resolved" || o.status === "reduced")
            continue;
        const text = o.objection.toLowerCase();
        // ---- 1. Pure narrative / clarity / discipline objections ------------
        // These are resolved by the contract being tight: one loop, bounded
        // mustShip, real parking, concise thesis. They DO NOT require shipped
        // product evidence — they're statements about pitch quality and scope
        // discipline, both of which the contract IS the evidence for.
        const narrativePatterns = [
            /\bnarrow\b/,
            /\bwedge\b/,
            /\bfocus\b/,
            /\bsimpl(e|y|ify|icity)\b/,
            /\bclutter(ed)?\b/,
            /\btoo broad\b/,
            /\bhero (loop|experience|moment)\b/,
            /\bone (loop|workflow|magical moment|elegant|thing)\b/,
            /\bsay one thing\b/,
            /\bstrip (this|to|down)\b/,
            /\bcut every feature\b/,
            /\breduce (it|complexity|to)\b/,
            /\bdoing too many things\b/,
            /\bdilutes? (signal|execution|focus)\b/,
            /\bbundle of (distractions|features)\b/,
            /\bstory (is|sounds) (cluttered|like a bundle)\b/,
            /\b(cannot|can'?t) (instantly )?tell what the product is\b/,
            /\bnot a wedge\b/,
            /\bremoves? complexity\b/,
        ];
        if (narrativePatterns.some((re) => re.test(text))) {
            if (tight) {
                o.status = "resolved";
                evidence.push({
                    objectionId: o.id,
                    evidence: `Contract is tight: 1 loop, ${draft.mustShip.length} must-ship (≤${NARRATIVE_TIGHT_MUSTSHIP}), ${draft.mustNotShipYet.length} parked, thesis ${draft.productThesis.length}ch (≤${NARRATIVE_TIGHT_THESIS_CHARS}).`,
                });
                continue;
            }
            // not tight yet → keep open and tell the user what's missing
            const reasons = [];
            if (draft.mustShip.length > NARRATIVE_TIGHT_MUSTSHIP)
                reasons.push(`mustShip=${draft.mustShip.length}>${NARRATIVE_TIGHT_MUSTSHIP}`);
            if (draft.mustNotShipYet.length < 2)
                reasons.push(`parked=${draft.mustNotShipYet.length}<2`);
            if (draft.productThesis.length > NARRATIVE_TIGHT_THESIS_CHARS)
                reasons.push(`thesis=${draft.productThesis.length}ch>${NARRATIVE_TIGHT_THESIS_CHARS}`);
            o.requiredEvidence = `Contract not yet tight (${reasons.join(", ")}). Narrow must-ship, park more, or shorten thesis.`;
            continue;
        }
        // ---- 2. Delay/park/strip a *named* surface ---------------------------
        const nameMap = [
            { re: /\b(creator|influencer)\b/, needles: ["creator", "influencer"], label: "creator/influencer surface" },
            { re: /\b(instacart|shopping|commerce|checkout)\b/, needles: ["instacart", "commerce", "checkout"], label: "commerce/Instacart surface" },
            { re: /\b(retail media|ad network|advertising network)\b/, needles: ["retail media", "ad network"], label: "retail-media surface" },
            { re: /\b(menu|restaurant)\b/, needles: ["menu", "restaurant"], label: "menu-scanning surface" },
            { re: /\b(social feed|community)\b/, needles: ["social", "community"], label: "social/community surface" },
            { re: /\b(ar|augmented reality)\b/, needles: ["ar ", "augmented"], label: "AR surface" },
            { re: /\b(marketplace)\b/, needles: ["marketplace"], label: "marketplace surface" },
        ];
        let parkedHandled = false;
        for (const m of nameMap) {
            if (m.re.test(text) && /\b(delay|park|defer|strip|remove|cut|do not|don'?t|hold off)\b/.test(text)) {
                const isParked = m.needles.some((n) => parkedLower.includes(n));
                const isLeaking = m.needles.some((n) => mustShipLower.includes(n));
                if (isParked && !isLeaking) {
                    o.status = "resolved";
                    evidence.push({
                        objectionId: o.id,
                        evidence: `${m.label} is parked in product-ledger and absent from must-ship.`,
                    });
                    parkedHandled = true;
                    break;
                }
            }
        }
        if (parkedHandled)
            continue;
        // ---- 3. Monetization gated after delight -----------------------------
        if (/\b(monetiz|paywall|gate after|trial|charging before|free tier|earn trust|gate after delight|subscription first|charge after value)\b/.test(text)) {
            const trialDays = typeof monPricing.trialDays === "number" ? monPricing.trialDays : 0;
            if (monGates.length > 0 && (trialDays > 0 || monAnalytics.length > 0)) {
                o.status = "resolved";
                evidence.push({
                    objectionId: o.id,
                    evidence: `Monetization gated post-value: ${monGates.length} gate(s), trial=${trialDays}d, ${monAnalytics.length} analytics event(s).`,
                });
                continue;
            }
        }
        // ---- 4. Instrumentation / metrics ------------------------------------
        if (/\b(metric|measur|instrument|d1|d7|retention|paywall conversion|acceptance|cohort)\b/.test(text)) {
            const nsKeyRoot = draft.singularLoop.northStarMetric.key.toLowerCase().split("_")[0] ?? "";
            const hasNs = nsKeyRoot.length > 0 && metrics.some((m) => m.key.toLowerCase().includes(nsKeyRoot));
            const hasRetention = metrics.some((m) => /retention|d\d|repeat/.test(m.key.toLowerCase()));
            if (hasNs || hasRetention || metrics.length >= 3) {
                o.status = "resolved";
                evidence.push({
                    objectionId: o.id,
                    evidence: `${metrics.length} metric(s) declared in metrics.yaml; singular-loop north-star is \`${draft.singularLoop.northStarMetric.key}\`.`,
                });
                continue;
            }
        }
        // ---- 5. UX / "obsess over interface" execution objections ------------
        // These genuinely require shipped UX evidence — leave open with a clear
        // hint, but make the required evidence actionable instead of generic.
        if (/\b(obsess over (interface|design|explanation|emotional)|magical moment|first experience feels|emotionally reassuring|deeply human|beautiful)\b/.test(text)) {
            o.requiredEvidence =
                "Ship a Maestro-recorded first-session demo (≤30s) showing the singular loop completing with a clear, calm explanation screen, then mark resolved with `foundry convergence resolve --evidence <screencast>`.";
            continue;
        }
        // ---- 6. Otherwise: leave open. Real-world evidence required ----------
    }
    return { objections, evidence };
}
function requiredEvidenceFor(text) {
    const lower = text.toLowerCase();
    if (/\b(retention|d1|d7|repeat)\b/.test(lower)) {
        return "Cohort retention numbers (D1/D7) on the singular MVP loop.";
    }
    if (/\b(speed|latency|under \d+\s?(s|sec|second|ms))\b/.test(lower)) {
        return "Measured loop latency on target hardware vs benchmark.";
    }
    if (/\b(yuka|competitor|benchmark)\b/.test(lower)) {
        return "Side-by-side benchmark proof against named competitor.";
    }
    if (/\b(monetiz|paywall|conversion|trial|subscription)\b/.test(lower)) {
        return "Paywall conversion and post-value gating evidence.";
    }
    if (/\b(narrow|wedge|focus|simpl|clutter|too broad)\b/.test(lower)) {
        return "Pitch + must-ship list reduced to one loop with parked features in product-ledger.";
    }
    if (/\b(metric|measur|instrument)\b/.test(lower)) {
        return "Instrumented analytics events with target thresholds in metrics.yaml.";
    }
    return "Show concrete evidence (metric, demo, or proof) in the next refinement round.";
}
function safeParseInputs(input) {
    return {
        flywheel: FlywheelOutputSchema.safeParse(input.flywheel),
        firstPrinciples: FirstPrinciplesOutputSchema.safeParse(input.firstPrinciples),
        productDefinition: ProductDefinitionHintSchema.safeParse(input.productDefinition),
        investorPanel: InvestorPanelHintSchema.safeParse(input.investorPanel),
    };
}
/**
 * Produce a numeric, verifiable north-star target. We prefer (in order):
 *   1. A latency target embedded in panel directives ("under 2s", "under 200ms")
 *   2. A retention/conversion target embedded in panel directives ("D7 ≥ 25%")
 *   3. A retention metric declared in `metrics.yaml` (use its target string)
 *   4. A sane category default keyed off the metric name (retention/completion/latency)
 *
 * "Hit primary loop metric within Phase-1 cohort." is never an acceptable target —
 * investors and the auto-resolver both need a number.
 */
function deriveNorthStarTarget(metricKey, directives, metricsYaml, fallback) {
    const dl = directives.toLowerCase();
    const lat = dl.match(/under\s+(\d+(?:\.\d+)?)\s?(s|sec|seconds?|ms|milliseconds?)/);
    if (lat) {
        const unit = lat[2].startsWith("m") && lat[2] !== "m" ? "ms" : "s";
        return `≤ ${lat[1]}${unit} loop latency on target hardware`;
    }
    const ret = dl.match(/d(\d+)\s*(?:retention)?\s*(?:>=|≥|of|at least)?\s*(\d+)\s*%/);
    if (ret)
        return `D${ret[1]} retention ≥ ${ret[2]}%`;
    const conv = dl.match(/(?:conversion|paywall)[^\d]{0,20}(\d+)\s*%/);
    if (conv)
        return `Paywall conversion ≥ ${conv[1]}%`;
    const yamlMatch = metricsYaml?.find((m) => m.key.toLowerCase() === metricKey.toLowerCase());
    if (yamlMatch && Number.isFinite(yamlMatch.target)) {
        // Render percentages naturally when target ≤ 1 (parser stored 50% as 0.5).
        const t = yamlMatch.target;
        if (t > 0 && t <= 1)
            return `${(t * 100).toFixed(t < 0.1 ? 1 : 0)}%`;
        return String(t);
    }
    const k = metricKey.toLowerCase();
    if (/retention|d\d|repeat/.test(k))
        return "D7 retention ≥ 25% on the singular MVP loop";
    if (/latency|speed|response|seconds|ms/.test(k))
        return "≤ 2s loop latency on target hardware";
    if (/conversion|paywall|trial/.test(k))
        return "Paywall conversion ≥ 4% post-trial";
    if (/acceptance|recommend/.test(k))
        return "≥ 50% recommendation acceptance after first 3 loops";
    if (/completion|success|outcome/.test(k))
        return "≥ 60% of sessions complete the primary loop end-to-end";
    if (/referral/.test(k))
        return "≥ 1 referral per 10 retained users (Phase-1 cohort)";
    return fallback ?? "≥ 60% of Phase-1 cohort hits the metric weekly";
}
function buildSingularLoop(flywheel, productDefinition, northStar, ir, metricsYaml) {
    const primary = flywheel?.flywheel[0];
    const fallbackWf = productDefinition?.coreWorkflows[0];
    const ns = northStar.replace(/\.$/, "");
    const directiveText = ir?.directives.join(" ") ?? "";
    if (primary) {
        return {
            name: primary.loopName,
            trigger: primary.trigger,
            steps: primary.steps.slice(0, 7),
            reward: primary.valueCreated,
            repeatPrompt: `Return to the loop the next time the trigger fires (${primary.trigger.toLowerCase()}).`,
            northStarMetric: {
                key: primary.metric.key,
                definition: primary.metric.definition,
                target: deriveNorthStarTarget(primary.metric.key, directiveText, metricsYaml),
            },
        };
    }
    if (fallbackWf) {
        return {
            name: fallbackWf.name,
            trigger: "User intent matches the primary job-to-be-done",
            steps: fallbackWf.steps.slice(0, 7),
            reward: `Visible outcome for ${ns.toLowerCase()}.`,
            repeatPrompt: "Return next time the same job recurs.",
            northStarMetric: {
                key: "primary_loop_completion_rate",
                definition: fallbackWf.successMetric,
                target: deriveNorthStarTarget("primary_loop_completion_rate", directiveText, metricsYaml),
            },
        };
    }
    return {
        name: "Primary value loop",
        trigger: "User arrives with the core job-to-be-done",
        steps: [
            "User triggers the primary action.",
            "Product responds with a fast, explainable result.",
            "User accepts, overrides, or saves the result.",
            "Loop is ready to repeat at the next trigger.",
        ],
        reward: `Confidence and faster ${ns.toLowerCase()}.`,
        repeatPrompt: "Return on the next decision.",
        northStarMetric: {
            key: "primary_loop_completion_rate",
            definition: "Percent of sessions that complete the primary loop end-to-end.",
            target: deriveNorthStarTarget("primary_loop_completion_rate", directiveText, metricsYaml),
        },
    };
}
function pickMustShip(productDefinition, flywheel, loopName) {
    const candidates = [];
    if (productDefinition)
        candidates.push(...productDefinition.scope.mustShip);
    if (flywheel?.focusRecommendation.phase1)
        candidates.push(...flywheel.focusRecommendation.phase1);
    const seen = new Set();
    const deduped = [];
    for (const c of candidates) {
        const key = c.toLowerCase().trim();
        if (seen.has(key))
            continue;
        seen.add(key);
        deduped.push(c);
    }
    // Items that mention the singular loop name come first; everything else is spillover.
    const loopSlug = slugify(loopName);
    const ranked = deduped
        .map((c) => ({ c, score: slugify(c).includes(loopSlug.split("-")[0] ?? "") ? 1 : 0 }))
        .sort((a, b) => b.score - a.score)
        .map((x) => x.c);
    return {
        mustShip: ranked.slice(0, MAX_MUST_SHIP),
        spilled: ranked.slice(MAX_MUST_SHIP),
    };
}
const PARK_KEYWORDS = [
    /creator|influencer/i,
    /retail media|ad network|ads later/i,
    /commerce|instacart|shopify|checkout integration/i,
    /menu scanning|restaurant menu/i,
    /social feed|community/i,
    /marketplace/i,
    /ar|augmented reality/i,
    /web client|desktop client/i,
    /gamification badges/i,
];
function looksParkable(text) {
    return PARK_KEYWORDS.some((re) => re.test(text));
}
function buildDraft(args) {
    const { input, refinementRound } = args;
    const parsed = safeParseInputs(input);
    const flywheel = parsed.flywheel.success ? parsed.flywheel.data : undefined;
    const productDefinition = parsed.productDefinition.success ? parsed.productDefinition.data : undefined;
    const firstPrinciples = parsed.firstPrinciples.success ? parsed.firstPrinciples.data : undefined;
    const ir = input.investorRefinement;
    const projectName = input.config.project.project_name;
    const northStar = input.config.project.north_star;
    // Domain block lets the contract reuse the configured primary moment / metric
    // / vocabulary so productThesis isn't a generic "delivers <northStar>" line.
    const domainPrimary = getDomainPrimaryUserAction(input.config.project);
    const domainSummary = domainSummaryLine(input.config.project);
    const domainPersonas = getDomainPersonas(input.config.project);
    const domainVocab = getDomainVocabulary(input.config.project);
    const singularLoop = buildSingularLoop(flywheel, productDefinition, northStar, ir, input.config.metrics?.metrics);
    const { mustShip, spilled } = pickMustShip(productDefinition, flywheel, singularLoop.name);
    const productThesis = productDefinition?.oneLiner?.trim() ??
        (domainSummary
            ? `${projectName} — ${domainSummary}`
            : `${projectName} delivers ${northStar.replace(/\.$/, "")} through one tight loop the user repeats with confidence.`);
    const targetUser = productDefinition?.targetUser?.trim() ??
        (domainPersonas.length > 0
            ? `Built for ${domainPersonas.join("; ")}.`
            : `Users who need ${northStar.toLowerCase().replace(/\.$/, "")} but are blocked by broad, slow, or untrusted alternatives.`);
    const primaryJobToBeDone = productDefinition?.coreWorkflows[0]?.successMetric?.split("—")[0]?.trim() ??
        (domainPrimary
            ? domainPrimary
            : `Complete one trustworthy ${singularLoop.name.toLowerCase()} ${domainVocab.noun}.`);
    // mustNotShipYet: kill_list items + parkable spillover from must-ship + Phase-2 focus
    const parkedNamesSet = new Set();
    const parkedSeeds = [];
    const addParked = (name, source, reason, reentry) => {
        const slug = slugify(name);
        if (parkedNamesSet.has(slug))
            return;
        parkedNamesSet.add(slug);
        parkedSeeds.push({
            name,
            source,
            status: "do_not_build_yet",
            reason,
            reentryCondition: reentry,
            linkedLoop: singularLoop.name,
        });
    };
    for (const k of firstPrinciples?.kill_list ?? []) {
        addParked(k, "kill_list", "Listed in first_principles kill_list — must not enter Phase-1 scope.", "Revisit only after the singular MVP loop reaches its evidence gate.");
    }
    for (const item of spilled) {
        addParked(item, "convergence_contract", "Exceeded MVP must-ship cap (max " + MAX_MUST_SHIP + ") — parked to keep one loop.", "Revisit after retention proof on the singular loop.");
    }
    for (const item of productDefinition?.scope.shouldShip ?? []) {
        if (looksParkable(item)) {
            addParked(item, "convergence_contract", "Should-ship item matches a known distraction pattern — parked.", "Revisit after retention + monetization proof on the singular loop.");
        }
    }
    for (const item of productDefinition?.scope.wontShip ?? []) {
        addParked(item, "convergence_contract", "Already excluded by product_definition.wontShip — preserved in ledger.", "Re-evaluate only with explicit evidence from the singular loop.");
    }
    for (const item of flywheel?.focusRecommendation.phase2 ?? []) {
        if (parkedNamesSet.has(slugify(item)))
            continue;
        parkedSeeds.push({
            name: item,
            source: "flywheel_phase2",
            status: "later_expansion",
            reason: "Flagged as Phase-2 by flywheel_designer.",
            reentryCondition: "Promote when the singular loop hits its evidence gate.",
            linkedLoop: singularLoop.name,
        });
        parkedNamesSet.add(slugify(item));
    }
    // Investor directives that mention parking/delaying specific surfaces are honored.
    for (const d of ir?.directives ?? []) {
        if (looksParkable(d) || /delay|park|defer|strip|remove|cut/i.test(d)) {
            addParked(d, "investor_feedback", `Investor refinement r${ir?.round ?? 0} requested narrowing.`, "Revisit only when the singular loop is proven and an investor objection unblocks it.");
        }
    }
    const mustNotShipYet = parkedSeeds
        .filter((s) => s.status === "do_not_build_yet")
        .map((s) => s.name)
        .slice(0, 32);
    const evidenceGates = [
        {
            id: "EG-LOOP-RETENTION",
            claim: "The singular loop produces repeat usage.",
            metric: singularLoop.northStarMetric.key,
            threshold: "D7 retention ≥ 25% of activated users on the singular loop.",
            unlocks: parkedSeeds
                .filter((s) => s.status === "later_expansion")
                .slice(0, 6)
                .map((s) => s.name),
        },
        {
            id: "EG-LOOP-LATENCY",
            claim: "The singular loop is fast enough to build trust at the decision moment.",
            metric: `${singularLoop.northStarMetric.key}_latency_ms`,
            threshold: singularLoop.northStarMetric.target,
            unlocks: ["Premium personalization", "Creator/expansion surfaces (when also retained)"],
        },
        {
            id: "EG-LOOP-RECOMMEND-ACCEPTANCE",
            claim: "Users trust the recommendation enough to accept or save it.",
            metric: "personalized_recommendation_acceptance_rate",
            threshold: "≥ 50% acceptance after first 3 loops.",
            unlocks: ["Adjacent surfaces (commerce, menus, etc.) become safe to consider."],
        },
    ];
    return {
        productThesis,
        targetUser,
        primaryJobToBeDone,
        singularLoop,
        mustShip,
        mustNotShipYet,
        parkedSeeds,
        evidenceGates,
    };
}
// ---------------- gates ----------------
function computeWarnings(draft, pdInput, panel, objections) {
    const warnings = [];
    if (pdInput && pdInput.coreWorkflows.length > draft.singularLoop.steps.length && pdInput.coreWorkflows.length > 1) {
        warnings.push(`product_definition declares ${pdInput.coreWorkflows.length} core workflows. MVP convergence requires 1.`);
    }
    if (draft.mustShip.length > MAX_MUST_SHIP) {
        warnings.push(`mustShip exceeds the convergence cap (${MAX_MUST_SHIP}).`);
    }
    if (draft.mustShip.length === 0) {
        warnings.push("mustShip is empty — convergence_contract has no Phase-1 scope to defend.");
    }
    // Pitch hygiene: warn if the latest pitch brief mentions parked features by name.
    if (panel?.pitchBrief && draft.mustNotShipYet.length > 0) {
        const lower = panel.pitchBrief.toLowerCase();
        for (const parked of draft.mustNotShipYet) {
            const token = parked.toLowerCase().split(/\s+/).slice(0, 2).join(" ");
            if (token.length > 4 && lower.includes(token)) {
                warnings.push(`Pitch brief mentions parked feature "${token}" — strip from elevator.`);
            }
        }
    }
    // Same objection persisting >= 2 rounds without resolution
    for (const o of objections) {
        if (o.status === "open" && o.lastSeenRound - o.firstSeenRound >= 1) {
            warnings.push(`Investor objection "${o.id}" has persisted ${o.lastSeenRound - o.firstSeenRound + 1} rounds.`);
        }
        if (o.status === "regressed") {
            warnings.push(`Investor objection "${o.id}" regressed after being resolved.`);
        }
    }
    // Park items must each have a re-entry condition (already enforced by mergeLedger via seeds)
    return Array.from(new Set(warnings)).slice(0, 16);
}
// ---------------- markdown ----------------
function buildReadme(output, projectName) {
    const lines = [
        `# ${projectName} — Convergence Contract`,
        "",
        `> ${output.productThesis}`,
        "",
        `**Target user:** ${output.targetUser}`,
        "",
        `**Primary job-to-be-done:** ${output.primaryJobToBeDone}`,
        "",
        `**Refinement round:** ${output.refinementRound}    **Converged:** ${output.isConverged ? "yes" : "no"}`,
        "",
        "## Singular MVP Loop",
        "",
        `**${output.singularLoop.name}** — trigger: _${output.singularLoop.trigger}_`,
        "",
        ...output.singularLoop.steps.map((s, i) => `${i + 1}. ${s}`),
        "",
        `**Reward:** ${output.singularLoop.reward}`,
        "",
        `**Repeat prompt:** ${output.singularLoop.repeatPrompt}`,
        "",
        `**North-star metric:** \`${output.singularLoop.northStarMetric.key}\` — ${output.singularLoop.northStarMetric.definition} (target: ${output.singularLoop.northStarMetric.target})`,
        "",
        "## MVP Boundary",
        "",
        "### Must ship (Phase 1)",
        "",
        ...output.mvpBoundary.mustShip.map((s) => `- ${s}`),
        "",
        "### Must NOT ship yet (parked in product-ledger)",
        "",
        ...output.mvpBoundary.mustNotShipYet.slice(0, 16).map((s) => `- ${s}`),
        output.mvpBoundary.mustNotShipYet.length > 16
            ? `- … +${output.mvpBoundary.mustNotShipYet.length - 16} more in \`.foundry/product-ledger.json\``
            : "",
        "",
        "## Evidence Gates",
        "",
        ...output.evidenceGates.flatMap((g) => [
            `- **${g.id}:** ${g.claim}`,
            `  - Metric: \`${g.metric}\``,
            `  - Threshold: ${g.threshold}`,
            `  - Unlocks: ${g.unlocks.length ? g.unlocks.join("; ") : "_(none yet)_"}`,
        ]),
        "",
        "## Open Investor Objections",
        "",
        output.openObjections.length === 0
            ? "_None tracked yet._"
            : output.openObjections
                .map((o) => `- **[${o.status}]** ${o.objection}\n  - First seen: r${o.firstSeenRound}, last seen: r${o.lastSeenRound}\n  - Required evidence: ${o.requiredEvidence}`)
                .join("\n"),
        "",
        "## Auto-Resolved Evidence",
        "",
        output.autoResolvedEvidence.length === 0
            ? "_No objections were auto-resolved this round (waiting on shipped product / fresh panel re-grade)._"
            : output.autoResolvedEvidence
                .map((e) => `- **${e.objectionId}** — ${e.evidence}`)
                .join("\n"),
        "",
        `_Panel fingerprint: \`${output.panelFingerprint || "(none)"}\`. A new fingerprint = the panel re-graded on this run; same fingerprint = the contract evolved without new panel evidence._`,
        "",
        "## Convergence Warnings",
        "",
        output.convergenceWarnings.length === 0
            ? "_No warnings — contract is internally consistent._"
            : output.convergenceWarnings.map((w) => `- ${w}`).join("\n"),
        "",
        "## Product Ledger Summary",
        "",
        `- core_mvp: ${output.ledgerSummary.coreMvpCount}`,
        `- evidence_needed: ${output.ledgerSummary.evidenceNeededCount}`,
        `- later_expansion: ${output.ledgerSummary.laterExpansionCount}`,
        `- do_not_build_yet: ${output.ledgerSummary.doNotBuildYetCount}`,
        `- rejected: ${output.ledgerSummary.rejectedCount}`,
        "",
        `Persistent ledger lives at \`${output.ledgerSummary.ledgerPath}\` and survives across runs. Use it to revisit parked features when an evidence gate is met.`,
        "",
    ].filter(Boolean);
    return lines.join("\n");
}
function readPriorObjections(input) {
    const prior = ConvergenceContractOutputSchema.safeParse(input.convergenceContract);
    if (!prior.success)
        return [];
    return prior.data.openObjections;
}
function readPriorPanelFingerprint(input) {
    const prior = ConvergenceContractOutputSchema.safeParse(input.convergenceContract);
    if (!prior.success)
        return "";
    return prior.data.panelFingerprint ?? "";
}
// ---------------- stage ----------------
export const convergenceContractStage = {
    name: "convergence_contract",
    description: "Foundry's MVP convergence engine: distill one product thesis, one loop, a parked product-ledger, evidence gates, and tracked investor objections. Downstream stages consume this contract.",
    inputSchema: StageInputCompositionSchema,
    outputSchema: ConvergenceContractOutputSchema,
    async run(ctx, input) {
        const refinementRound = input.investorRefinement?.round ?? 0;
        const priorLedger = await readProductLedger(ctx.repoPath);
        const priorObjections = readPriorObjections(input);
        const priorFingerprint = readPriorPanelFingerprint(input);
        const draft = buildDraft({ input, refinementRound, priorObjections, priorLedger });
        const panel = InvestorPanelHintSchema.safeParse(input.investorPanel);
        const panelData = panel.success ? panel.data : undefined;
        const panelFingerprint = fingerprintPanel(panelData);
        // A panel is "fresh" only when its fingerprint differs from what the prior
        // contract ingested. The investor_refinement loop *re-uses* the same panel
        // each round (the panel is gated; no new grades), so refinement alone must
        // NOT count as fresh — otherwise we'd re-promote auto-resolved objections
        // back to `open` every iteration and never converge.
        const panelIsFresh = panelFingerprint !== "" && panelFingerprint !== priorFingerprint;
        ctx.logger("[convergence_contract] narrowing", {
            project: input.config.project.project_name,
            refinementRound,
            hasPriorPanel: input.investorPanel !== undefined,
            panelFingerprint,
            panelIsFresh,
            priorObjectionCount: priorObjections.length,
        });
        const objectionSeeds = collectObjectionSeeds(panelData, input.investorRefinement);
        let reconciledObjections = reconcileObjections(priorObjections, objectionSeeds, refinementRound, panelIsFresh, panelFingerprint, priorFingerprint);
        // Auto-resolve objections whose evidence is already present in the contract
        // state (parked features, narrowed scope, instrumented metrics, gated
        // monetization). This is what lets the loop converge between Cursor passes.
        const autoResolve = autoResolveObjections(reconciledObjections, draft, input.config, input.monetizationConfig);
        reconciledObjections = autoResolve.objections;
        // Apply user-supplied manual resolutions for objections that need real-world
        // evidence the contract cannot prove (e.g. "we shipped the Yuka benchmark").
        // The user invoked `foundry convergence resolve <id> --evidence "..."`.
        const manualResolutions = await readManualResolutions(ctx.repoPath);
        const manualEvidence = [];
        if (manualResolutions.resolutions.length > 0) {
            const byId = new Map(manualResolutions.resolutions.map((r) => [r.objectionId, r]));
            for (const o of reconciledObjections) {
                const m = byId.get(o.id);
                if (m && o.status !== "resolved") {
                    o.status = "resolved";
                    manualEvidence.push({
                        objectionId: o.id,
                        evidence: `Manual: ${m.evidence}${m.resolvedBy ? ` (by ${m.resolvedBy})` : ""}`,
                    });
                }
            }
        }
        const allAutoResolveEvidence = [...autoResolve.evidence, ...manualEvidence];
        // Seed the ledger from contract derivation + objection-driven parking.
        const ledgerSeeds = [
            ...draft.parkedSeeds,
            ...draft.mustShip.map((name) => ({
                name,
                source: "convergence_contract",
                status: "core_mvp",
                reason: "Selected as Phase-1 must-ship by convergence_contract.",
                linkedLoop: draft.singularLoop.name,
            })),
        ];
        const mergedLedger = mergeLedger(priorLedger, ledgerSeeds, refinementRound);
        await writeProductLedger(ctx.repoPath, mergedLedger);
        const counts = mergedLedger.items.reduce((acc, item) => {
            acc[item.status]++;
            return acc;
        }, { core_mvp: 0, evidence_needed: 0, later_expansion: 0, do_not_build_yet: 0, rejected: 0 });
        const pdParsed = ProductDefinitionHintSchema.safeParse(input.productDefinition);
        const warnings = computeWarnings(draft, pdParsed.success ? pdParsed.data : undefined, panelData, reconciledObjections);
        // Convergence only requires:
        //   1. The MVP scope is structurally valid (1..MAX_MUST_SHIP must-ship items).
        //   2. No open or regressed objections remain.
        // Warnings (e.g. "thesis is verbose", advisory metric hints) are surfaced
        // separately but no longer block convergence — they're advisories the loop
        // can ship through. This keeps an at-target investor panel + tight
        // contract from being stuck on cosmetic polish.
        const isConverged = draft.mustShip.length > 0 &&
            draft.mustShip.length <= MAX_MUST_SHIP &&
            reconciledObjections.every((o) => o.status === "resolved" || o.status === "reduced");
        const output = {
            productThesis: draft.productThesis,
            targetUser: draft.targetUser,
            primaryJobToBeDone: draft.primaryJobToBeDone,
            singularLoop: draft.singularLoop,
            mvpBoundary: {
                mustShip: draft.mustShip,
                mustNotShipYet: draft.mustNotShipYet,
                maxCoreWorkflows: 1,
                maxPrimaryUserPromises: 1,
            },
            evidenceGates: draft.evidenceGates,
            openObjections: reconciledObjections,
            convergenceWarnings: warnings,
            isConverged,
            ledgerSummary: {
                ledgerPath: ledgerPath(ctx.repoPath),
                totalItems: mergedLedger.items.length,
                coreMvpCount: counts.core_mvp,
                evidenceNeededCount: counts.evidence_needed,
                laterExpansionCount: counts.later_expansion,
                doNotBuildYetCount: counts.do_not_build_yet,
                rejectedCount: counts.rejected,
            },
            refinementRound,
            panelFingerprint,
            autoResolvedEvidence: allAutoResolveEvidence,
        };
        const validated = ConvergenceContractOutputSchema.parse(output);
        await writeStageMarkdown(ctx, "convergence_contract", "README.md", buildReadme(validated, input.config.project.project_name));
        return validated;
    },
};
