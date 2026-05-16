import type { ProjectDomain } from "./config.js";

/**
 * Selectors over the optional `project.domain` block in `project.yaml`.
 *
 * Stages call these instead of reaching into `project.domain` directly so the
 * "missing block" fallback is uniform: every selector returns an empty/sensible
 * default when the block is absent or incomplete, and downstream code can keep
 * its existing generic templates as the fallback path.
 *
 * Note on typing: stages declare local input schemas that pull a *subset* of
 * `project.*` fields, so we can't require the full `ProjectYaml` here. We
 * structurally accept anything that has a `domain` property.
 */

type WithDomain = { domain?: ProjectDomain | null } | null | undefined;

export function getDomain(project: WithDomain): ProjectDomain | undefined {
  return project?.domain ?? undefined;
}

export function hasDomain(project: WithDomain): boolean {
  return Boolean(project?.domain);
}

export function getDomainName(project: WithDomain): string | undefined {
  const v = project?.domain?.name?.trim();
  return v && v.length > 0 ? v : undefined;
}

export function getDomainPrimaryUserAction(project: WithDomain): string | undefined {
  const v = project?.domain?.primary_user_action?.trim();
  return v && v.length > 0 ? v : undefined;
}

export function getDomainKeyUserActions(project: WithDomain): string[] {
  return (project?.domain?.key_user_actions ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function getDomainSuccessExamples(project: WithDomain): string[] {
  return (project?.domain?.success_examples ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function getDomainNonGoals(project: WithDomain): string[] {
  return (project?.domain?.non_goals ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}

export function getDomainPersonas(project: WithDomain): string[] {
  return (project?.domain?.personas ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}

export function getDomainPrimaryMetric(project: WithDomain): string | undefined {
  const v = project?.domain?.primary_metric?.trim();
  return v && v.length > 0 ? v : undefined;
}

export type DomainVocabulary = {
  noun: string;
  verb: string;
  outcome: string;
  actor: string;
};

/** Vocabulary with safe fallbacks when the block (or individual fields) are absent. */
export function getDomainVocabulary(project: WithDomain): DomainVocabulary {
  const vocab = project?.domain?.vocabulary ?? {};
  return {
    noun: vocab.noun?.trim() || "interaction",
    verb: vocab.verb?.trim() || "use",
    outcome: vocab.outcome?.trim() || "outcome",
    actor: vocab.actor?.trim() || "user",
  };
}

/**
 * Brief-ready Must Ship lines derived from the domain block. Each `key_user_action`
 * becomes one line; if the action does not already mention the outcome word, we
 * tack on a measurable hint anchored on `primary_metric` (when set). Returns an
 * empty array when no domain actions are configured — caller falls back to its
 * existing generic templates in that case.
 */
export function domainMustShipLines(project: WithDomain): string[] {
  const actions = getDomainKeyUserActions(project);
  if (actions.length === 0) return [];
  const metric = getDomainPrimaryMetric(project);
  const vocab = getDomainVocabulary(project);
  return actions.map((action) => {
    if (!metric) return action;
    const lower = action.toLowerCase();
    // Avoid double-stamping when the action already references the metric or outcome word.
    if (lower.includes(metric.toLowerCase()) || lower.includes(vocab.outcome.toLowerCase())) {
      return action;
    }
    return `${action} (target: ${metric})`;
  });
}

/** A concise one-line domain summary suitable for pitch briefs / investor context. */
export function domainSummaryLine(project: WithDomain): string | undefined {
  const primary = getDomainPrimaryUserAction(project);
  if (primary) return primary;
  const name = getDomainName(project);
  const metric = getDomainPrimaryMetric(project);
  if (name && metric) return `${name}: ${metric}`;
  return name;
}
