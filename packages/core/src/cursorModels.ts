/**
 * Default Cursor CLI model ids for Foundry automation (paid plans).
 * Override per repo in `.foundry/project.yaml` → `cursor_automation`.
 *
 * Run `agent models` locally to confirm ids when Cursor renames tiers.
 */
export const FOUNDRY_CURSOR_MODEL_DEFAULTS = {
  /** Wholesale product features, QA-red repair, stalled inner loops. */
  builderModel: "claude-opus-4-8-thinking-high",
  /** Inner pass 2+ refinement when QA is mostly green. */
  builderFastModel: "composer-2.5-fast",
  /** Near-release polish when only human approval remains. */
  builderEconomyModel: "composer-2.5-fast",
  /** BUILD_SPEC decomposition (structured JSON). */
  grandWizardModel: "gpt-5.3-codex",
  /** Second attempt when Grand Wizard decomposition fails (stronger reasoning). */
  grandWizardStrictModel: "claude-opus-4-8-thinking-high",
  /** Investor panel product-grounded grading. */
  investorPanelModel: "claude-opus-4-8-thinking-high",
} as const;

export type FoundryCursorModelRole = keyof typeof FOUNDRY_CURSOR_MODEL_DEFAULTS;

export function resolveFoundryCursorModel(
  configured: string | undefined,
  role: FoundryCursorModelRole,
): string {
  const trimmed = configured?.trim();
  if (trimmed) return trimmed;
  return FOUNDRY_CURSOR_MODEL_DEFAULTS[role];
}
