import { describe, expect, it } from "vitest";

import { separateManualAndCodeItems } from "../src/cursorAutomation.js";
import {
  isNonActionableWorkPacketItem,
  sampleOpenPacketItems,
  type WorkPacket,
} from "../src/workPacket.js";
import { isEnvironmentalWorkItem } from "@foundry/core/buildSpec";

describe("meta / env work-packet noise", () => {
  it("treats truncated builder-report echoes as non-actionable", () => {
    expect(
      isNonActionableWorkPacketItem(
        '**Feedback item `fb-9f4b4b9643da`** (`status: "open"`, `shouldImplement: true`):',
      ),
    ).toBe(true);
    expect(
      isNonActionableWorkPacketItem(
        "**`dir-5-convergencecontract-mvpb`** (`convergenceContract.mvpBoundary.mustShip`):",
      ),
    ).toBe(true);
    expect(
      isNonActionableWorkPacketItem(
        "Note: the packet tasks dir-1/dir-2/dir-3 carry `files[]` that are `rg` command",
      ),
    ).toBe(true);
  });

  it("treats simulator boot / maestro-did-not-run as environmental", () => {
    expect(
      isEnvironmentalWorkItem(
        "Maestro smoke did not run: no booted simulator/device (environmental — not a code failure).",
      ),
    ).toBe(true);
    expect(
      isEnvironmentalWorkItem(
        "Boot an iOS Simulator (or connect a device), then re-run so the required scan→verdict UX smoke can actually execute.",
      ),
    ).toBe(true);
  });

  it("routes env maestro blockers to manual, not code", () => {
    const { manual, code } = separateManualAndCodeItems([
      "Maestro smoke did not run: no booted simulator/device (environmental — not a code failure).",
      "Boot an iOS Simulator (or connect a device), then re-run so the required scan→verdict UX smoke can actually execute.",
      "Typecheck failed in apps/mobile/src/screens/ScanScreen.tsx",
    ]);
    expect(code).toEqual(["Typecheck failed in apps/mobile/src/screens/ScanScreen.tsx"]);
    expect(manual.length).toBe(2);
  });

  it("sampleOpenPacketItems omits meta and env rows", () => {
    const packet: WorkPacket = {
      version: 1,
      runId: "t",
      createdAt: "",
      updatedAt: "",
      maxItems: 14,
      briefBacklogOpen: 0,
      deferredCounts: {
        qa: 0,
        runtime: 0,
        must: 0,
        gaps: 0,
        should: 0,
        monetization: 0,
        edge: 0,
        builder: 0,
      },
      manualOnly: [],
      items: [
        {
          id: "pkt-1",
          key: "boot",
          source: "qa",
          section: "qa",
          text: "Boot an iOS Simulator (or connect a device), then re-run",
          status: "open",
          priority: 0,
          reopenCount: 0,
        },
        {
          id: "pkt-2",
          key: "meta",
          source: "builder",
          section: "builder",
          text: '**Feedback item `fb-9f4b4b9643da`** (`status: "open"`, `shouldImplement: true`):',
          status: "open",
          priority: 7,
          reopenCount: 0,
        },
        {
          id: "pkt-3",
          key: "real",
          source: "brief",
          section: "must",
          text: "Collapse ScanScreen pre-scan cards to one primer",
          status: "open",
          priority: 2,
          reopenCount: 0,
        },
      ],
    };
    const samples = sampleOpenPacketItems(packet, 10);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toContain("Collapse ScanScreen");
  });
});
