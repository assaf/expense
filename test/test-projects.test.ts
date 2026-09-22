import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

/**
 * The unit project's `include` list and the main project's `exclude` list are
 * hand-maintained mirrors: a file added to one and not the other silently
 * stops running (or runs twice, once with a real DB it does not need). Nothing
 * asserted they agree until now. This reads both configs, extracts the file
 * lists, and pins the partition they form.
 */

const UNIT_CONFIG = "vitest.unit.config.ts";
const MAIN_CONFIG = "vitest.main.config.ts";
const TEST_FILE = /^test\/.+\.test\.tsx?$/;

/** The string literals of one array field, e.g. `include: [ … ]`. */
function listFrom(file: string, key: string): string[] {
  const src = readFileSync(file, "utf8");
  const at = src.indexOf(`${key}: [`);
  if (at === -1) throw new Error(`${file}: no \`${key}: [\` array`);
  const open = src.indexOf("[", at);
  const close = src.indexOf("]", open);
  if (close === -1) throw new Error(`${file}: unterminated \`${key}\` array`);
  return [...src.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

const unitInclude = listFrom(UNIT_CONFIG, "include");
const mainExclude = listFrom(MAIN_CONFIG, "exclude");

describe("vitest project partition", () => {
  it("has no duplicate entries in either list", () => {
    expect(new Set(unitInclude).size).toBe(unitInclude.length);
    expect(new Set(mainExclude).size).toBe(mainExclude.length);
  });

  it("lists the same files on both sides", () => {
    expect(new Set(mainExclude)).toEqual(new Set(unitInclude));
  });

  it("names only test files that exist on disk", () => {
    for (const entry of [...unitInclude, ...mainExclude]) {
      expect(entry).toMatch(TEST_FILE);
      expect(existsSync(entry), `${entry} is missing`).toBe(true);
    }
  });
});
