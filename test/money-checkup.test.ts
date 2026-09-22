import { describe, expect, it } from "vite-plus/test";
import { duplicatePairKey } from "~/lib/duplicates";
import type { InsightExpense } from "~/lib/insights";
import {
  checkupText,
  moneyCheckup,
  NOTHING_OUTSTANDING,
  type Checkup,
  type CheckupFinding,
} from "~/lib/money-checkup";

/** The window every test but the pace and drift ones shares: this
 * calendar year through July 15, which is the suite's pinned clock. */
const TODAY = "2026-07-15";

/** One snapshot row. The defaults are a tidy receipt in the window (a
 * category, a report, an image), so a test only spells out what its
 * finding is about. A blank merchant never matches a duplicate. */
function row(fields: Partial<InsightExpense> = {}): InsightExpense {
  return {
    id: "e1",
    type: "receipt",
    merchant: "",
    mileageType: "business",
    locations: [],
    description: "",
    category: "Software",
    report: "2026",
    amount: "10.00",
    date: "2026-03-01",
    hasImage: true,
    distanceMiles: "",
    imageSha256: "",
    ...fields,
  };
}

function run(
  expenses: InsightExpense[],
  dismissed?: ReadonlySet<string>,
): Checkup {
  return moneyCheckup({ expenses, today: TODAY, dismissed });
}

function kinds(checkup: Checkup): string[] {
  return checkup.findings.map((f) => f.kind);
}

function finding(checkup: Checkup, kind: string): CheckupFinding {
  const found = checkup.findings.find((f) => f.kind === kind);
  expect(found, `expected a ${kind} finding`).toBeDefined();
  return found!;
}

describe("moneyCheckup window", () => {
  it("counts this calendar year through the caller's today, and nothing else", () => {
    const checkup = run([
      // Last year, and the day after today: out.
      row({ id: "old", date: "2025-12-31", amount: "99.00" }),
      row({ id: "future", date: "2026-07-16", amount: "99.00" }),
      // No date at all: in no window.
      row({ id: "undated", date: "", amount: "99.00" }),
      row({ id: "first", date: "2026-01-01", amount: "10.00" }),
      row({ id: "last", date: "2026-07-15", amount: "5.50" }),
    ]);
    expect(checkup.since).toBe("2026-01-01");
    expect(checkup.until).toBe("2026-07-15");
    expect(checkup.count).toBe(2);
    expect(checkup.spent).toBe(15.5);
  });

  it("returns an empty checkup when today is not a date", () => {
    const checkup = moneyCheckup({
      expenses: [row({ amount: "10.00", category: "" })],
      today: "July 15",
    });
    expect(checkup.count).toBe(0);
    expect(checkup.spent).toBe(0);
    expect(checkup.findings).toEqual([]);
    expect(checkup.pace).toBeNull();
  });

  it("orders the findings by what a claim needs first", () => {
    const checkup = run([
      // One row per finding, all in the window except the undated one.
      row({ id: "undated", date: "" }),
      row({ id: "flat", date: "2026-02-01", category: "" }),
      row({ id: "unfiled", date: "2026-03-01", report: "" }),
      row({
        id: "dup-a",
        date: "2026-04-01",
        merchant: "Blue Bottle",
        imageSha256: "abc",
      }),
      row({
        id: "dup-b",
        date: "2026-04-01",
        merchant: "Blue Bottle",
        imageSha256: "abc",
      }),
      row({ id: "imageless", date: "2026-05-01", hasImage: false }),
      row({ id: "trip", date: "2025-05-01", type: "mileage", amount: "9.94" }),
    ]);
    expect(kinds(checkup)).toEqual([
      "incomplete",
      "no-category",
      "no-report",
      "duplicates",
      "no-image",
      "drift",
      "mileage",
    ]);
  });
});

describe("incomplete rows", () => {
  it("counts a missing amount or date anywhere in the account", () => {
    const checkup = run([
      row({ id: "no-date", date: "", amount: "12.00" }),
      row({ id: "no-amount", date: "2025-03-01", amount: "" }),
      row({ id: "fine" }),
    ]);
    const incomplete = finding(checkup, "incomplete");
    expect(incomplete.title).toBe("2 expenses are missing an amount or a date");
    expect(incomplete.count).toBe(2);
    // The one figure that is there still sums.
    expect(incomplete.amount).toBe(12);
  });

  it("says it in the singular for one row", () => {
    const incomplete = finding(
      run([row({ id: "no-amount", amount: "" })]),
      "incomplete",
    );
    expect(incomplete.title).toBe("1 expense is missing an amount or a date");
  });
});

describe("missing category and report", () => {
  it("totals the year's uncategorized rows and links the newest three", () => {
    const checkup = run([
      row({
        id: "a",
        date: "2026-02-01",
        amount: "12.40",
        category: "",
        merchant: "OfficeMax",
      }),
      row({
        id: "b",
        date: "2026-05-01",
        amount: "200.00",
        category: "  ",
        merchant: "Alaska Airlines",
      }),
      row({ id: "c", date: "2026-06-01", amount: "1.00", category: "" }),
      row({ id: "d", date: "2026-07-01", amount: "9.00", category: "" }),
      row({ id: "e", date: "2026-07-02", amount: "9.00", category: "Meals" }),
    ]);
    const uncategorized = finding(checkup, "no-category");
    expect(uncategorized.title).toBe(
      "4 expenses worth $222.40 with no category",
    );
    expect(uncategorized.count).toBe(4);
    expect(uncategorized.amount).toBe(222.4);
    // Newest first, three of them, labeled and priced for the link text.
    expect(uncategorized.links.map((l) => l.id)).toEqual(["d", "c", "b"]);
    expect(uncategorized.links[2]).toEqual({
      id: "b",
      label: "Alaska Airlines",
      amount: "$200.00",
    });
  });

  it("points unreported rows at the reports page", () => {
    const checkup = run([row({ id: "a", report: "" })]);
    const unreported = finding(checkup, "no-report");
    expect(unreported.title).toBe("1 expense worth $10.00 in no report");
    expect(unreported.action).toEqual({
      label: "Open reports",
      href: "/export",
    });
  });
});

describe("suspected duplicates", () => {
  const blueBottle = (id: string, date: string): InsightExpense =>
    row({
      id,
      date,
      merchant: "Blue Bottle",
      amount: "6.50",
      category: "Meals",
      report: "",
      description: "coffee",
    });

  it("counts a pair once, at the earlier row's amount", () => {
    const checkup = run([
      blueBottle("a1", "2026-04-02"),
      blueBottle("b2", "2026-04-02"),
      // A third copy is a second pair, from the same evidence.
      blueBottle("c3", "2026-04-02"),
    ]);
    const duplicates = finding(checkup, "duplicates");
    expect(duplicates.title).toBe("3 suspected duplicate pairs worth $19.50");
    expect(duplicates.count).toBe(3);
    expect(duplicates.links.map((l) => l.amount)).toEqual([
      "$6.50",
      "$6.50",
      "$6.50",
    ]);
  });

  it("leaves a pair the account dismissed out of the finding", () => {
    const dismissed = new Set([duplicatePairKey("a1", "b2")]);
    const checkup = run(
      [blueBottle("a1", "2026-04-02"), blueBottle("b2", "2026-04-02")],
      dismissed,
    );
    expect(kinds(checkup)).not.toContain("duplicates");
  });
});

describe("receipts with no image", () => {
  it("counts receipts only: a trip is exempt", () => {
    const checkup = run([
      row({ id: "imageless", date: "2026-02-01", hasImage: false }),
      row({ id: "with-image", date: "2026-02-02", merchant: "Z.ai" }),
      row({
        id: "trip",
        date: "2026-03-01",
        type: "mileage",
        amount: "9.94",
        hasImage: false,
      }),
    ]);
    const noImage = finding(checkup, "no-image");
    expect(noImage.title).toBe("1 expense worth $10.00 with no image on file");
    expect(noImage.count).toBe(1);
  });
});

describe("repeating charges", () => {
  it("finds a monthly cadence and prices the year from the median month", () => {
    const checkup = run([
      row({
        id: "n1",
        date: "2026-01-10",
        merchant: "Northwind Hosting",
        amount: "24.00",
      }),
      row({
        id: "n2",
        date: "2026-02-09",
        merchant: "northwind  hosting",
        amount: "24.00",
      }),
      row({
        id: "n3",
        date: "2026-03-11",
        merchant: "Northwind Hosting",
        amount: "25.00",
      }),
      row({
        id: "a1",
        date: "2026-04-01",
        merchant: "Acme Cloud",
        amount: "45.00",
      }),
      row({
        id: "a2",
        date: "2026-05-01",
        merchant: "Acme Cloud",
        amount: "45.00",
      }),
      row({
        id: "a3",
        date: "2026-06-01",
        merchant: "Acme Cloud",
        amount: "45.00",
      }),
    ]);
    const recurring = finding(checkup, "recurring");
    // Northwind's median month is $24.00 (the $25.00 month does not
    // inflate it), Acme's $45.00: $288.00 + $540.00.
    expect(recurring.title).toBe(
      "2 charges that repeat monthly, $828.00 a year",
    );
    expect(recurring.count).toBe(2);
    expect(recurring.amount).toBe(828);
    expect(recurring.facts).toBe(
      "Acme Cloud $45.00/mo, Northwind Hosting $24.00/mo",
    );
    // The link is the most recent charge, priced at the monthly figure.
    expect(recurring.links).toEqual([
      { id: "a3", label: "Acme Cloud", amount: "$45.00/mo" },
      { id: "n3", label: "Northwind Hosting", amount: "$24.00/mo" },
    ]);
  });

  it("stays quiet about a steady cadence that is not a month", () => {
    const checkup = run([
      row({ id: "g1", date: "2026-01-01", merchant: "Gas", amount: "40.00" }),
      row({ id: "g2", date: "2026-01-11", merchant: "Gas", amount: "40.00" }),
      row({ id: "g3", date: "2026-01-21", merchant: "Gas", amount: "40.00" }),
    ]);
    expect(kinds(checkup)).not.toContain("recurring");
  });

  it("stays quiet when the monthly prices are not steady", () => {
    const checkup = run([
      row({ id: "s1", date: "2026-01-01", merchant: "Host", amount: "20.00" }),
      row({ id: "s2", date: "2026-01-31", merchant: "Host", amount: "20.00" }),
      row({ id: "s3", date: "2026-03-02", merchant: "Host", amount: "40.00" }),
    ]);
    expect(kinds(checkup)).not.toContain("recurring");
  });

  it("counts three charges, not three rows on one day", () => {
    const checkup = run([
      row({ id: "d1", date: "2026-01-01", merchant: "Host", amount: "10.00" }),
      row({ id: "d2", date: "2026-01-01", merchant: "Host", amount: "10.00" }),
      row({ id: "d3", date: "2026-02-01", merchant: "Host", amount: "10.00" }),
    ]);
    expect(kinds(checkup)).not.toContain("recurring");
  });
});

describe("drift against the same period last year", () => {
  it("reports the movement and the category behind it", () => {
    const checkup = run([
      row({ id: "a", date: "2026-02-01", amount: "800.00", category: "Meals" }),
      row({
        id: "b",
        date: "2026-03-01",
        amount: "450.00",
        category: "Meals",
      }),
      row({ id: "c", date: "2026-04-01", amount: "50.00", category: "Office" }),
      row({
        id: "old-a",
        date: "2025-03-01",
        amount: "800.00",
        category: "Meals",
      }),
      row({
        id: "old-b",
        date: "2025-05-01",
        amount: "150.00",
        category: "Meals",
      }),
      row({
        id: "old-c",
        date: "2025-06-01",
        amount: "50.00",
        category: "Office",
      }),
    ]);
    const drift = finding(checkup, "drift");
    expect(drift.title).toBe("Spending is up 30% on the same period last year");
    expect(drift.detail).toBe(
      "$1,300.00 by this date against $1,000.00 last year.",
    );
    expect(drift.facts).toBe("Meals moved most, +$300.00");
    expect(drift.amount).toBe(300);
    expect(drift.count).toBe(3);
  });

  it("reports a drop, with the sign on the moving category", () => {
    const drift = finding(
      run([
        row({ id: "a", date: "2026-02-01", amount: "500.00" }),
        row({ id: "old-a", date: "2025-02-01", amount: "1000.00" }),
      ]),
      "drift",
    );
    expect(drift.title).toBe(
      "Spending is down 50% on the same period last year",
    );
    expect(drift.facts).toBe("Software moved most, -$500.00");
  });

  it("compares against the same date last year, not the whole year", () => {
    const checkup = run([
      row({ id: "a", date: "2026-02-01", amount: "100.00" }),
      // After July 15 of last year: not part of the comparison.
      row({ id: "old", date: "2025-08-01", amount: "999.00" }),
      row({ id: "same-period", date: "2025-07-15", amount: "100.00" }),
    ]);
    expect(kinds(checkup)).not.toContain("drift");
  });

  it("stays quiet under a tenth of movement", () => {
    const checkup = run([
      row({ id: "a", date: "2026-02-01", amount: "1050.00" }),
      row({ id: "old", date: "2025-02-01", amount: "1000.00" }),
    ]);
    expect(kinds(checkup)).not.toContain("drift");
  });

  it("clamps February 29 to the last day of the prior year's February", () => {
    const checkup = moneyCheckup({
      expenses: [
        row({ id: "now", date: "2028-02-01", amount: "300.00" }),
        row({ id: "last-day", date: "2027-02-28", amount: "100.00" }),
        row({ id: "march", date: "2027-03-01", amount: "999.00" }),
      ],
      today: "2028-02-29",
    });
    const drift = finding(checkup, "drift");
    expect(drift.detail).toBe(
      "$300.00 by this date against $100.00 last year.",
    );
  });
});

describe("trips this year", () => {
  const trip = (id: string, date: string): InsightExpense =>
    row({ id, date, type: "mileage", amount: "9.94", description: "Client" });

  it("notes the trips a driver logged before this year", () => {
    const checkup = run([
      trip("t1", "2025-03-01"),
      trip("t2", "2025-04-01"),
      row({ id: "e1" }),
    ]);
    const mileage = finding(checkup, "mileage");
    expect(mileage.title).toBe("No trips logged this year (2 last year)");
    expect(mileage.count).toBe(2);
    expect(mileage.action).toEqual({
      label: "Log a trip",
      href: "/expense/new?type=mileage",
    });
  });

  it("says nothing once the year has a trip", () => {
    const checkup = run([trip("t1", "2025-03-01"), trip("t2", "2026-03-01")]);
    expect(kinds(checkup)).not.toContain("mileage");
  });

  it("says nothing to an account that never drove", () => {
    expect(kinds(run([row({ id: "e1" })]))).not.toContain("mileage");
  });
});

describe("pace", () => {
  it("straight-lines the year from the days elapsed", () => {
    const checkup = moneyCheckup({
      expenses: [row({ id: "a", date: "2026-09-17", amount: "260.00" })],
      today: "2026-09-17",
    });
    // 260 days from January 1 to September 17, inclusive.
    expect(checkup.pace).toEqual({
      annual: 365,
      spent: 260,
      elapsedDays: 260,
    });
  });

  it("stays quiet in the first six weeks of the year", () => {
    const under = moneyCheckup({
      expenses: [row({ id: "a", date: "2026-02-10", amount: "100.00" })],
      today: "2026-02-10",
    });
    expect(under.pace).toBeNull();
    // February 14 is the 45th day of 2026.
    const over = moneyCheckup({
      expenses: [row({ id: "a", date: "2026-02-14", amount: "100.00" })],
      today: "2026-02-14",
    });
    expect(over.pace?.elapsedDays).toBe(45);
  });
});

describe("checkupText", () => {
  it("writes the block the answer step reads", () => {
    const checkup = run([
      row({
        id: "t1",
        date: "2025-03-01",
        type: "mileage",
        amount: "9.94",
        description: "Client",
      }),
      row({ id: "flat", date: "2026-02-01", category: "", amount: "212.40" }),
      row({ id: "unfiled", date: "2026-03-01", report: "" }),
      row({
        id: "n1",
        date: "2026-01-10",
        merchant: "Northwind",
        amount: "24.00",
        category: "Software",
      }),
      row({
        id: "n2",
        date: "2026-02-09",
        merchant: "Northwind",
        amount: "24.00",
        category: "Software",
      }),
      row({
        id: "n3",
        date: "2026-03-11",
        merchant: "Northwind",
        amount: "24.00",
        category: "Software",
      }),
      row({ id: "old", date: "2025-06-01", amount: "100.00" }),
    ]);
    expect(checkupText(checkup)).toBe(
      [
        "Money checkup (whole account, 2026-01-01 to 2026-07-15; ignores the chart filter):",
        "Spent: $294.40 across 5 expenses",
        "- 1 expense worth $212.40 with no category",
        "- 1 expense worth $10.00 in no report",
        "- 1 charge that repeats monthly, $288.00 a year (Northwind $24.00/mo)",
        "- Spending is up 168% on the same period last year (Software moved most, -$27.94)",
        "- No trips logged this year (1 last year)",
        "At this rate: about $548.24 by December 31 (a straight line from $294.40 in 196 days)",
      ].join("\n"),
    );
  });

  it("says a clean year is clean, on one line", () => {
    const clean = run([row({ id: "a", date: "2026-02-01", amount: "10.00" })]);
    expect(clean.findings).toEqual([]);
    expect(checkupText(clean)).toBe(
      [
        "Money checkup (whole account, 2026-01-01 to 2026-07-15; ignores the chart filter):",
        "Spent: $10.00 across 1 expense",
        `- ${NOTHING_OUTSTANDING}`,
        "At this rate: about $18.62 by December 31 (a straight line from $10.00 in 196 days)",
      ].join("\n"),
    );
  });
});
