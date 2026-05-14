import { z } from "zod";
import { FoundryConfigSchema } from "./config.js";
import { readLatestArtifact } from "./artifacts.js";
/** Injected by the pipeline runner during `investor_refinement` re-runs (round ≥ 1). */
export const InvestorRefinementContextSchema = z.object({
    round: z.number().int().positive(),
    directives: z.array(z.string()),
    investorSummaries: z.string(),
});
export const StageInputCompositionSchema = z.object({
    config: FoundryConfigSchema,
    /** Output of `repo_inventory` (see `@foundry/stages` / `RepoInventoryOutputSchema`). */
    repoInventory: z.unknown().optional(),
    currentStateAudit: z.unknown().optional(),
    baselineAppShell: z.unknown().optional(),
    marketGap: z.unknown().optional(),
    firstPrinciples: z.unknown().optional(),
    flywheel: z.unknown().optional(),
    /**
     * Latest available `convergence_contract` output. When `convergence_contract`
     * itself runs, this carries the *previous round's* contract (loaded from disk)
     * so the new round can compute objection deltas and ledger merges.
     */
    convergenceContract: z.unknown().optional(),
    productDefinition: z.unknown().optional(),
    monetizationConfig: z.unknown().optional(),
    builder: z.unknown().optional(),
    independentQa: z.unknown().optional(),
    releaseAgent: z.unknown().optional(),
    growthOperator: z.unknown().optional(),
    feedback: z.unknown().optional(),
    /**
     * Latest available `investor_panel` output. Populated from the most recent
     * artifact on disk so refinement-loop stages (especially `convergence_contract`)
     * can react to objections from the previous round within the same `runId`.
     */
    investorPanel: z.unknown().optional(),
    investorRefinement: InvestorRefinementContextSchema.optional(),
});
/**
 * Standard composed input for pipeline stages. Stages receive this object (then
 * validated by their own `inputSchema`). Downstream stages should not read
 * arbitrary repo files; they consume fields populated here.
 */
export async function getStageInput(_stageName, ctx) {
    const o = ctx.priorOutputs;
    async function readLatestStageOutput(stageName) {
        const raw = await readLatestArtifact(ctx.repoPath, `${stageName}/output.json`);
        if (!raw)
            return undefined;
        try {
            return JSON.parse(raw);
        }
        catch {
            return undefined;
        }
    }
    const latest = {
        repo_inventory: o.repo_inventory ?? (await readLatestStageOutput("repo_inventory")),
        current_state_audit: o.current_state_audit ?? (await readLatestStageOutput("current_state_audit")),
        baseline_app_shell: o.baseline_app_shell ?? (await readLatestStageOutput("baseline_app_shell")),
        market_gap_analysis: o.market_gap_analysis ?? (await readLatestStageOutput("market_gap_analysis")),
        first_principles: o.first_principles ?? (await readLatestStageOutput("first_principles")),
        flywheel_designer: o.flywheel_designer ?? (await readLatestStageOutput("flywheel_designer")),
        convergence_contract: o.convergence_contract ?? (await readLatestStageOutput("convergence_contract")),
        product_definition: o.product_definition ?? (await readLatestStageOutput("product_definition")),
        monetization_architect: o.monetization_architect ?? (await readLatestStageOutput("monetization_architect")),
        builder: o.builder ?? (await readLatestStageOutput("builder")),
        independent_qa: o.independent_qa ?? (await readLatestStageOutput("independent_qa")),
        release_agent: o.release_agent ?? (await readLatestStageOutput("release_agent")),
        growth_operator: o.growth_operator ?? (await readLatestStageOutput("growth_operator")),
        feedback_agent: o.feedback_agent ?? (await readLatestStageOutput("feedback_agent")),
        investor_panel: o.investor_panel ?? (await readLatestStageOutput("investor_panel")),
    };
    return {
        config: ctx.config,
        repoInventory: latest.repo_inventory,
        currentStateAudit: latest.current_state_audit,
        baselineAppShell: latest.baseline_app_shell,
        marketGap: latest.market_gap_analysis,
        firstPrinciples: latest.first_principles,
        flywheel: latest.flywheel_designer,
        convergenceContract: latest.convergence_contract,
        productDefinition: latest.product_definition,
        monetizationConfig: latest.monetization_architect,
        builder: latest.builder,
        independentQa: latest.independent_qa,
        releaseAgent: latest.release_agent,
        growthOperator: latest.growth_operator,
        feedback: latest.feedback_agent,
        investorPanel: latest.investor_panel,
        investorRefinement: ctx.investorRefinementLoop,
    };
}
