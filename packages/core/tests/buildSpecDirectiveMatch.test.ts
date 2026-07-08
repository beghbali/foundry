import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectBuildSpecAddressedTexts,
  directiveMatchesAddressedText,
  extractRemovalTargetPaths,
  investorDirectiveAppearsBuilt,
} from "../src/buildSpec.js";

describe("buildSpec directive matching", () => {
  it("fuzzy-matches investor directives to ledger parent text", () => {
    const addressed = ["Delete MealScanScreen and remove navigator routes from packaged-food loop"];
    const directive =
      "[remove] apps/mobile/src/screens/MealScanScreen.tsx — delete file and its navigator route";
    expect(directiveMatchesAddressedText(directive, addressed)).toBe(true);
  });

  it("extracts removal paths from directives", () => {
    const paths = extractRemovalTargetPaths(
      "[remove] apps/mobile/src/screens/MealScanScreen.tsx — delete file",
    );
    expect(paths).toContain("apps/mobile/src/screens/MealScanScreen.tsx");
  });

  it("treats removed screen files as built for [remove] directives", () => {
    const tmp = join(process.cwd(), ".tmp-buildspec-directive-test");
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(join(tmp, "apps/mobile/src/screens"), { recursive: true });
    const directive =
      "[remove] apps/mobile/src/screens/MealScanScreen.tsx — delete the meal scan surface";
    expect(investorDirectiveAppearsBuilt(directive, [], tmp)).toBe(true);
    writeFileSync(join(tmp, "apps/mobile/src/screens/MealScanScreen.tsx"), "// still here\n");
    expect(investorDirectiveAppearsBuilt(directive, [], tmp)).toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("collects addressed texts from ledger tasks and parents", () => {
    const texts = collectBuildSpecAddressedTexts(
      {
        cycleTheme: "t",
        primarySliceId: "s1",
        slices: [
          {
            id: "s1",
            title: "Slice",
            userStory: "u",
            screens: [],
            files: [],
            acceptance: ["a"],
            tasks: [{ id: "t6", task: "Delete MealScanScreen files", files: [], verification: "v" }],
            outOfScope: [],
            investorAddresses: [],
          },
        ],
        parentDirectives: [],
        deferred: [],
        definitionOfDone: [],
        source: "heuristic",
        notes: [],
      },
      {
        version: 1,
        updatedAt: "",
        upstreamFingerprint: "",
        tasks: { t6: { completedAt: "", runId: "", filesTouched: [], locAdded: 0, locRemoved: 0 } },
        stuckCycles: 0,
        addressedParents: {
          p1: { text: "Account utility-only", source: "other", addressedAt: "" },
        },
        undecomposedParentStreak: {},
        droppedParents: {},
      },
    );
    expect(texts.some((t) => t.includes("MealScanScreen"))).toBe(true);
    expect(texts.some((t) => t.includes("Account utility"))).toBe(true);
  });
});
