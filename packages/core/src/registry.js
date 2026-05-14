import { baselineAppShellStage, builderStage, convergenceContractStage, currentStateAuditStage, feedbackAgentStage, firstPrinciplesStage, flywheelDesignerStage, growthOperatorStage, independentQaStage, investorPanelStage, marketGapAnalysisStage, monetizationArchitectStage, productDefinitionStage, releaseAgentStage, repoInventoryStage } from "@foundry/stages";
const STAGES = [
    repoInventoryStage,
    currentStateAuditStage,
    baselineAppShellStage,
    marketGapAnalysisStage,
    firstPrinciplesStage,
    flywheelDesignerStage,
    convergenceContractStage,
    productDefinitionStage,
    monetizationArchitectStage,
    builderStage,
    independentQaStage,
    releaseAgentStage,
    growthOperatorStage,
    feedbackAgentStage,
    investorPanelStage,
];
let cached;
/**
 * All registered stages keyed by name. Edit this module to add/remove stages.
 */
export function getStageRegistry() {
    if (!cached) {
        cached = {};
        for (const s of STAGES) {
            cached[s.name] = s;
        }
    }
    return cached;
}
export function listRegisteredStageNames() {
    return Object.keys(getStageRegistry());
}
export function hasRegisteredStage(name) {
    return name in getStageRegistry();
}
