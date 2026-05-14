import type { FeedbackPayload } from './types';

/**
 * Submit feedback to the backend.
 *
 * Replace the implementation with your actual API call:
 * - Supabase: `supabase.from('feedback').insert(payload)`
 * - Edge function: `supabase.functions.invoke('submit-feedback', { body: payload })`
 * - REST: `fetch('/api/feedback', { method: 'POST', body: JSON.stringify(payload) })`
 */
export async function submitFeedback(
  payload: FeedbackPayload,
  userId?: string,
): Promise<void> {
  // --- PLACEHOLDER: replace with your Supabase / API call ---
  console.log('[feedback] submitting', { ...payload, userId });

  // Example Supabase implementation:
  // const { error } = await supabase.from('feedback').insert({
  //   user_id: userId,
  //   screen: payload.context,
  //   message: payload.message,
  //   app_version: Constants.expoConfig?.version ?? 'unknown',
  // });
  // if (error) throw error;
}
