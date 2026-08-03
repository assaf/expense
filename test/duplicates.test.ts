import { describe, expect, it } from "vitest";
import {
  duplicateLabel,
  duplicatePairKey,
  findDuplicates,
  groupDuplicateMatches,
} from "~/lib/duplicates";
import type { MileageExpense, ReceiptExpense } from "~/lib/types";

const makeReceipt = (
  overrides: Partial<ReceiptExpense> = {},
): ReceiptExpense => ({
  id: "r1",
  type: "receipt",
  date: "2026-01-15",
  report: "2026 Test",
  category: "Testing",
  description: "",
  amount: "42.50",
  merchant: "Blue Bottle Coffee",
  imageFile: "receipt.jpg",
  imageMime: "image/jpeg",
  originalName: "receipt.jpg",
  createdAt: "2026-01-16T00:00:00.000Z",
  updatedAt: "2026-01-16T00:00:00.000Z",
  ...overrides,
});

const makeMileage = (
  overrides: Partial<MileageExpense> = {},
): MileageExpense => ({
  id: "m1",
  type: "mileage",
  date: "2026-03-10",
  report: "2026 Test",
  category: "Travel",
  description: "",
  amount: "22.40",
  locations: [
    { address: "Home", lat: 34.05, lng: -118.24 },
    { address: "Client Office", lat: 34.06, lng: -118.25 },
  ],
  distanceMiles: "32.00",
  createdAt: "2026-03-11T00:00:00.000Z",
  updatedAt: "2026-03-11T00:00:00.000Z",
  ...overrides,
});

describe("Receipt duplicates", () => {
  it("matches the same date, merchant, and amount", () => {
    const matches = findDuplicates(makeReceipt({ id: "new" }), [makeReceipt()]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.reason).toBe("same-date-merchant-amount");
    expect(matches[0]!.expense.id).toBe("r1");
  });

  it("is insensitive to merchant case and whitespace", () => {
    const matches = findDuplicates(
      makeReceipt({ id: "new", merchant: "  blue   BOTTLE coffee " }),
      [makeReceipt()],
    );
    expect(matches).toHaveLength(1);
  });

  it("compares amounts exactly regardless of trailing zeros", () => {
    const matches = findDuplicates(makeReceipt({ id: "new", amount: "42.5" }), [
      makeReceipt(),
    ]);
    expect(matches).toHaveLength(1);
  });

  it("does not match the same merchant+amount on a different day", () => {
    // The recurring-charge guard: Netflix every month must never warn.
    const matches = findDuplicates(
      makeReceipt({ id: "new", date: "2026-02-15" }),
      [makeReceipt()],
    );
    expect(matches).toHaveLength(0);
  });

  it("does not match a different merchant the same day at the same price", () => {
    const matches = findDuplicates(
      makeReceipt({ id: "new", merchant: "Other Shop" }),
      [makeReceipt()],
    );
    expect(matches).toHaveLength(0);
  });

  it("does not match a different amount", () => {
    const matches = findDuplicates(
      makeReceipt({ id: "new", amount: "43.50" }),
      [makeReceipt()],
    );
    expect(matches).toHaveLength(0);
  });

  it("never matches a refund against a charge of the same size", () => {
    const matches = findDuplicates(
      makeReceipt({ id: "new", amount: "-42.50" }),
      [makeReceipt()],
    );
    expect(matches).toHaveLength(0);
  });

  it("does not match receipts missing a merchant or amount", () => {
    expect(
      findDuplicates(makeReceipt({ id: "new", merchant: "" }), [makeReceipt()]),
    ).toHaveLength(0);
    expect(
      findDuplicates(makeReceipt({ id: "new", amount: "" }), [makeReceipt()]),
    ).toHaveLength(0);
    // And an incomplete existing receipt can't be matched either.
    expect(
      findDuplicates(makeReceipt({ id: "new" }), [
        makeReceipt({ id: "old", merchant: "" }),
      ]),
    ).toHaveLength(0);
  });

  it("does not match dateless receipts", () => {
    const matches = findDuplicates(makeReceipt({ id: "new", date: "" }), [
      makeReceipt(),
    ]);
    expect(matches).toHaveLength(0);
  });
});

describe("Mileage duplicates", () => {
  it("matches the same date, route, and distance", () => {
    const matches = findDuplicates(makeMileage({ id: "new" }), [makeMileage()]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.reason).toBe("same-route");
  });

  it("does not match a reversed route (A→B is not B→A)", () => {
    const matches = findDuplicates(
      makeMileage({
        id: "new",
        locations: [
          { address: "Client Office", lat: 34.06, lng: -118.25 },
          { address: "Home", lat: 34.05, lng: -118.24 },
        ],
      }),
      [makeMileage()],
    );
    expect(matches).toHaveLength(0);
  });

  it("does not match the same route on a different day (commutes)", () => {
    const matches = findDuplicates(
      makeMileage({ id: "new", date: "2026-03-11" }),
      [makeMileage()],
    );
    expect(matches).toHaveLength(0);
  });

  it("does not match a different distance on the same route", () => {
    const matches = findDuplicates(
      makeMileage({ id: "new", distanceMiles: "33.00" }),
      [makeMileage()],
    );
    expect(matches).toHaveLength(0);
  });

  it("does not match a trip with a single stop", () => {
    const matches = findDuplicates(
      makeMileage({
        id: "new",
        locations: [{ address: "Home", lat: null, lng: null }],
      }),
      [makeMileage()],
    );
    expect(matches).toHaveLength(0);
  });
});

describe("findDuplicates basics", () => {
  it("never matches an expense to itself", () => {
    const same = makeReceipt();
    expect(findDuplicates(same, [same])).toHaveLength(0);
  });

  it("never matches across types", () => {
    const receipt = makeReceipt({ id: "new", amount: "22.40" });
    const matches = findDuplicates(receipt, [makeMileage()]);
    expect(matches).toHaveLength(0);
  });

  it("honors dismissed pairs in either direction", () => {
    const dismissed = new Set([duplicatePairKey("new", "r1")]);
    expect(
      findDuplicates(makeReceipt({ id: "new" }), [makeReceipt()], dismissed),
    ).toHaveLength(0);
    expect(
      findDuplicates(
        makeReceipt({ id: "r1" }),
        [makeReceipt({ id: "new" })],
        dismissed,
      ),
    ).toHaveLength(0);
  });

  it("returns the oldest match first", () => {
    const matches = findDuplicates(makeReceipt({ id: "new" }), [
      makeReceipt({ id: "newer", createdAt: "2026-02-01T00:00:00.000Z" }),
      makeReceipt({ id: "older", createdAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(matches.map((m) => m.expense.id)).toEqual(["older", "newer"]);
  });
});

describe("groupDuplicateMatches", () => {
  it("badges both sides of a pair", () => {
    const a = makeReceipt({ id: "a" });
    const b = makeReceipt({ id: "b" });
    const groups = groupDuplicateMatches([a, b]);
    expect(groups.get("a")?.map((m) => m.expense.id)).toEqual(["b"]);
    expect(groups.get("b")?.map((m) => m.expense.id)).toEqual(["a"]);
  });

  it("badges every member of a triple", () => {
    const a = makeReceipt({ id: "a" });
    const b = makeReceipt({ id: "b" });
    const c = makeReceipt({ id: "c" });
    const groups = groupDuplicateMatches([a, b, c]);
    expect(groups.get("a")).toHaveLength(2);
    expect(groups.get("b")).toHaveLength(2);
    expect(groups.get("c")).toHaveLength(2);
  });

  it("a dismissal removes both badges", () => {
    const a = makeReceipt({ id: "a" });
    const b = makeReceipt({ id: "b" });
    const c = makeReceipt({ id: "c" });
    const dismissed = new Set([duplicatePairKey("a", "b")]);
    const groups = groupDuplicateMatches([a, b, c], dismissed);
    expect(groups.get("a")?.map((m) => m.expense.id)).toEqual(["c"]);
    expect(groups.get("b")?.map((m) => m.expense.id)).toEqual(["c"]);
    expect(groups.get("c")).toHaveLength(2);
  });

  it("leaves non-matching rows out", () => {
    const a = makeReceipt({ id: "a" });
    const b = makeReceipt({ id: "b", merchant: "Different" });
    const groups = groupDuplicateMatches([a, b]);
    expect(groups.size).toBe(0);
  });

  it("ignores rows too incomplete to key", () => {
    const a = makeReceipt({ id: "a" });
    const b = makeReceipt({ id: "b", merchant: "" });
    const c = makeReceipt({ id: "c", date: "" });
    const groups = groupDuplicateMatches([a, b, c]);
    expect(groups.size).toBe(0);
  });
});

describe("duplicate helpers", () => {
  it("pair keys are order-independent", () => {
    expect(duplicatePairKey("b", "a")).toBe(duplicatePairKey("a", "b"));
  });

  it("labels a receipt match", () => {
    expect(duplicateLabel(makeReceipt())).toBe(
      "Blue Bottle Coffee, Jan 15, 2026, $42.50",
    );
  });

  it("labels a mileage match", () => {
    expect(duplicateLabel(makeMileage())).toBe(
      "a 32.00 mi trip on Mar 10, 2026",
    );
  });
});
