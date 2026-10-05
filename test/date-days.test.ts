import { describe, expect, it } from "vite-plus/test";
import fc from "fast-check";
import { daysBetween, shiftDays } from "~/lib/date-days";
import { assertProperty, text, validDate } from "./helpers/property";

/**
 * `app/lib/date-days.ts` is the shared UTC-day arithmetic for the warranty
 * expiry groups, the reconcile tolerance checks and the insight starters, and
 * it had no direct test. The properties below hold for every date on the
 * calendar, which is the input class the round-trips need.
 */

const dayShift = fc.integer({ min: -3650, max: 3650 });

/** Anything the module's shape regex rejects, so the malformed path is what
 * actually runs. `text` reaches the ASCII the regex needs to almost-match. */
const notADate = (maxLength: number): fc.Arbitrary<string> =>
  text(maxLength).filter((s) => !/^\d{4}-\d{2}-\d{2}$/.test(s));

describe("date-days properties", () => {
  it("is zero from a date to itself", () => {
    assertProperty([validDate], (date) => {
      expect(daysBetween(date, date)).toBe(0);
    });
  });

  it("is antisymmetric", () => {
    // Both inputs are exact UTC-midnight instants, so the division is exact
    // and Math.round is the identity: no DST or leap-second fuzz here.
    assertProperty([validDate, validDate], (a, b) => {
      // Summed rather than compared against a negation: daysBetween(d, d) is
      // 0 and its negation is -0, which `toBe` separates via Object.is even
      // though the two are the same number.
      expect(daysBetween(a, b)! + daysBetween(b, a)!).toBe(0);
    });
  });

  it("counts a shift and undoes it", () => {
    assertProperty([validDate, dayShift], (date, days) => {
      expect(daysBetween(date, shiftDays(date, days))).toBe(days);
      expect(shiftDays(shiftDays(date, days), -days)).toBe(date);
    });
  });

  it("echoes a malformed date unchanged and measures nothing", () => {
    assertProperty([notADate(12)], (s) => {
      expect(shiftDays(s, 5)).toBe(s);
      expect(daysBetween(s, "2026-01-01")).toBeNull();
    });
  });

  it("rolls an impossible date forward rather than rejecting it", () => {
    // An anchor, not a property: `utcDay` builds Date.UTC(y, m - 1, d), so
    // the parser is a formatter, not a validator. `isCalendarDate` in
    // `~/lib/validation` is the validator that catches this.
    expect(daysBetween("2026-02-31", "2026-03-03")).toBe(0);
  });
});
