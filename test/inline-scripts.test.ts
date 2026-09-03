import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { TIPS_SCRIPT, THEME_SCRIPT } from "~/root";

/**
 * The inline head scripts are static strings injected via
 * dangerouslySetInnerHTML, so tsc never parses their JS bodies: a malformed
 * edit ships silently. THEME_SCRIPT is the only thing that toggles the
 * `dark` class app-wide, so a SyntaxError there kills dark mode on every
 * page with no other symptom than a console error (this actually shipped).
 * Compiling with node:vm fails closed on any syntax error without running
 * the code.
 */
describe("inline head scripts parse", () => {
  it("THEME_SCRIPT is syntactically valid JS", () => {
    expect(() => new Script(THEME_SCRIPT)).not.toThrow();
  });

  it("TIPS_SCRIPT is syntactically valid JS", () => {
    expect(() => new Script(TIPS_SCRIPT)).not.toThrow();
  });
});
