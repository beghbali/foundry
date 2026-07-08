import { describe, expect, it } from "vitest";

import { shouldRunCursorAutomation } from "../src/cursorAutomation.js";

const emptyBrief = {
  mustShip: 0,
  shouldShip: 0,
  unresolvedGaps: 0,
  monetization: 0,
  edgeFunctions: 0,
  runtime: 0,
  total: 0,
};

describe("shouldRunCursorAutomation", () => {
  it("skips Cursor when QA is ship and nothing is open", () => {
    expect(
      shouldRunCursorAutomation("awaiting_approval", emptyBrief, "ship", 0, {
        autonomousDeferRelease: true,
        investorTargetMet: false,
        contractConvergenceMet: false,
        unbuiltInvestorDirectiveCount: 0,
      }),
    ).toBe(false);
  });

  it("keeps Cursor alive for unbuilt investor directives even when packet is empty", () => {
    expect(
      shouldRunCursorAutomation("awaiting_approval", emptyBrief, "ship", 0, {
        autonomousDeferRelease: true,
        investorTargetMet: false,
        contractConvergenceMet: false,
        unbuiltInvestorDirectiveCount: 1,
      }),
    ).toBe(true);
  });

  it("does not invent work from investor grade alone without directives", () => {
    expect(
      shouldRunCursorAutomation("awaiting_approval", emptyBrief, "ship", 0, {
        autonomousDeferRelease: true,
        investorTargetMet: false,
        contractConvergenceMet: true,
        unbuiltInvestorDirectiveCount: 0,
      }),
    ).toBe(false);
  });
});
