export const DEFAULT_FEEDBACK_OWNER_EMAILS = ["bashir@gmail.com"] as const;

export type FeedbackImplementationApproval =
  | "auto"
  | "pending"
  | "approved"
  | "declined"
  | "postponed";

export function normalizeFeedbackEmail(email: string | undefined): string | undefined {
  const normalized = email?.trim().toLowerCase();
  return normalized || undefined;
}

export function resolveFeedbackOwnerEmails(
  foundry?: { feedback?: { owner_emails?: string[] } },
): Set<string> {
  const raw = foundry?.feedback?.owner_emails ?? [...DEFAULT_FEEDBACK_OWNER_EMAILS];
  return new Set(
    raw.map(normalizeFeedbackEmail).filter((email): email is string => Boolean(email)),
  );
}

/** In-app feedback collected via Supabase always requires explicit loop review. */
export function isAppFeedbackSource(source: string): boolean {
  return source === "supabase";
}

/** CLI/manual feedback and configured owner emails are always queued for implementation. */
export function isAutoApprovedFeedback(
  source: string,
  submitterEmail: string | undefined,
  ownerEmails: Set<string>,
): boolean {
  if (isAppFeedbackSource(source)) return false;
  if (source === "manual:cli" || source.startsWith("manual:")) return true;
  const email = normalizeFeedbackEmail(submitterEmail);
  return email ? ownerEmails.has(email) : false;
}
