import { createHash } from "node:crypto";

/**
 * Stable identity for a CURSOR_BRIEF.md checklist line, designed to survive
 * surface-text drift across pipeline cycles.
 *
 * Why: every outer cycle the `builder` stage regenerates `CURSOR_BRIEF.md`
 * from current upstream strings. Previously the `[x]` preservation hashed the
 * *exact text*, so any phrasing change (`product_definition` rewriting, contract
 * narrowing, investor refinement) reset items to `[ ]` and Cursor re-implemented
 * already-shipped work. Keying on a sorted bag of meaningful tokens gives us
 * an "intent fingerprint" that survives small wording changes; the ID derived
 * from it is what we stamp on the line as `<!-- id:bf-<section>-<8hex> -->`.
 */

export type BriefSection =
  | "investor"
  | "must"
  | "should"
  | "gaps"
  | "runtime"
  | "monetization"
  | "edge";

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "and",
  "is",
  "to",
  "for",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "as",
  "or",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "but",
  "if",
  "then",
  "than",
  "into",
  "through",
  "across",
  "via",
  "their",
  "they",
  "them",
  "his",
  "her",
  "our",
  "your",
  "user",
  "users",
  "use",
  "using",
  "any",
  "all",
  "some",
  "each",
  "every",
  "after",
  "before",
  "while",
  "when",
  "where",
  "what",
  "who",
  "how",
  "why",
  "not",
  "no",
  "yes",
  "you",
  "we",
  "my",
  "me",
]);

/**
 * Strip the `<!-- id:bf-... -->` annotation and any trailing whitespace from a
 * checklist line so callers can render or compare on the human-readable text.
 */
export function stripBriefIdComment(text: string): string {
  return text.replace(/\s*<!--\s*id:[a-z0-9_-]+\s*-->\s*$/i, "").trim();
}

/**
 * Pull the `<!-- id:bf-... -->` annotation out of a checklist line, if present.
 * Returns `undefined` if the line predates ID stamping (back-compat path).
 */
export function parseBriefIdComment(text: string): string | undefined {
  const m = text.match(/<!--\s*id:(bf-[a-z]+-[a-f0-9]{6,16})\s*-->/i);
  return m ? m[1] : undefined;
}

/**
 * Convert raw checklist text into a "bag of meaningful tokens" — lowercase,
 * punctuation stripped, stopwords removed, sorted. Two lines that express the
 * same intent with different phrasing collapse to the same token; markedly
 * different lines stay distinct.
 */
export function briefIntentToken(text: string): string {
  const stripped = stripBriefIdComment(text)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/`[^`]*`/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return "";
  const tokens = stripped
    .split(" ")
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  // Order-independent: minor restatements of the same intent collide.
  tokens.sort();
  // Cap to keep noise from dragging the fingerprint around.
  return tokens.slice(0, 12).join(" ");
}

/**
 * Compute the stable brief-item ID for a section + text. Same intent → same id
 * across cycles. The ID prefix encodes the section so a single grep filters by
 * scope (must vs should vs gaps).
 */
export function mintBriefItemId(section: BriefSection, text: string): string {
  const intent = briefIntentToken(text);
  const seed = `${section}::${intent || stripBriefIdComment(text).toLowerCase()}`;
  const h = createHash("sha1").update(seed).digest("hex").slice(0, 8);
  return `bf-${section}-${h}`;
}

/** Append the ID annotation to a checklist line if it does not already carry one. */
export function annotateBriefLineWithId(line: string, id: string): string {
  if (parseBriefIdComment(line)) return line;
  return `${line} <!-- id:${id} -->`;
}
