import { describe, expect, it, vi } from "vitest";
import {
  accountHasAI,
  insightExpense,
  knownMerchantNames,
  monthWindow,
  monthlyTotals,
  type InsightExpense,
} from "~/lib/insights";
import { EMPTY_ROUTE } from "~/lib/types";
import {
  tokenSuggestions,
  type FilterNames,
} from "~/components/FilterCombobox";
import {
  parseInsightTranslation,
  translateInsightQuery,
} from "~/lib/insights-ai.server";

// The translator's LLM transport is mocked at the receipt-ai boundary:
// these tests cover the prompt contract, validation, and fallbacks, not
// the API client (covered by the receipt flows).
vi.mock("~/lib/receipt-ai.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chatCompletion: vi.fn(),
}));

import { chatCompletion } from "~/lib/receipt-ai.server";

const chat = vi.mocked(chatCompletion);

function exp(fields: Partial<InsightExpense>): InsightExpense {
  return {
    id: "e",
    type: "receipt",
    merchant: "",
    mileageType: "business",
    locations: [],
    description: "",
    category: "",
    report: "",
    amount: "0",
    date: "",
    ...fields,
  };
}

describe("monthWindow", () => {
  it("walks back across a year boundary", () => {
    expect(monthWindow("2026-03-15", 3)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
  });

  it("wraps into the previous year", () => {
    expect(monthWindow("2026-02-28", 14)).toEqual([
      "2025-01",
      "2025-02",
      "2025-03",
      "2025-04",
      "2025-05",
      "2025-06",
      "2025-07",
      "2025-08",
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });
});

describe("monthlyTotals", () => {
  const today = "2026-07-31";
  const expenses: InsightExpense[] = [
    exp({ merchant: "Z.ai", amount: "10.00", date: "2026-07-02" }),
    exp({ merchant: "DeepSeek", amount: "5.50", date: "2026-07-20" }),
    exp({ merchant: "Z.ai", amount: "4.50", date: "2026-06-10" }),
    exp({ merchant: "Peet's Coffee", amount: "9.20", date: "2026-07-04" }),
    // Outside the 2-month window: counted in all-time, not in monthly.
    exp({ merchant: "Z.ai", amount: "100.00", date: "2026-01-01" }),
    // Future-dated within the window: ignored (no bucket yet).
    exp({ merchant: "Z.ai", amount: "7.00", date: "2026-08-15" }),
  ];

  it("sums a multi-merchant OR filter per month", () => {
    const buckets = monthlyTotals(
      expenses,
      "merchant:z.ai merchant:deepseek",
      today,
      2,
    );
    expect(buckets).toHaveLength(2);
    expect(buckets[1]).toMatchObject({ key: "2026-07", total: 15.5, count: 2 });
    expect(buckets[0]).toMatchObject({ key: "2026-06", total: 4.5, count: 1 });
  });

  it("is case-insensitive and ignores future-dated rows", () => {
    const buckets = monthlyTotals(expenses, "merchant:Z.AI", today, 12);
    const july = buckets.find((b) => b.key === "2026-07");
    expect(july).toMatchObject({ total: 10, count: 1 });
  });

  it("returns empty buckets when nothing matches", () => {
    const buckets = monthlyTotals(expenses, "merchant:nvidia", today, 3);
    expect(buckets).toHaveLength(3);
    expect(buckets.every((b) => b.total === 0 && b.count === 0)).toBe(true);
  });

  it("ands different operators together", () => {
    const rows = [
      exp({ merchant: "Z.ai", amount: "1", date: "2026-07-01", report: "Q2" }),
      exp({ merchant: "Z.ai", amount: "2", date: "2026-07-02", report: "Q3" }),
    ];
    const buckets = monthlyTotals(rows, "merchant:z.ai report:q3", today, 1);
    expect(buckets[0]).toMatchObject({ total: 2, count: 1 });
  });

  it("all-time spans back to the oldest expense", () => {
    const buckets = monthlyTotals(expenses, "", today, 0);
    expect(buckets[0]?.key).toBe("2026-01");
    expect(buckets.at(-1)?.key).toBe("2026-07");
    const jan = buckets[0]!;
    expect(jan.total).toBe(100);
  });
});

describe("knownMerchantNames", () => {
  it("ranks by frequency and skips mileage and blanks", () => {
    const rows: InsightExpense[] = [
      exp({ merchant: "Z.ai", amount: "1", date: "2026-07-01" }),
      exp({ merchant: "Z.ai", amount: "1", date: "2026-07-02" }),
      exp({ merchant: "Peet's Coffee", amount: "1", date: "2026-07-03" }),
      exp({ merchant: "z.ai", amount: "1", date: "2026-07-04" }),
      exp({ type: "mileage", merchant: "", amount: "9", date: "2026-07-05" }),
      exp({ merchant: "", amount: "1", date: "2026-07-06" }),
    ];
    // Display spellings stay as written (no case folding): the list feeds
    // the LLM prompt, so the model sees names exactly as expenses name them.
    expect(knownMerchantNames(rows)).toEqual(["Z.ai", "Peet's Coffee", "z.ai"]);
  });
});

describe("accountHasAI", () => {
  it("unlocks paid and gratis accounts only", () => {
    expect(accountHasAI("paid")).toBe(true);
    expect(accountHasAI("gratis")).toBe(true);
    expect(accountHasAI(null)).toBe(false);
    expect(accountHasAI(undefined)).toBe(false);
    expect(accountHasAI("trial")).toBe(false);
  });
});

describe("insightExpense", () => {
  it("flattens mileage rows to the search-box view", () => {
    const e = insightExpense({
      id: "e1",
      type: "mileage",
      mileageType: "business",
      locations: [{ address: "Venice Beach, CA", lat: 0, lng: 0 }],
      route: EMPTY_ROUTE,
      distanceMiles: "14.2",
      description: "Client visit",
      category: "Client Meetings",
      report: "July 2026",
      amount: "9.94",
      date: "2026-07-22",
      reconciledAt: "",
      createdAt: "",
      updatedAt: "",
    });
    expect(e).toMatchObject({
      merchant: "",
      date: "2026-07-22",
      amount: "9.94",
    });
  });
});

describe("parseInsightTranslation", () => {
  it("parses a good answer", () => {
    expect(
      parseInsightTranslation(
        '{"query":"merchant:z.ai merchant:deepseek","title":"AI expenses","months":12}',
      ),
    ).toEqual({
      query: "merchant:z.ai merchant:deepseek",
      title: "AI expenses",
      months: 12,
    });
  });

  it("handles fenced JSON and collapses whitespace", () => {
    expect(
      parseInsightTranslation(
        '```json\n{"query":"merchant:peet\'s\\n coffee","title":"Coffee","months":24}\n```',
      ),
    ).toEqual({ query: "merchant:peet's coffee", title: "Coffee", months: 24 });
  });

  it("caps runaway queries and falls back on bad months", () => {
    const t = parseInsightTranslation(
      `{"query":"${"merchant:z.ai ".repeat(40)}","months":99}`,
    );
    expect(t.query.length).toBeLessThanOrEqual(300);
    expect(t.months).toBe(12);
  });

  it("falls back to show-everything on unusable output", () => {
    expect(parseInsightTranslation("I cannot answer that")).toEqual({
      query: "",
      title: "Expenses",
      months: 12,
    });
  });
});

describe("translateInsightQuery", () => {
  it("sends the merchant list and question, returns the translation", async () => {
    chat.mockResolvedValueOnce(
      '{"query":"merchant:z.ai merchant:deepseek","title":"AI expenses","months":12}',
    );
    const t = await translateInsightQuery({
      text: "my AI expenses",
      merchants: ["Z.ai", "DeepSeek", "Peet's Coffee"],
      categories: ["Meals and entertainment", "Software Subscriptions"],
      reports: ["July 2026"],
    });
    expect(t).toMatchObject({
      query: "merchant:z.ai merchant:deepseek",
      months: 12,
    });
    const [messages, opts] = chat.mock.calls[0]!;
    const userMessage = messages.at(-1)!.content;
    expect(userMessage).toContain("Merchants: Z.ai, DeepSeek, Peet's Coffee");
    // Built-in synonyms ride along so "coffee" resolves to the category.
    expect(userMessage).toContain(
      "Meals and entertainment (also means: food, dining, restaurant",
    );
    expect(userMessage).toContain("Question: my AI expenses");
    expect(opts?.json).toBe(true);
  });

  it("propagates transport errors to the caller", async () => {
    chat.mockRejectedValueOnce(new Error("LLM_API_KEY is not configured"));
    await expect(
      translateInsightQuery({
        text: "coffee",
        merchants: [],
        categories: [],
        reports: [],
      }),
    ).rejects.toThrow("LLM_API_KEY is not configured");
  });
});

describe("tokenSuggestions", () => {
  const names: FilterNames = {
    merchants: [["Z.ai", 3]],
    categories: [["Meals and entertainment", 2]],
    reports: [["July 2026", 1]],
  };

  it("expands a category synonym to the canonical operator form", () => {
    const completions = tokenSuggestions("food", names).map(
      (s) => s.completion,
    );
    expect(completions).toContain("category:Meals and entertainment ");
  });

  it("offers the canonical category for a synonym after the operator", () => {
    const completions = tokenSuggestions("category:food", names).map(
      (s) => s.completion,
    );
    expect(completions).toContain("category:Meals and entertainment ");
  });

  it("completes an alias prefix to the canonical operator", () => {
    const completions = tokenSuggestions("fro", names).map((s) => s.completion);
    expect(completions).toContain("merchant:");
  });

  it("completes names after an aliased operator", () => {
    const completions = tokenSuggestions("from:z", names).map(
      (s) => s.completion,
    );
    expect(completions).toContain("merchant:Z.ai ");
  });

  it("still offers the operator keyword itself", () => {
    const completions = tokenSuggestions("cate", names).map(
      (s) => s.completion,
    );
    expect(completions).toContain("category:");
  });
});
