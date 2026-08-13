import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  DATE_TOLERANCE_DAYS,
  matchStatementRows,
  withinAmount,
} from "~/lib/reconcile.server";
import type { ReceiptExpense, StatementRow } from "~/lib/types";
import { ulid } from "ulid";

// Property-style tests for the reconciliation matcher: the amount and date
// tolerance boundaries and invariants that must hold for ANY statement
// rows / expense set, fuzzed with a deterministic PRNG. The matcher is
// pure and shared by the web flow and the MCP tool, so a bad tolerance or
// a refund that slips through an auto-match hits every surface at once.

// --- Fixtures --------------------------------------------------------------

const makeReceipt = (
  overrides: Partial<ReceiptExpense> = {},
): ReceiptExpense => ({
  id: ulid(),
  type: "receipt",
  date: "2026-01-15",
  report: "2026 Test",
  category: "Testing",
  description: "",
  amount: "42.50",
  merchant: "Test Store",
  imageFile: "receipt.jpg",
  imageMime: "image/jpeg",
  originalName: "receipt.jpg",
  reconciledAt: "",
  createdAt: "2026-01-16T00:00:00.000Z",
  updatedAt: "2026-01-16T00:00:00.000Z",
  ...overrides,
});

const makeRow = (overrides: Partial<StatementRow> = {}): StatementRow => ({
  index: 0,
  date: "2026-01-15",
  description: "TEST STORE PURCHASE",
  amount: "42.50",
  direction: "charge",
  source: "csv",
  raw: "2026-01-15,TEST STORE PURCHASE,42.50",
  ...overrides,
});

/** A date string offset `days` from 2026-01-01 (negative allowed). */
const dateAt = (days: number): string =>
  new Date(Date.UTC(2026, 0, 1) + days * 86_400_000).toISOString().slice(0, 10);

/** Deterministic PRNG (mulberry32) so the fuzz corpus is reproducible. */
function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Amount tolerance ------------------------------------------------------

describe("amount tolerance boundary (within $0.50 or 1%, whichever is larger)", () => {
  it("uses a flat $0.50 below the $50 crossover", () => {
    // $10.00: 1% = $0.10 < $0.50, so the tolerance is $0.50 flat.
    expect(withinAmount(new Decimal("10.50"), new Decimal("10.00"))).toBe(true);
    expect(withinAmount(new Decimal("10.51"), new Decimal("10.00"))).toBe(
      false,
    );
    expect(withinAmount(new Decimal("9.50"), new Decimal("10.00"))).toBe(true);
    // $49.99: 1% = $0.4999 < $0.50, still the flat $0.50.
    expect(withinAmount(new Decimal("50.49"), new Decimal("49.99"))).toBe(true);
    expect(withinAmount(new Decimal("50.50"), new Decimal("49.99"))).toBe(
      false,
    );
  });

  it("switches to 1% at exactly $50.00 (the tie goes to 1%)", () => {
    // $50.00: 1% = $0.50 == the flat amount; $50.01 tips into 1% = $0.5001.
    expect(withinAmount(new Decimal("50.50"), new Decimal("50.00"))).toBe(true);
    expect(withinAmount(new Decimal("50.51"), new Decimal("50.00"))).toBe(
      false,
    );
    expect(withinAmount(new Decimal("50.5101"), new Decimal("50.01"))).toBe(
      true,
    );
    expect(withinAmount(new Decimal("50.5102"), new Decimal("50.01"))).toBe(
      false,
    );
  });

  it("scales 1% above the crossover", () => {
    // $100.00: tolerance is $1.00 exactly.
    expect(withinAmount(new Decimal("101.00"), new Decimal("100.00"))).toBe(
      true,
    );
    expect(withinAmount(new Decimal("101.01"), new Decimal("100.00"))).toBe(
      false,
    );
    expect(withinAmount(new Decimal("99.00"), new Decimal("100.00"))).toBe(
      true,
    );
    expect(withinAmount(new Decimal("98.99"), new Decimal("100.00"))).toBe(
      false,
    );
    // $1,000.00: tolerance is $10.00 — tips and rounding must not slip in.
    expect(withinAmount(new Decimal("1010.00"), new Decimal("1000.00"))).toBe(
      true,
    );
    expect(withinAmount(new Decimal("1010.01"), new Decimal("1000.00"))).toBe(
      false,
    );
  });

  it("keeps tiny expenses matchable (flat $0.50 floor)", () => {
    // A $0.25 expense still tolerates the full $0.50 either way.
    expect(withinAmount(new Decimal("0.75"), new Decimal("0.25"))).toBe(true);
    expect(withinAmount(new Decimal("0.76"), new Decimal("0.25"))).toBe(false);
  });

  it("is exact for an exact amount", () => {
    expect(withinAmount(new Decimal("42.50"), new Decimal("42.50"))).toBe(true);
  });
});

// --- Date tolerance --------------------------------------------------------

describe("date tolerance boundary (±2 days)", () => {
  it("admits ±2 days as candidates, rejects ±3", () => {
    const expense = makeReceipt({ id: "e", date: "2026-01-15" });
    const cases: [number, "review" | "unmatched"][] = [
      [-2, "review"],
      [-1, "review"],
      [1, "review"],
      [2, "review"],
      [-3, "unmatched"],
      [3, "unmatched"],
    ];
    for (const [offset, expected] of cases) {
      const row = makeRow({ date: dateAt(14 + offset) }); // 2026-01-15 ± offset
      const matches = matchStatementRows([row], [expense]);
      expect(matches[0]!.status).toBe(expected);
    }
    expect(DATE_TOLERANCE_DAYS).toBe(2);
  });

  it("counts calendar days across month and year boundaries", () => {
    const expense = makeReceipt({ id: "e", date: "2026-02-28" });
    // Feb 28 → Mar 2 is 2 days (2026 is not a leap year); Mar 3 is 3.
    expect(
      matchStatementRows([makeRow({ date: "2026-03-02" })], [expense])[0]!
        .status,
    ).toBe("review");
    expect(
      matchStatementRows([makeRow({ date: "2026-03-03" })], [expense])[0]!
        .status,
    ).toBe("unmatched");
    // Year boundary: Dec 30 2026 → Jan 1 2027 is 2 days.
    const ny = makeReceipt({ id: "e", date: "2026-12-30" });
    expect(
      matchStatementRows([makeRow({ date: "2027-01-01" })], [ny])[0]!.status,
    ).toBe("review");
    expect(
      matchStatementRows([makeRow({ date: "2027-01-02" })], [ny])[0]!.status,
    ).toBe("unmatched");
  });
});

// --- Fuzzed invariants ------------------------------------------------------

describe("matcher invariants (fuzzed, deterministic)", () => {
  it("never auto-matches a refund, even against a perfectly matching expense", () => {
    const expense = makeReceipt({ id: "e", merchant: "Blue Bottle" });
    const refund = makeRow({
      description: "BLUE BOTTLE COFFEE",
      amount: "42.50",
      date: "2026-01-15",
      direction: "refund",
    });
    expect(matchStatementRows([refund], [expense])[0]!.status).toBe(
      "unmatched",
    );
  });

  it("holds across a random corpus: refunds unmatched, matched implies exact, deterministic", () => {
    const rand = mulberry32(0x5eed);
    const merchants = [
      "BLUE BOTTLE",
      "BLUE BOTTLE COFFEE",
      "OFFICE MAX",
      "OfficeMax",
      "RALPHS GROCERY",
      "H MART",
      "UNRELATED VENDOR",
      "STARBUCKS",
    ];
    const amounts = [
      "9.99",
      "25.00",
      "42.50",
      "50.00",
      "99.95",
      "126.50",
      "500.00",
    ];

    const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;

    for (let round = 0; round < 250; round++) {
      const expenses: ReceiptExpense[] = Array.from(
        { length: 1 + Math.floor(rand() * 5) },
        (_, i) =>
          makeReceipt({
            id: `e${round}-${i}`,
            date: dateAt(Math.floor(rand() * 60) - 30),
            amount: pick(amounts),
            merchant: pick(merchants),
            reconciledAt: rand() < 0.2 ? "2026-08-01T00:00:00.000Z" : "",
          }),
      );
      const rows: StatementRow[] = Array.from(
        { length: 1 + Math.floor(rand() * 8) },
        (_, i) =>
          makeRow({
            index: i,
            date: dateAt(Math.floor(rand() * 60) - 30),
            amount: pick(amounts),
            description: pick(merchants),
            direction: rand() < 0.3 ? "refund" : "charge",
            raw: `row-${round}-${i}`,
          }),
      );

      const matches = matchStatementRows(rows, expenses);
      expect(matches).toHaveLength(rows.length);

      for (const [i, match] of matches.entries()) {
        const row = rows[i]!;
        if (row.direction === "refund") {
          expect(match.status).toBe("unmatched");
          continue;
        }
        if (match.status === "matched") {
          // High confidence must mean exact date + exact amount + merchant
          // overlap — the matcher's own flags must agree with its verdict.
          expect(match.confidence).toBe("high");
          expect(match.candidate.exactDate).toBe(true);
          expect(match.candidate.exactAmount).toBe(true);
          expect(match.candidate.merchantOverlap).toBe(true);
        } else if (match.status === "review") {
          // Review only happens when at least one candidate was in range.
          expect(match.candidates.length).toBeGreaterThan(0);
        }
      }

      // Determinism: the same input must produce the identical verdicts.
      expect(matchStatementRows(rows, expenses)).toEqual(matches);
    }
  });
});
