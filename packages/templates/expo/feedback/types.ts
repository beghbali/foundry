export interface FeedbackPayload {
  message: string;
  context: string;
  timestamp: string;
  screenshot?: string;
  metadata?: Record<string, unknown>;
}
