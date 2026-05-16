import { baselineAppShellStage, builderStage, convergenceContractStage, currentStateAuditStage, feedbackAgentStage, firstPrinciplesStage, flywheelDesignerStage, grandWizardStage, growthOperatorStage, independentQaStage, investorPanelStage, marketGapAnalysisStage, monetizationArchitectStage, productDefinitionStage, releaseAgentStage, repoInventoryStage } from "@foundry/stages";

import { type StageInputComposition } from "./stageInputs.js";
import type { Stage } from "./types.js";

const STAGES: Stage<StageInputComposition, unknown>[] = [
  repoInventoryStage as Stage<StageInputComposition, unknown>,
  currentStateAuditStage as Stage<StageInputComposition, unknown>,
  baselineAppShellStage as Stage<StageInputComposition, unknown>,
  marketGapAnalysisStage as Stage<StageInputComposition, unknown>,
  firstPrinciplesStage as Stage<StageInputComposition, unknown>,
  flywheelDesignerStage as Stage<StageInputComposition, unknown>,
  convergenceContractStage as Stage<StageInputComposition, unknown>,
  productDefinitionStage as Stage<StageInputComposition, unknown>,
  monetizationArchitectStage as Stage<StageInputComposition, unknown>,
  feedbackAgentStage as Stage<StageInputComposition, unknown>,
  grandWizardStage as Stage<StageInputComposition, unknown>,
  builderStage as Stage<StageInputComposition, unknown>,
  independentQaStage as Stage<StageInputComposition, unknown>,
  releaseAgentStage as Stage<StageInputComposition, unknown>,
  growthOperatorStage as Stage<StageInputComposition, unknown>,
  investorPanelStage as Stage<StageInputComposition, unknown>,
];

let cached: Record<string, Stage<unknown, unknown>> | undefined;

/**
 * All registered stages keyed by name. Edit this module to add/remove stages.
 */
export function getStageRegistry(): Record<string, Stage<unknown, unknown>> {
  if (!cached) {
    cached = {};
    for (const s of STAGES) {
      cached[s.name] = s as Stage<unknown, unknown>;
    }
  }
  return cached;
}

export function listRegisteredStageNames(): string[] {
  return Object.keys(getStageRegistry());
}

export function hasRegisteredStage(name: string): boolean {
  return name in getStageRegistry();
}
