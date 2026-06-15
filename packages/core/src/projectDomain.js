export function getDomain(project) {
    return project?.domain ?? undefined;
}
export function hasDomain(project) {
    return Boolean(project?.domain);
}
export function getDomainName(project) {
    const v = project?.domain?.name?.trim();
    return v && v.length > 0 ? v : undefined;
}
export function getDomainPrimaryUserAction(project) {
    const v = project?.domain?.primary_user_action?.trim();
    return v && v.length > 0 ? v : undefined;
}
export function getDomainKeyUserActions(project) {
    return (project?.domain?.key_user_actions ?? [])
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}
export function getDomainSuccessExamples(project) {
    return (project?.domain?.success_examples ?? [])
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}
export function getDomainNonGoals(project) {
    return (project?.domain?.non_goals ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}
export function getDomainPersonas(project) {
    return (project?.domain?.personas ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}
export function getDomainPrimaryMetric(project) {
    const v = project?.domain?.primary_metric?.trim();
    return v && v.length > 0 ? v : undefined;
}
/** Vocabulary with safe fallbacks when the block (or individual fields) are absent. */
export function getDomainVocabulary(project) {
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
export function domainMustShipLines(project) {
    const actions = getDomainKeyUserActions(project);
    if (actions.length === 0)
        return [];
    const metric = getDomainPrimaryMetric(project);
    const vocab = getDomainVocabulary(project);
    return actions.map((action) => {
        if (!metric)
            return action;
        const lower = action.toLowerCase();
        // Avoid double-stamping when the action already references the metric or outcome word.
        if (lower.includes(metric.toLowerCase()) || lower.includes(vocab.outcome.toLowerCase())) {
            return action;
        }
        return `${action} (target: ${metric})`;
    });
}
/** A concise one-line domain summary suitable for pitch briefs / investor context. */
export function domainSummaryLine(project) {
    const primary = getDomainPrimaryUserAction(project);
    if (primary)
        return primary;
    const name = getDomainName(project);
    const metric = getDomainPrimaryMetric(project);
    if (name && metric)
        return `${name}: ${metric}`;
    return name;
}
