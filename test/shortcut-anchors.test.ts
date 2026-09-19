import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACTION_SHORTCUTS } from "~/components/command-palette";
import { NAV_ITEMS } from "~/components/nav-items";

/**
 * The Shift+? hint layer fails SILENTLY when the wiring drifts: a
 * `data-shortcut="..."` anchor with a typo'd id renders no badge, and a
 * table entry without any anchor can never show one. These assertions pin
 * the source literals to ACTION_SHORTCUTS so the drift breaks a test
 * instead. Anchors added dynamically (PageShell's homeShortcut ternary)
 * are covered by scanning the lines that compute them.
 */

/** Every .tsx file under app/, as "path -> source". */
function appSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const path of globSync("app/**/*.tsx")) {
    sources.set(path, readFileSync(path, "utf8"));
  }
  return sources;
}

/** Ids referenced by data-shortcut attributes and the expressions that
 * compute them (lines mentioning data-shortcut or the PageShell's
 * homeShortcut), pulled from string literals on those lines, plus the nav
 * ids the home header renders from NAV_ITEMS (`data-shortcut={item.id}` is
 * not a literal on a data-shortcut line). */
function anchorIds(): Set<string> {
  const ids = new Set<string>();
  for (const item of NAV_ITEMS) ids.add(item.id);
  for (const source of appSources().values()) {
    for (const line of source.split("\n")) {
      if (!/data-shortcut|homeShortcut/.test(line)) continue;
      for (const m of line.matchAll(/"([a-z-]{2,})"/g)) ids.add(m[1]);
    }
  }
  return ids;
}

/** Actions whose badge can never render because no element carries their
 * anchor: export-report opens a submenu of report names, it drives no
 * single page element. */
const ANCHORLESS: Record<string, true> = { "export-report": true };

describe("shortcut anchor contract", () => {
  it("every data-shortcut anchor names a table entry", () => {
    const unknown = [...anchorIds()].filter((id) => !(id in ACTION_SHORTCUTS));
    expect(unknown).toEqual([]);
  });

  it("every table entry has an anchor (except the documented anchorless)", () => {
    const ids = anchorIds();
    const missing = Object.keys(ACTION_SHORTCUTS).filter(
      (id) => !ANCHORLESS[id] && !ids.has(id),
    );
    expect(missing).toEqual([]);
  });
});
