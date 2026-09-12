/**
 * Shared fence plumbing for LLM prompts that embed untrusted data (the
 * insights context, receipt text). A marker fence only holds if the strip
 * is at least as fuzzy as the model reading it: case variants, stray
 * brackets or whitespace (including a spaced close like `<<</DATA> >`),
 * zero-width characters, and fullwidth/math look-alikes can all read as a
 * marker, so the pattern matches them all as classes. It never mutates
 * the content outside the matched span (stored fields keep their
 * original characters), and overmatching is harmless: these strings only
 * feed prompt copy or marker-echo removal, never parsed data.
 *
 * The junk/bracket quantifiers are bounded ({0,64} / {2,8}) so a crafted
 * 100k-character run can't blow up backtracking; no marker a model
 * actually reads as a fence has 64 separators inside it. Bounded
 * quantifiers keep the whole scan linear in the input.
 */

// Opening/closing bracket look-alikes a model plausibly reads as `<`/`>`.
const OPEN = "<＜⟨";
const CLOSE = ">＞⟩";
// Whitespace and invisible characters that read as separators.
const JUNK = "\\s\\u00ad\\u200b-\\u200f\\u2060\\ufeff";

/**
 * What a stripped marker leaves behind. Deleting the span outright would
 * also delete a name that merely looks like a marker (the row then reads as
 * unnamed and the text becomes unfilterable); a visible sentinel keeps the
 * fact that something was there, and is shorter than any field's bound so
 * nothing is truncated away by a later slice.
 */
export const FENCE_SENTINEL = "[removed]";

/** Neutralize anything shaped like a `<<<NAME>>>` marker, fuzzily. */
export function stripFenceMarkers(content: string, name: string): string {
  const word = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(
    new RegExp(
      `(?:[${OPEN}][${JUNK}]{0,64}){2,8}\\/?[${JUNK}]{0,64}${word}(?:[${JUNK}]{0,64}[${CLOSE}]){2,8}`,
      "gi",
    ),
    FENCE_SENTINEL,
  );
}
