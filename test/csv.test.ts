import { describe, expect, it } from "vite-plus/test";
import fc from "fast-check";
import { parseCsv } from "~/lib/csv";
import { assertProperty, binary } from "./helpers/property";

/**
 * `app/lib/csv.ts` is the character-by-character state machine in front of
 * every bank-statement import and every hand-edited seed, and until now its
 * only assertions lived in `test/reconcile.test.ts` (the main project, real
 * Postgres). The properties below are derived from the module's documented
 * contract: RFC 4180-ish (quotes, doubled quotes, CRLF) with rows whose cells
 * are all blank dropped, so a trailing newline and a blank line between
 * entries are harmless.
 */

/** RFC 4180 writing, the reference `parseCsv` must invert. */
const encodeCell = (cell: string): string =>
  /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;

const encodeCsv = (rows: string[][]): string =>
  rows.map((row) => row.map(encodeCell).join(",")).join("\n");

/** The documented drop, applied by the writer so the round-trip has an
 * unambiguous expected value. */
const significant = (rows: string[][]): string[][] =>
  rows.filter((row) => row.some((cell) => cell.trim() !== ""));

describe("parseCsv properties", () => {
  it("never throws over arbitrary text", () => {
    // The signature already promises `string[][]`, so the only thing a
    // generated input can break here is totality: a bad row or an
    // out-of-range index would throw rather than return.
    assertProperty([binary(300)], (s) => {
      expect(() => parseCsv(s)).not.toThrow();
    });
  });

  it("round-trips an encoded grid", () => {
    const grid = fc.array(
      fc.array(fc.string({ maxLength: 12 }), { maxLength: 6 }),
      { maxLength: 6 },
    );
    assertProperty([grid], (rows) => {
      const kept = significant(rows);
      expect(parseCsv(encodeCsv(kept))).toEqual(kept);
    });
  });

  it("degenerates to a plain split without quotes or CR", () => {
    // With no `"` and no `\r` the state machine never enters quotes and
    // never has to collapse CRLF, so the reference is unambiguous: split on
    // newlines, split each line on commas, drop the all-blank lines.
    const plain = binary(200).filter(
      (text) => !text.includes('"') && !text.includes("\r"),
    );
    assertProperty([plain], (text) => {
      const expected = significant(
        text.split("\n").map((line) => line.split(",")),
      );
      expect(parseCsv(text)).toEqual(expected);
    });
  });
});
