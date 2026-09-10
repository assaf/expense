/**
 * Shared fence plumbing for LLM prompts that embed untrusted data (the
 * insights context, receipt text). A marker fence only holds if the strip
 * is at least as fuzzy as the model reading it: case variants, stray
 * brackets/whitespace, zero-width characters, and fullwidth/math
 * look-alikes can all read as a marker close, so the strip normalizes
 * those first (FENCE-B1). Overmatching is harmless: these strings only
 * feed prompt copy, never parsed data (FENCE-B3 scope).
 */

const INVISIBLE_RE = /[\u00ad\u200b-\u200f\u2060\ufeff]/g;
const BRACKET_LOOKALIKE_RE = /[＜＞⟨⟩]/g;
const LOOKALIKE_ASCII: Record<string, string> = {
  "＜": "<",
  "＞": ">",
  "⟨": "<",
  "⟩": ">",
};

/** Remove anything shaped like a `<<<NAME>>>` marker, fuzzily. */
export function stripFenceMarkers(content: string, name: string): string {
  const normalized = content
    .replaceAll(INVISIBLE_RE, "")
    .replace(BRACKET_LOOKALIKE_RE, (c) => LOOKALIKE_ASCII[c] ?? c);
  return normalized.replace(
    new RegExp(`<${"[<\\s]*"}\\/?${"[<\\s]*"}${name}${"[\\s>]*"}>{2,}`, "gi"),
    "",
  );
}
