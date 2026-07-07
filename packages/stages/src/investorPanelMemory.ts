import { INVESTOR_ALL_A_MINUS_RANK, investorGradeRank } from "@foundry/core/investorGrades";

export type PersonaId = "elon_musk" | "steve_jobs" | "andreessen_horowitz";

export type PersonaDirectiveRecord = {
  id: string;
  text: string;
  status: "open" | "addressed" | "superseded";
  sincePitchAt: string;
  addressedAt?: string;
};

export type PersonaMemoryState = {
  lastGrade: string;
  gradeHistory: string[];
  lastResponse: string;
  openDirectives: PersonaDirectiveRecord[];
  addressedDirectives: PersonaDirectiveRecord[];
  /** Surfaces Elon flagged for removal across pitches. */
  deletionCandidates: string[];
};

export type InvestorPanelStateV2 = {
  lastPitchAt: string;
  lastHeadSha: string;
  lastCompletedTaskIds: string[];
  lastGrades: Record<string, string>;
  lastDirectives?: string[];
  lastAverageRank?: number;
  personas?: Partial<Record<PersonaId, PersonaMemoryState>>;
};

export type InvestorPanelSettings = {
  personaMemory: boolean;
  elonDeletionPass: boolean;
  minDeletionDirectives: number;
};

function yamlTruthy(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "yes" || s === "on" || s === "1";
  }
  return false;
}

function yamlFalsy(v: unknown): boolean {
  if (v === false || v === 0) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "false" || s === "no" || s === "off" || s === "0";
  }
  return false;
}

export function parseInvestorPanelSettings(foundry: { investor_panel?: unknown } | null | undefined): InvestorPanelSettings {
  const block = foundry?.investor_panel as
    | {
        persona_memory?: unknown;
        elon_deletion_pass?: unknown;
        min_deletion_directives?: unknown;
      }
    | undefined;
  const personaMemory = block?.persona_memory === undefined ? true : yamlTruthy(block.persona_memory) || !yamlFalsy(block.persona_memory);
  const elonDeletionPass =
    block?.elon_deletion_pass === undefined ? true : yamlTruthy(block.elon_deletion_pass) || !yamlFalsy(block.elon_deletion_pass);
  const rawMin = block?.min_deletion_directives;
  const minDeletionDirectives =
    typeof rawMin === "number" && Number.isFinite(rawMin) ? Math.max(0, Math.floor(rawMin)) : 1;
  return { personaMemory, elonDeletionPass, minDeletionDirectives };
}

export function normDirectiveText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Fuzzy match: directive recognizably represented in addressed parent texts. */
export function directiveMatchesAddressedParent(directive: string, addressedTexts: ReadonlyArray<string>): boolean {
  const a = normDirectiveText(directive);
  if (a.length === 0) return false;
  const aPrefix = a.slice(0, 40);
  const aWords = new Set(a.split(" ").filter((w) => w.length > 4));
  for (const p of addressedTexts) {
    const b = normDirectiveText(p);
    if (b.length === 0) continue;
    if (b.includes(aPrefix) || a.includes(b.slice(0, 40))) return true;
    const bWords = new Set(b.split(" ").filter((w) => w.length > 4));
    let overlap = 0;
    for (const w of aWords) if (bWords.has(w)) overlap++;
    if (overlap >= 3 && overlap / Math.max(1, aWords.size) >= 0.4) return true;
  }
  return false;
}

export function filterStaleDirectives(directives: ReadonlyArray<string>, addressedTexts: ReadonlyArray<string>): string[] {
  return directives.filter((d) => !directiveMatchesAddressedParent(d, addressedTexts));
}

/** Ensures removal directives are tagged for Grand Wizard / builder `[remove]` routing. */
export function normalizeRemovalDirective(text: string): string {
  const t = text.trim();
  if (!t) return t;
  if (/^\[remove\]/i.test(t)) return t;
  return `[remove] ${t}`;
}

export function directiveHasFileAnchor(text: string): boolean {
  return (
    /\.(tsx?|jsx?|swift|kt)\b/i.test(text) ||
    /\bScreen\b/.test(text) ||
    /\btestID\b/i.test(text) ||
    /`[^`]+\.(tsx?|jsx?|swift)`/.test(text)
  );
}

export function filterGenericDirectives(
  directives: ReadonlyArray<string>,
  addressedTexts: ReadonlyArray<string>,
  opts?: { requireFileAnchor?: boolean },
): string[] {
  const requireFileAnchor = opts?.requireFileAnchor ?? true;
  const out: string[] = [];
  for (const d of directives) {
    const t = d.trim();
    if (!t) continue;
    if (directiveMatchesAddressedParent(t, addressedTexts)) continue;
    if (requireFileAnchor && !/^\[remove\]/i.test(t) && !directiveHasFileAnchor(t)) continue;
    out.push(t);
  }
  return [...new Set(out)];
}

let directiveIdCounter = 0;
function nextDirectiveId(prefix: string): string {
  directiveIdCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${directiveIdCounter}`;
}

function emptyPersonaMemory(): PersonaMemoryState {
  return {
    lastGrade: "C",
    gradeHistory: [],
    lastResponse: "",
    openDirectives: [],
    addressedDirectives: [],
    deletionCandidates: [],
  };
}

function reconcileDirectiveList(
  prior: PersonaDirectiveRecord[],
  newTexts: readonly string[],
  addressedTexts: readonly string[],
  pitchAt: string,
  idPrefix: string,
): { open: PersonaDirectiveRecord[]; addressed: PersonaDirectiveRecord[] } {
  const addressed: PersonaDirectiveRecord[] = [];
  const open: PersonaDirectiveRecord[] = [];

  for (const rec of prior) {
    if (rec.status === "addressed") {
      addressed.push(rec);
      continue;
    }
    if (directiveMatchesAddressedParent(rec.text, addressedTexts)) {
      addressed.push({ ...rec, status: "addressed", addressedAt: pitchAt });
    } else {
      open.push(rec);
    }
  }

  for (const text of newTexts) {
    const t = text.trim();
    if (!t) continue;
    if (directiveMatchesAddressedParent(t, addressedTexts)) {
      addressed.push({
        id: nextDirectiveId(idPrefix),
        text: t,
        status: "addressed",
        sincePitchAt: pitchAt,
        addressedAt: pitchAt,
      });
      continue;
    }
    const dup = open.some((o) => directiveMatchesAddressedParent(o.text, [t]));
    if (dup) continue;
    open.push({
      id: nextDirectiveId(idPrefix),
      text: t,
      status: "open",
      sincePitchAt: pitchAt,
    });
  }

  return { open: open.slice(0, 8), addressed: addressed.slice(-12) };
}

export function reconcilePersonaMemories(
  prior: InvestorPanelStateV2 | undefined,
  investors: ReadonlyArray<{ id: PersonaId; grade: string; response: string; directives?: string[] }>,
  combinedDirectives: ReadonlyArray<string>,
  removalDirectives: ReadonlyArray<string>,
  addressedTexts: ReadonlyArray<string>,
  pitchAt: string,
): Partial<Record<PersonaId, PersonaMemoryState>> {
  const personas: Partial<Record<PersonaId, PersonaMemoryState>> = {};

  for (const inv of investors) {
    const prev = prior?.personas?.[inv.id] ?? emptyPersonaMemory();
    const personaDirectives = inv.directives?.length ? inv.directives : combinedDirectives;
    const elonRemovals = inv.id === "elon_musk" ? removalDirectives : [];
    const allNew = [...elonRemovals.map(normalizeRemovalDirective), ...personaDirectives];
    const { open, addressed } = reconcileDirectiveList(
      [...prev.openDirectives, ...prev.addressedDirectives.filter((d) => d.status === "addressed")],
      allNew,
      addressedTexts,
      pitchAt,
      inv.id,
    );

    const deletionCandidates = [
      ...new Set([
        ...prev.deletionCandidates,
        ...removalDirectives.map((d) => d.replace(/^\[remove\]\s*/i, "").trim()),
      ]),
    ].slice(0, 12);

    const gradeHistory = [...prev.gradeHistory, inv.grade].slice(-8);
    personas[inv.id] = {
      lastGrade: inv.grade,
      gradeHistory,
      lastResponse: inv.response,
      openDirectives: open,
      addressedDirectives: addressed,
      deletionCandidates,
    };
  }

  return personas;
}

export function allPriorDirectivesAddressed(
  state: InvestorPanelStateV2 | undefined,
  addressedTexts: ReadonlyArray<string>,
): boolean {
  const last = state?.lastDirectives ?? [];
  if (last.length === 0) return false;
  return last.every((d) => directiveMatchesAddressedParent(d, addressedTexts));
}

export function buildPersonaMemoryPromptSection(args: {
  state: InvestorPanelStateV2 | undefined;
  addressedTexts: ReadonlyArray<string>;
  qaRecommendation?: string;
  qaBlockers?: number;
  settings: InvestorPanelSettings;
}): string {
  if (!args.settings.personaMemory) return "";

  const { state, addressedTexts, qaRecommendation, qaBlockers } = args;
  const lines: string[] = ["", "**PERSONA MEMORY (continue threads — do not reset or repeat addressed asks):**"];

  if (!state?.personas || Object.keys(state.personas).length === 0) {
    lines.push("- First pitch with persona memory — establish specific, file-anchored directives.");
    return lines.join("\n");
  }

  const personaLabels: Record<PersonaId, string> = {
    elon_musk: "Elon Musk",
    steve_jobs: "Steve Jobs",
    andreessen_horowitz: "Andreessen Horowitz",
  };

  for (const id of ["elon_musk", "steve_jobs", "andreessen_horowitz"] as PersonaId[]) {
    const mem = state.personas[id];
    if (!mem) continue;
    lines.push(`- **${personaLabels[id]}** (last grade ${mem.lastGrade}):`);
    if (mem.lastResponse) {
      lines.push(`  - Last response: "${mem.lastResponse.slice(0, 220)}${mem.lastResponse.length > 220 ? "…" : ""}"`);
    }
    const open = mem.openDirectives.filter((d) => d.status === "open");
    if (open.length > 0) {
      lines.push("  - Still open from you:");
      for (const d of open.slice(0, 4)) lines.push(`    - ${d.text}`);
    }
    const recentlyAddressed = mem.addressedDirectives
      .filter((d) => d.status === "addressed")
      .slice(-3);
    if (recentlyAddressed.length > 0) {
      lines.push("  - You asked for this and it shipped — acknowledge and grade up:");
      for (const d of recentlyAddressed) lines.push(`    - ${d.text}`);
    }
    if (id === "elon_musk" && mem.deletionCandidates.length > 0) {
      lines.push(`  - Surfaces you previously flagged for removal: ${mem.deletionCandidates.slice(0, 4).join("; ")}`);
    }
  }

  const priorAddressed = allPriorDirectivesAddressed(state, addressedTexts);
  const qaShip = (qaRecommendation ?? "").toLowerCase() === "ship" && (qaBlockers ?? 0) === 0;

  if (priorAddressed && qaShip) {
    lines.push(
      "",
      "**CONVERGENCE — EXCEPTIONAL:** All prior panel directives are addressed in shipped code and QA recommends ship.",
      "Grade **A or A+** for all three personas. Each response must say the product is **exceptional** with specific evidence from shipped work.",
      "Return **empty** `directives` arrays and **empty** `combinedRefinementDirectives` — do not invent new nitpicks.",
    );
  } else if (priorAddressed) {
    lines.push(
      "",
      "**CONVERGENCE:** Prior directives are addressed in code. Move grades toward A-band; only ask for new changes if you see a concrete regression in the shipped product.",
    );
  } else {
    lines.push(
      "",
      "**REFINEMENT RULES:**",
      "- Do NOT repeat directives listed as addressed above.",
      "- Escalate specificity on open directives: name the exact file/screen/testID and the delta vs last pitch.",
      "- Each persona's `directives` must differ — no copy-paste across investors.",
    );
  }

  return lines.join("\n");
}

export function mergeInvestorDirectives(
  removalDirectives: ReadonlyArray<string>,
  investors: ReadonlyArray<{ id: PersonaId; directives?: string[] }>,
  combinedFromLlm: ReadonlyArray<string>,
): string[] {
  const byPersona: string[] = [];
  for (const inv of investors) {
    for (const d of inv.directives ?? []) byPersona.push(d.trim());
  }
  const merged = [
    ...removalDirectives.map(normalizeRemovalDirective),
    ...byPersona,
    ...combinedFromLlm,
  ].filter((d) => d.length > 0);
  return [...new Set(merged)].slice(0, 10);
}

export function buildSurfaceInventoryLines(args: {
  topFiles: string[];
  wontShip: string[];
  parkedFeatures: string[];
  mustShipCount: number;
}): string[] {
  const lines: string[] = [];
  if (args.topFiles.length > 0) {
    lines.push(`Recent product files: ${args.topFiles.map((f) => `\`${f}\``).join(", ")}`);
  }
  if (args.wontShip.length > 0) {
    lines.push(`Explicitly out of scope (candidates to keep deleted): ${args.wontShip.slice(0, 6).join("; ")}`);
  }
  if (args.parkedFeatures.length > 0) {
    lines.push(`Parked features (consider removing from UI): ${args.parkedFeatures.slice(0, 6).join("; ")}`);
  }
  lines.push(`Must-ship scope size: ${args.mustShipCount} item(s) — deletion pass should not remove must-ship surfaces.`);
  return lines;
}

export function buildHeuristicRemovalDirectives(args: {
  wontShip: string[];
  parkedFeatures: string[];
  topFiles: string[];
  minCount: number;
}): string[] {
  const out: string[] = [];
  for (const p of args.parkedFeatures.slice(0, 2)) {
    out.push(normalizeRemovalDirective(`Remove parked UI surface "${p}" from user-facing screens; add test asserting absence.`));
  }
  for (const w of args.wontShip.slice(0, 2)) {
    out.push(
      normalizeRemovalDirective(`Ensure "${w}" is not exposed in any screen — delete dead routes/cards if still visible.`),
    );
  }
  for (const f of args.topFiles.filter((x) => /Screen\.tsx$/i.test(x)).slice(0, 1)) {
    out.push(
      normalizeRemovalDirective(
        `In \`${f}\`, remove secondary card stacks or duplicate CTAs — keep one hero action per screen; test asserts only one primary testID remains.`,
      ),
    );
  }
  return out.slice(0, Math.max(args.minCount, out.length));
}

export function gradesIndicateExceptional(grades: ReadonlyArray<string>): boolean {
  return grades.length > 0 && grades.every((g) => investorGradeRank(g) >= investorGradeRank("A"));
}

export function exceptionalResponseSuffix(grade: string): string {
  if (investorGradeRank(grade) >= investorGradeRank("A+")) {
    return " This is exceptional — ship it.";
  }
  if (investorGradeRank(grade) >= investorGradeRank("A")) {
    return " This is exceptional at the memo level.";
  }
  return "";
}

export { INVESTOR_ALL_A_MINUS_RANK };
