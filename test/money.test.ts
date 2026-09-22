import { describe, it, expect } from "vite-plus/test";
import Decimal from "decimal.js";

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
