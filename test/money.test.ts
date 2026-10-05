import { describe, it, expect } from "vite-plus/test";
import fc from "fast-check";
import Decimal from "decimal.js";
import { exceedsMaxMoney, parseAmount } from "~/lib/money";
import { assertProperty, moneyAmount, text } from "./helpers/property";

describe("Decimal money math", () => {
  it("adds without IEEE 754 drift (0.1 + 0.2 = 0.3 exactly)", () => {
    const sum = new Decimal("0.1").add("0.2");
    expect(sum.toString()).toBe("0.3");
    // JS float addition would produce 0.30000000000000004.
    expect(sum.isFinite()).toBe(true);
  });

  it("multiplies with exact decimal precision", () => {
    // 122.15 × 0.70 = 85.505, exactly.
    const product = new Decimal("122.15").mul("0.70");
    expect(product.toString()).toBe("85.505");
  });

  it("isZero detects true zero and nothing else", () => {
    expect(new Decimal("0").isZero()).toBe(true);
    expect(new Decimal("0.00").isZero()).toBe(true);
    expect(new Decimal("0.01").isZero()).toBe(false);
    expect(new Decimal("-0").isZero()).toBe(true);
  });

  it("toFixed(2) rounds half-up (the app standard)", () => {
    // Decimal.toFixed defaults to ROUND_HALF_UP (bankers' rounding is opt-in).
    expect(new Decimal("1.005").toFixed(2)).toBe("1.01");
    expect(new Decimal("1.004").toFixed(2)).toBe("1.00");
    expect(new Decimal("85.505").toFixed(2)).toBe("85.51");
    expect(new Decimal("85.504").toFixed(2)).toBe("85.50");
  });

  it("parses zero with trailing decimals — toString drops trailing zeros", () => {
    const d = new Decimal("0.00");
    expect(d.toString()).toBe("0");
    expect(d.isZero()).toBe(true);
    expect(d.toFixed(2)).toBe("0.00");
  });

  it("preserves exact values from normalizeAmount output", () => {
    // Regression guard: the format and money paths must agree on the
    // exact string representations that pass between them.
    const parsed = new Decimal("42.50");
    expect(parsed.toString()).toBe("42.5");
    expect(parsed.toFixed(2)).toBe("42.50");
  });
});

/** The spellings decimal.js accepts but no money column can hold: it parses
 * each one with `e` set to NaN, so the `e > 15` bound does not catch them.
 * Random strings never spell them, so the property would be vacuous without
 * seeding them explicitly. */
const nonFinite = fc.constantFrom(
  "NaN",
  "+NaN",
  "-NaN",
  "Infinity",
  "+Infinity",
  "-Infinity",
);

/** An arbitrary amount string: arbitrary text, plus the non-finite shapes. */
const amountString: fc.Arbitrary<string> = fc.oneof(text(40), nonFinite);

describe("app/lib/money.ts properties", () => {
  it("bounds the exponent an amount may carry", () => {
    // The documented bound is `parsed.e > 15`: e-notation with a huge positive
    // exponent would expand to a heap-killing string in toFixed.
    assertProperty([fc.integer({ min: 0, max: 40 })], (n) => {
      if (n > 15) expect(parseAmount(`1e${n}`)).toBeNull();
      else expect(parseAmount(`1e${n}`)).not.toBeNull();
    });
  });

  it("parses a negated amount as the negation, with the same sizeness", () => {
    assertProperty([moneyAmount], (s) => {
      const positive = parseAmount(s);
      expect(positive).not.toBeNull();
      expect(parseAmount(`-${s}`)!.eq(positive!.neg())).toBe(true);
      expect(exceedsMaxMoney(`-${s}`)).toBe(exceedsMaxMoney(s));
    });
  });

  it("never returns a non-finite or over-scale Decimal", () => {
    // This property is what caught the gap: `parseAmount` now rejects a
    // non-finite value before the exponent check.
    assertProperty([amountString], (s) => {
      const parsed = parseAmount(s);
      if (parsed === null) return;
      expect(parsed.isFinite()).toBe(true);
      expect(parsed.e).not.toBeGreaterThan(15);
    });
  });

  it("treats unparseable input as junk rather than as too large", () => {
    assertProperty([amountString], (s) => {
      const parsed = parseAmount(s);
      if (parsed !== null) return;
      expect(exceedsMaxMoney(s)).toBe(false);
    });
  });
});
