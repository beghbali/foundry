import { describe, expect, it } from "vitest";
import {
  isAppFeedbackPendingLoopReview,
  isAppFeedbackSource,
  isAutoApprovedFeedback,
  resolveFeedbackOwnerEmails,
} from "../src/feedbackPolicy.js";

describe("feedbackPolicy", () => {
  it("treats Supabase as in-app feedback", () => {
    expect(isAppFeedbackSource("supabase")).toBe(true);
    expect(isAppFeedbackSource("manual:cli")).toBe(false);
  });

  it("auto-approves owner in-app feedback for straight-to-builder queueing", () => {
    const owners = resolveFeedbackOwnerEmails({
      feedback: { owner_emails: ["owner@example.com"] },
    });
    expect(isAutoApprovedFeedback("supabase", "owner@example.com", owners)).toBe(true);
    expect(isAppFeedbackPendingLoopReview("supabase", "owner@example.com", owners)).toBe(false);
  });

  it("requires loop review for non-owner in-app feedback", () => {
    const owners = resolveFeedbackOwnerEmails({
      feedback: { owner_emails: ["owner@example.com"] },
    });
    expect(isAutoApprovedFeedback("supabase", "tester@example.com", owners)).toBe(false);
    expect(isAppFeedbackPendingLoopReview("supabase", "tester@example.com", owners)).toBe(true);
  });

  it("auto-approves CLI/manual feedback", () => {
    const owners = resolveFeedbackOwnerEmails();
    expect(isAutoApprovedFeedback("manual:cli", undefined, owners)).toBe(true);
    expect(isAutoApprovedFeedback("manual:batch.json", undefined, owners)).toBe(true);
  });

  it("auto-approves non-app feedback from configured owner emails", () => {
    const owners = resolveFeedbackOwnerEmails({
      feedback: { owner_emails: ["owner@example.com"] },
    });
    expect(isAutoApprovedFeedback("release_log", "owner@example.com", owners)).toBe(true);
  });
});
