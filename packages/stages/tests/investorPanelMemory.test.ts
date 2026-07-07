import { describe, expect, it } from "vitest";

import {
  allPriorDirectivesAddressed,
  buildHeuristicRemovalDirectives,
  buildPersonaMemoryPromptSection,
  directiveMatchesAddressedParent,
  filterGenericDirectives,
  filterStaleDirectives,
  mergeInvestorDirectives,
  normalizeRemovalDirective,
  parseInvestorPanelSettings,
  reconcilePersonaMemories,
} from "../src/investorPanelMemory.js";

describe("investorPanelMemory", () => {
  it("defaults investor panel settings to memory + deletion pass on", () => {
    expect(parseInvestorPanelSettings(undefined)).toEqual({
      personaMemory: true,
      elonDeletionPass: true,
      minDeletionDirectives: 1,
    });
  });

  it("prefixes removal directives for builder routing", () => {
    expect(normalizeRemovalDirective("Remove ScanScreen card stack")).toBe(
      "[remove] Remove ScanScreen card stack",
    );
    expect(normalizeRemovalDirective("[remove] already tagged")).toBe("[remove] already tagged");
  });

  it("filters stale directives already addressed in ledger", () => {
    const addressed = ["Collapse four pre-scan cards on ScanScreen to one priority selector"];
    const stale = "Collapse four pre-scan cards on ScanScreen into one selector";
    expect(filterStaleDirectives([stale, "New ask in `InsightsScreen.tsx`"], addressed)).toEqual([
      "New ask in `InsightsScreen.tsx`",
    ]);
  });

  it("requires file anchors for non-remove directives", () => {
    const out = filterGenericDirectives(["Tighten onboarding delight", "[remove] drop card"], [], {
      requireFileAnchor: true,
    });
    expect(out).toEqual(["[remove] drop card"]);
  });

  it("merges removal, persona, and combined directives without dupes", () => {
    const merged = mergeInvestorDirectives(
      ["[remove] Drop card on ScanScreen.tsx"],
      [
        { id: "elon_musk", directives: ["In ScanScreen.tsx collapse cards"] },
        { id: "steve_jobs", directives: ["In ScanScreen.tsx collapse cards"] },
      ],
      ["In ScanScreen.tsx collapse cards"],
    );
    expect(merged[0]).toMatch(/^\[remove\]/);
    expect(merged.length).toBeGreaterThanOrEqual(2);
  });

  it("builds heuristic removal directives from parked features", () => {
    const dirs = buildHeuristicRemovalDirectives({
      wontShip: ["Instacart ingest"],
      parkedFeatures: ["Retail media"],
      topFiles: ["apps/mobile/src/screens/ScanScreen.tsx"],
      minCount: 2,
    });
    expect(dirs.length).toBeGreaterThanOrEqual(2);
    expect(dirs.every((d) => d.startsWith("[remove]"))).toBe(true);
  });

  it("injects exceptional convergence guidance when prior directives are addressed", () => {
    const section = buildPersonaMemoryPromptSection({
      state: {
        lastPitchAt: "2026-01-01",
        lastHeadSha: "abc",
        lastCompletedTaskIds: [],
        lastGrades: {},
        lastDirectives: ["Collapse ScanScreen cards"],
        personas: {
          elon_musk: {
            lastGrade: "B",
            gradeHistory: ["C", "B"],
            lastResponse: "Too many cards.",
            openDirectives: [],
            addressedDirectives: [],
            deletionCandidates: [],
          },
        },
      },
      addressedTexts: ["Collapse ScanScreen cards on ScanScreen to one priority selector"],
      qaRecommendation: "ship",
      qaBlockers: 0,
      settings: { personaMemory: true, elonDeletionPass: true, minDeletionDirectives: 1 },
    });
    expect(section).toContain("CONVERGENCE — EXCEPTIONAL");
    expect(section).toContain("exceptional");
  });

  it("detects when all prior directives are addressed", () => {
    expect(
      allPriorDirectivesAddressed(
        { lastPitchAt: "", lastHeadSha: "", lastCompletedTaskIds: [], lastGrades: {}, lastDirectives: ["Fix ScanScreen"] },
        ["Fix ScanScreen cards in ScanScreen.tsx"],
      ),
    ).toBe(true);
    expect(directiveMatchesAddressedParent("unrelated", ["other topic"])).toBe(false);
  });

  it("reconciles persona memory after a pitch", () => {
    const personas = reconcilePersonaMemories(
      undefined,
      [
        {
          id: "elon_musk",
          grade: "B+",
          response: "Better but still cluttered.",
          directives: ["In ScanScreen.tsx remove secondary cards"],
        },
        { id: "steve_jobs", grade: "A-", response: "Focused.", directives: [] },
        { id: "andreessen_horowitz", grade: "B", response: "Monetize.", directives: [] },
      ],
      ["In ScanScreen.tsx remove secondary cards"],
      ["[remove] Drop benchmark card on ScanScreen.tsx"],
      [],
      "2026-07-07T00:00:00.000Z",
    );
    expect(personas.elon_musk?.openDirectives.length).toBeGreaterThan(0);
    expect(personas.elon_musk?.deletionCandidates).toContain("Drop benchmark card on ScanScreen.tsx");
  });
});
