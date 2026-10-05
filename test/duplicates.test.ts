import { describe, expect, it } from "vite-plus/test";
import fc from "fast-check";
import {
  duplicateLabel,
  duplicatePairKey,
  findDuplicates,
  groupDuplicateMatches,
  normalizeMerchant,
  type DuplicateMatch,
} from "~/lib/duplicates";
import type { MileageExpense, ReceiptExpense } from "~/lib/types";
import { assertProperty, binary } from "./helpers/property";

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
  imageSha256: "",
  currency: "USD",
  originalAmount: "",
  fxRate: "",
  reconciledAt: "",
  createdAt: "2026-01-16T00:00:00.000Z",
  updatedAt: "2026-01-16T00:00:00.000Z",
  ...overrides,
});

const makeMileage = (
  overrides: Partial<MileageExpense> = {},
): MileageExpense => ({
  id: "m1",
  type: "mileage",
  mileageType: "business",
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
  roundTrip: true,
  route: { coords: [], returnCoords: [] },
  reconciledAt: "",
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

  it("treats category, report, and description as equal-unless-different", () => {
    // Both empty → still duplicates.
    const bare = makeReceipt({
      id: "old",
      category: "",
      report: "",
      description: "",
    });
    expect(
      findDuplicates(
        makeReceipt({ id: "new", category: "", report: "", description: "" }),
        [bare],
      ),
    ).toHaveLength(1);
    // Identical values → duplicates.
    expect(
      findDuplicates(makeReceipt({ id: "new" }), [makeReceipt()]),
    ).toHaveLength(1);
    // Any difference (including one side empty) breaks the pair.
    expect(
      findDuplicates(makeReceipt({ id: "new", category: "Software" }), [
        makeReceipt(),
      ]),
    ).toHaveLength(0);
    expect(
      findDuplicates(makeReceipt({ id: "new", report: "Other" }), [
        makeReceipt(),
      ]),
    ).toHaveLength(0);
    expect(
      findDuplicates(makeReceipt({ id: "new", description: "#99-001" }), [
        makeReceipt(),
      ]),
    ).toHaveLength(0);
    expect(
      findDuplicates(makeReceipt({ id: "new", description: "#99-001" }), [
        makeReceipt({ id: "old", description: "#99-002" }),
      ]),
    ).toHaveLength(0);
  });

  it("compares category and report case-insensitively, description exactly", () => {
    expect(
      findDuplicates(
        makeReceipt({ id: "new", category: " testing ", report: "2026 test" }),
        [makeReceipt()],
      ),
    ).toHaveLength(1);
    expect(
      findDuplicates(
        makeReceipt({ id: "new", description: "#99-001 — ZHED media LLC" }),
        [makeReceipt({ id: "old", description: "#99-001 — ZHED Media LLC" })],
      ),
    ).toHaveLength(0);
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

describe("image fingerprint matching", () => {
  it("matches the same image bytes across different fields", () => {
    const a = makeReceipt({
      id: "a",
      imageSha256: "h1",
      merchant: "A",
      amount: "1.00",
      date: "2026-01-01",
    });
    const b = makeReceipt({
      id: "b",
      imageSha256: "h1",
      merchant: "B",
      amount: "9.99",
      date: "2026-02-02",
    });
    const matches = findDuplicates(b, [a]);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ expense: a, reason: "same-image" });
  });

  it("reports a pair sharing image and content once, as same-image", () => {
    const a = makeReceipt({ id: "a", imageSha256: "h1" });
    const b = makeReceipt({ id: "b", imageSha256: "h1" });
    const matches = findDuplicates(b, [a]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.reason).toBe("same-image");
    const groups = groupDuplicateMatches([a, b]);
    expect(groups.get("a")).toHaveLength(1);
    expect(groups.get("b")).toHaveLength(1);
  });

  it("falls back to the content key for rows without a fingerprint", () => {
    const a = makeReceipt({ id: "a", imageSha256: "" });
    const b = makeReceipt({ id: "b", imageSha256: "" });
    const matches = findDuplicates(b, [a]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.reason).toBe("same-date-merchant-amount");
  });

  it("different fingerprints with the same content still match on content", () => {
    const a = makeReceipt({ id: "a", imageSha256: "h1" });
    const b = makeReceipt({ id: "b", imageSha256: "h2" });
    const matches = findDuplicates(b, [a]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.reason).toBe("same-date-merchant-amount");
  });
});

/**
 * `app/lib/duplicates.ts` decides which rows a user is told are the same
 * entry, and it reaches that decision through a key bucket, a per-direction
 * `reported` set and a `dismissed` filter. The properties below check the
 * invariants those three depend on, over generated rows built from the same
 * `makeReceipt` / `makeMileage` factories the hand-written cases use.
 */

/** Ids come from a large space so two rows rarely share one. */
const id = fc.stringMatching(/^[a-z]{1,4}$/);

const ROUTES: MileageExpense["locations"][] = [
  [
    { address: "Home", lat: 34.05, lng: -118.24 },
    { address: "Client Office", lat: 34.06, lng: -118.25 },
  ],
  [
    { address: "Client Office", lat: 34.06, lng: -118.25 },
    { address: "Home", lat: 34.05, lng: -118.24 },
  ],
];

const receiptShape = {
  date: fc.constantFrom("2026-01-15", "2026-03-10"),
  merchant: fc.constantFrom("Blue Bottle Coffee", "blue  bottle coffee"),
  amount: fc.constantFrom("42.50", "42.5"),
  category: fc.constantFrom("Testing", " testing "),
  description: fc.constantFrom("", "note"),
};

const mileageShape = {
  date: fc.constantFrom("2026-03-10", "2026-07-02"),
  distanceMiles: fc.constantFrom("32.00", "32", "1.00"),
  // A route needs two non-empty addresses in order to key at all, so both a
  // matching and a reversed route are in the pool.
  locations: fc.constantFrom(...ROUTES),
};

const receipt: fc.Arbitrary<ReceiptExpense> = fc
  .record({ id, ...receiptShape })
  .map((over) => makeReceipt(over));

const mileage: fc.Arbitrary<MileageExpense> = fc
  .record({ id, ...mileageShape })
  .map((over) => makeMileage(over));

const row: fc.Arbitrary<ReceiptExpense | MileageExpense> = fc.oneof(
  receipt,
  mileage,
);

/** The same row under a fresh id: a guaranteed duplicate. Without it a
 * generated list matches a given candidate only about 4% of the time per
 * pair, so these properties ran mostly against empty match lists. */
const twin = fc
  .tuple(row, id)
  .map(([base, otherId]) => ({ ...base, id: otherId }));

/** Rows to match a candidate against: mostly real duplicates, some not. */
const others: fc.Arbitrary<(ReceiptExpense | MileageExpense)[]> = fc.array(
  fc.oneof({ arbitrary: twin, weight: 3 }, { arbitrary: row, weight: 2 }),
  { maxLength: 6 },
);

/** Each group reduced to its sorted expense ids. Order within a group follows
 * bucket insertion, so only the multiset is order-independent. */
const matchIds = (
  groups: Map<string, DuplicateMatch[]>,
): Map<string, string[]> =>
  new Map(
    [...groups].map(([key, list]) => [
      key,
      list.map((m) => m.expense.id).sort(),
    ]),
  );

describe("app/lib/duplicates.ts properties", () => {
  it("builds the same pair key in either direction", () => {
    assertProperty([id, id], (a, b) => {
      expect(duplicatePairKey(a, b)).toBe(duplicatePairKey(b, a));
    });
  });

  it("normalizes a merchant idempotently", () => {
    assertProperty([binary(24)], (m) => {
      const once = normalizeMerchant(m);
      expect(normalizeMerchant(once)).toBe(once);
    });
  });

  it("never matches a candidate to itself", () => {
    assertProperty([row, others], (candidate, others) => {
      for (const match of findDuplicates(candidate, others)) {
        expect(match.expense.id).not.toBe(candidate.id);
      }
    });
  });

  it("only ever removes matches when dismissed", () => {
    // The dismissed set is drawn from the real match list rather than from
    // generated ids: a random id lands on a real pair about 4% of the time,
    // so a property keyed on generated ids would never exercise the filter.
    assertProperty(
      [row, others, fc.array(fc.boolean(), { maxLength: 4 })],
      (candidate, others, dismissFlags) => {
        const all = findDuplicates(candidate, others);
        const dismissed = new Set(
          all
            .filter((_, i) => dismissFlags[i])
            .map((m) => duplicatePairKey(candidate.id, m.expense.id)),
        );
        expect(findDuplicates(candidate, others, dismissed)).toEqual(
          all.filter(
            (m) => !dismissed.has(duplicatePairKey(candidate.id, m.expense.id)),
          ),
        );
      },
    );
  });

  it("empties the match list when every pair is dismissed", () => {
    assertProperty([row, others], (candidate, others) => {
      const dismissed = new Set(
        findDuplicates(candidate, others).map((m) =>
          duplicatePairKey(candidate.id, m.expense.id),
        ),
      );
      expect(findDuplicates(candidate, others, dismissed)).toHaveLength(0);
    });
  });

  it("groups the same pairs regardless of input order", () => {
    assertProperty([others], (list) => {
      expect(matchIds(groupDuplicateMatches([...list].reverse()))).toEqual(
        matchIds(groupDuplicateMatches(list)),
      );
    });
  });
});
