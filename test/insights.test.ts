import { describe, expect, it, vi } from "vitest";
import {
  insightExpense,
  insightStarters,
  pickStarter,
  recentTripStops,
  revealTo,
  insightSummary,
  knownMerchants,
  monthWindow,
  monthlyTotals,
  type InsightExpense,
  type MonthBucket,
} from "~/lib/insights";
import { EMPTY_ROUTE } from "~/lib/types";
import {
  tokenSuggestions,
  type FilterNames,
} from "~/components/FilterCombobox";
import {
  answerInsightQuestion,
  parseInsightTranslation,
  translateInsightQuery,
} from "~/lib/insights-ai.server";
import type { PendingTrip } from "~/lib/insights-mileage-tool.server";
import type { ToolCall } from "~/lib/receipt-ai.server";

// The translator's LLM transport is mocked at the receipt-ai boundary:
// these tests cover the prompt contract, validation, and fallbacks, not
// the API client (covered by the receipt flows). chatWithTools is mocked
// too: the answer step's tool loop must not reach the network here.
vi.mock("~/lib/receipt-ai.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chatCompletion: vi.fn(),
  chatWithTools: vi.fn(async () => ({ content: "", toolCalls: [] })),
}));
// The plan tool itself is covered in test/insights-mileage-tool.test.ts
// (fake resolver) and end-to-end in test/insights-route.test.ts: here only
// the answer step's dispatch is under test, so the module is stubbed to
// keep this suite free of the map services and the DB.
vi.mock("~/lib/insights-mileage-tool.server", () => ({
  PLAN_MILEAGE: "plan_mileage",
  planMileageTool: () => ({
    type: "function",
    function: {
      name: "plan_mileage",
      description: "Plan a mileage trip.",
      parameters: { type: "object" },
    },
  }),
  runPlanMileage: vi.fn(),
}));
import { chatCompletion, chatWithTools } from "~/lib/receipt-ai.server";
import { runPlanMileage } from "~/lib/insights-mileage-tool.server";

const chat = vi.mocked(chatCompletion);
const tools = vi.mocked(chatWithTools);

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

  it("charts the calendar year so far for months=-1", () => {
    const buckets = monthlyTotals(expenses, "merchant:z.ai", today, -1);
    expect(buckets).toHaveLength(7);
    expect(buckets[0]).toMatchObject({ key: "2026-01", total: 100, count: 1 });
    expect(buckets[6]).toMatchObject({ key: "2026-07", total: 10, count: 1 });
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

  it("accepts months=-1 for calendar-year questions", () => {
    expect(
      parseInsightTranslation(
        '{"query":"merchant:z.ai","title":"AI expenses","months":-1}',
      ),
    ).toMatchObject({ months: -1, chart: true });
  });

  it("all-time spans back to the oldest expense", () => {
    const buckets = monthlyTotals(expenses, "", today, 0);
    expect(buckets[0]?.key).toBe("2026-01");
    expect(buckets.at(-1)?.key).toBe("2026-07");
    const jan = buckets[0]!;
    expect(jan.total).toBe(100);
  });
});

describe("knownMerchants", () => {
  it("ranks by frequency, annotates categories, skips mileage and blanks", () => {
    const rows: InsightExpense[] = [
      exp({
        merchant: "Z.ai",
        amount: "1",
        date: "2026-07-01",
        category: "Software Subscriptions",
      }),
      exp({
        merchant: "Z.ai",
        amount: "1",
        date: "2026-07-02",
        category: "Software Subscriptions",
      }),
      exp({
        merchant: "Peet's Coffee",
        amount: "1",
        date: "2026-07-03",
        category: "Meals and entertainment",
      }),
      exp({ merchant: "z.ai", amount: "1", date: "2026-07-04" }),
      exp({ type: "mileage", merchant: "", amount: "9", date: "2026-07-05" }),
      exp({ merchant: "", amount: "1", date: "2026-07-06" }),
    ];
    // Display spellings stay as written (no case folding): the list feeds
    // the LLM prompt, so the model sees names exactly as expenses name
    // them, plus the categories each merchant's expenses actually landed
    // in (top 2) — "Amazon (Books)" must not look like an AI expense.
    expect(knownMerchants(rows)).toEqual([
      "Z.ai (Software Subscriptions)",
      "Peet's Coffee (Meals and entertainment)",
      "z.ai",
    ]);
  });
});

describe("recentTripStops", () => {
  const stop = (address: string) => ({ address, lat: null, lng: null });

  it("collects stops newest trip first, minus the home address", () => {
    const rows: InsightExpense[] = [
      exp({
        id: "e1",
        type: "mileage",
        date: "2026-07-01",
        locations: [stop("Home Base, CA"), stop("Old Client, CA")],
      }),
      exp({
        id: "e2",
        type: "mileage",
        date: "2026-07-20",
        locations: [stop("The Office, CA"), stop("Home Base, CA")],
      }),
    ];
    expect(recentTripStops(rows, "home base, CA")).toEqual([
      "The Office, CA",
      "Old Client, CA",
    ]);
  });

  it("dedupes case-insensitively and keeps the first spelling", () => {
    const rows: InsightExpense[] = [
      exp({
        id: "b",
        type: "mileage",
        date: "2026-07-10",
        locations: [stop("The Office, CA"), stop("1 Client Way, CA")],
      }),
      exp({
        id: "a",
        type: "mileage",
        date: "2026-07-10",
        locations: [stop("the office, ca"), stop("2 Client Way, CA")],
      }),
    ];
    // Same-date trips are ordered by id, so "a" is the newer one.
    expect(recentTripStops(rows, "")).toEqual([
      "the office, ca",
      "2 Client Way, CA",
      "1 Client Way, CA",
    ]);
  });

  it("ignores one-stop rows, blanks, and receipt rows", () => {
    const rows: InsightExpense[] = [
      exp({
        id: "e1",
        type: "mileage",
        date: "2026-07-01",
        locations: [stop("Solo, CA")],
      }),
      exp({
        id: "e2",
        type: "mileage",
        date: "2026-07-02",
        locations: [stop("   "), stop("Real Stop, CA"), stop("Other Stop, CA")],
      }),
      exp({
        id: "e3",
        type: "receipt",
        date: "2026-07-03",
        locations: [stop("Not A Trip, CA"), stop("Also Not, CA")],
      }),
    ];
    expect(recentTripStops(rows, "")).toEqual([
      "Real Stop, CA",
      "Other Stop, CA",
    ]);
  });

  it("caps the list at the limit", () => {
    const rows: InsightExpense[] = [
      exp({
        id: "e1",
        type: "mileage",
        date: "2026-07-01",
        locations: [stop("A"), stop("B"), stop("C"), stop("D")],
      }),
    ];
    expect(recentTripStops(rows, "", 3)).toEqual(["A", "B", "C"]);
  });
});

describe("insightSummary", () => {
  const buckets: MonthBucket[] = [
    { key: "2026-06", label: "Jun", total: 95, count: 3 },
    { key: "2026-07", label: "Jul", total: 105, count: 2 },
    { key: "2026-08", label: "Aug", total: 0, count: 0 }, // empty months excluded
  ];
  const rows: InsightExpense[] = [
    exp({
      merchant: "Z.ai",
      amount: "80.00",
      date: "2026-07-01",
      category: "Software Subscriptions",
    }),
    exp({
      merchant: "Test Store",
      amount: "25.00",
      date: "2026-07-02",
      category: "Testing",
    }),
    exp({
      merchant: "DeepSeek",
      amount: "25.00",
      date: "2026-06-10",
      category: "Software Subscriptions",
    }),
    exp({
      merchant: "Peet's Coffee",
      amount: "15.00",
      date: "2026-06-03",
      category: "Meals and entertainment",
    }),
    exp({ type: "mileage", amount: "55", date: "2026-06-01" }), // no merchant
  ];

  it("sums the total from buckets and counts matched rows", () => {
    const summary = insightSummary(buckets, rows);
    expect(summary).toContain("Total: $200.00 across 5 expenses");
  });

  it("includes the monthly breakdown and skips empty months", () => {
    const summary = insightSummary(buckets, rows);
    expect(summary).toContain(
      "By month: Jun: $95.00 (3 expenses); Jul: $105.00 (2 expenses)",
    );
    expect(summary).not.toContain("Aug");
  });

  it("ranks top merchants and skips merchantless rows", () => {
    const summary = insightSummary(buckets, rows);
    expect(summary).toContain(
      "Top merchants: Z.ai: $80.00 (1 expenses); Test Store: $25.00 (1 expenses); DeepSeek: $25.00 (1 expenses)",
    );
  });

  it("includes the per-category breakdown for category questions", () => {
    const summary = insightSummary(buckets, rows);
    expect(summary).toContain(
      "By category: Software Subscriptions: $105.00 (2 expenses); Testing: $25.00 (1 expenses); Meals and entertainment: $15.00 (1 expenses)",
    );
  });

  it("breaks spending down by report and counts the unreported", () => {
    const withReports = [
      exp({
        merchant: "Z.ai",
        amount: "80.00",
        date: "2026-07-01",
        report: "Q3 Travel",
      }),
      exp({
        merchant: "Test Store",
        amount: "25.00",
        date: "2026-07-02",
        report: "Q3 Travel",
      }),
      exp({
        merchant: "DeepSeek",
        amount: "25.00",
        date: "2026-06-10",
        report: "Software 2026",
      }),
      exp({ merchant: "Peet's Coffee", amount: "15.00", date: "2026-06-03" }),
    ];
    const summary = insightSummary(buckets, withReports);
    // Report questions ("which report did I spend most on?") read this line.
    expect(summary).toContain(
      "By report: Q3 Travel: $105.00 (2 expenses); Software 2026: $25.00 (1 expenses)",
    );
    expect(summary).toContain("Not in any report: 1 expenses");
  });
});

describe("answerInsightQuestion", () => {
  it("grounds the answer prompt in the computed data and history", async () => {
    chat.mockResolvedValueOnce("  You spent more this month.  ");
    const { answer, pending } = await answerInsightQuestion({
      question: "did I spend more on AI this month?",
      history: [{ question: "earlier question", answer: "earlier answer" }],
      summary: "Total: $200.00 across 5 expenses\nBy month: Jul: $105.00 (2)",
    });
    // The answer is trimmed (surrounding whitespace/quotes stripped).
    expect(answer).toBe("You spent more this month.");
    expect(pending).toBeUndefined();
    const [messages] = chat.mock.calls[0]!;
    const user = messages.at(-1)!.content;
    expect(user).toContain("Computed data:");
    expect(user).toContain("Total: $200.00 across 5 expenses");
    expect(user).toContain("Previous exchanges:");
    expect(user).toContain("Q: earlier question\nA: earlier answer");
    expect(user).toContain("Question: did I spend more on AI this month?");
  });

  it("falls back to a placeholder when the model returns nothing", async () => {
    chat.mockResolvedValueOnce('""');
    const { answer } = await answerInsightQuestion({
      question: "anything",
      history: [],
      summary: "Total: $0.00 across 0 expenses",
    });
    expect(answer).toBe("I couldn't summarize that.");
  });
});

describe("answerInsightQuestion plan_mileage dispatch", () => {
  const planned: PendingTrip = {
    stops: [
      { address: "1 Office Way, Testing, CA", lat: 34.02, lng: -118.28 },
      { address: "2 Home St, Testing, CA", lat: 34.05, lng: -118.24 },
    ],
    date: "2026-07-14",
    type: "business",
    report: "",
    description: "",
    distanceMiles: "12.34",
    amount: "9.38",
    rate: "0.76",
    approximate: false,
  };
  const expenses = [exp({ id: "e1", date: "2026-07-01", amount: "10.00" })];
  const tripCall: ToolCall = {
    id: "call_trip",
    function: {
      name: "plan_mileage",
      arguments: JSON.stringify({ stops: ["1 Office Way", "2 Home St"] }),
    },
  };
  const offeredToolNames = () =>
    tools.mock.calls[0]![1].tools.map((t) => t.function.name);

  it("collects the planned trip as pending when writes are enabled", async () => {
    tools.mockClear();
    vi.mocked(runPlanMileage).mockClear();
    vi.mocked(runPlanMileage).mockResolvedValueOnce({
      result: JSON.stringify({ ok: true, distanceMiles: "12.34" }),
      pending: planned,
    });
    tools
      .mockResolvedValueOnce({ content: "", toolCalls: [tripCall] })
      .mockResolvedValueOnce({
        content: "That's a 12.34 mi trip — confirm it?",
        toolCalls: [],
      });

    const result = await answerInsightQuestion({
      question: "log the drive from the office back home on Tuesday",
      history: [],
      summary: "Total: $0.00 across 0 expenses",
      expenses,
      writes: {
        accountId: "acct_1",
        reportNames: ["Q3"],
        today: "2026-07-15",
      },
    });

    expect(result.answer).toBe("That's a 12.34 mi trip — confirm it?");
    // The proposal comes back for the confirm card, and only that.
    expect(result.pending).toEqual(planned);
    expect(offeredToolNames()).toContain("plan_mileage");
    // The call is resolved against the request's own account context.
    expect(vi.mocked(runPlanMileage).mock.calls[0]![0]).toEqual({
      accountId: "acct_1",
      reportNames: ["Q3"],
      today: "2026-07-15",
    });
    // Its result reaches the model, fenced like every other tool output.
    const sent = tools.mock.calls.at(-1)![0];
    const toolMessage = sent.filter((m) => m.role === "tool").at(-1)!;
    expect(toolMessage.content).toContain("<<<DATA>>>");
    expect(toolMessage.content).toContain("12.34");
  });

  it("neither offers nor honors the plan tool without writes", async () => {
    tools.mockClear();
    vi.mocked(runPlanMileage).mockClear();
    tools
      .mockResolvedValueOnce({ content: "", toolCalls: [tripCall] })
      .mockResolvedValueOnce({ content: "I can't log trips.", toolCalls: [] });

    const result = await answerInsightQuestion({
      question: "log the drive home",
      history: [],
      summary: "Total: $0.00 across 0 expenses",
      expenses,
    });

    expect(result.pending).toBeUndefined();
    expect(runPlanMileage).not.toHaveBeenCalled();
    expect(offeredToolNames()).not.toContain("plan_mileage");
    const sent = tools.mock.calls.at(-1)![0];
    const toolMessage = sent.filter((m) => m.role === "tool").at(-1)!;
    expect(toolMessage.content).toContain("unknown tool plan_mileage");
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
      chart: true,
    });
  });

  it("handles fenced JSON and collapses whitespace", () => {
    expect(
      parseInsightTranslation(
        '```json\n{"query":"merchant:peet\'s\\n coffee","title":"Coffee","months":24}\n```',
      ),
    ).toEqual({
      query: "merchant:peet's coffee",
      title: "Coffee",
      months: 24,
      chart: true,
    });
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
      chart: true,
    });
  });
});

describe("translateInsightQuery", () => {
  it("sends the merchant list and question, returns the translation", async () => {
    chat.mockClear();
    chat.mockResolvedValueOnce(
      '{"query":"merchant:z.ai merchant:deepseek","title":"AI expenses","months":12}',
    );
    const t = await translateInsightQuery({
      text: "my AI expenses",
      merchants: [
        "Z.ai (Software Subscriptions)",
        "DeepSeek (Software Subscriptions)",
        "Peet's Coffee (Meals and entertainment)",
      ],
      categories: ["Meals and entertainment", "Software Subscriptions"],
      reports: ["July 2026"],
    });
    expect(t).toMatchObject({
      query: "merchant:z.ai merchant:deepseek",
      months: 12,
    });
    const [messages, opts] = chat.mock.calls[0]!;
    const userMessage = messages.at(-1)!.content;
    expect(userMessage).toContain(
      "Merchants: Z.ai (Software Subscriptions), DeepSeek (Software Subscriptions)",
    );
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

  it("completes reports for a multi-word operator value", () => {
    const withTest: FilterNames = {
      ...names,
      reports: [["2026 Test", 4]],
    };
    const completions = tokenSuggestions("report:2026 t", withTest).map(
      (s) => s.completion,
    );
    expect(completions).toContain("report:2026 Test ");
  });

  it("completes names after an aliased operator", () => {
    const completions = tokenSuggestions("from:z", names).map(
      (s) => s.completion,
    );
    expect(completions).toContain("merchant:Z.ai ");
  });

  it("returns no suggestions for an empty token", () => {
    expect(tokenSuggestions("", names)).toEqual([]);
  });

  it("still offers the operator keyword itself", () => {
    const completions = tokenSuggestions("cate", names).map(
      (s) => s.completion,
    );
    expect(completions).toContain("category:");
  });
});

describe("insightStarters", () => {
  const today = "2026-07-31";
  const data: InsightExpense[] = [
    exp({
      merchant: "Z.ai",
      amount: "10.00",
      date: "2026-07-02",
      category: "Software",
      report: "2026 Test",
    }),
    exp({
      merchant: "DeepSeek",
      amount: "5.50",
      date: "2026-07-20",
      category: "Software",
      report: "2026 Test",
    }),
    exp({
      merchant: "Peet's Coffee",
      amount: "9.20",
      date: "2026-07-04",
      category: "Meals",
    }),
    exp({
      merchant: "OfficeMax",
      amount: "299.00",
      date: "2026-06-10",
      category: "Office Supplies",
      report: "2026 Test",
    }),
    exp({
      description: "Client drive",
      type: "mileage",
      amount: "32.00",
      date: "2026-05-02",
      report: "2026 Test",
    }),
    exp({
      merchant: "Z.ai",
      amount: "100.00",
      date: "2026-01-01",
      category: "Software",
    }),
    exp({ merchant: "Z.ai", amount: "7.00", date: "2026-08-15" }),
  ];

  it("offers a last-30-days fact with exact figures", () => {
    const starters = insightStarters(data, today);
    const last30 = starters.find((s) => s.question.includes("last 30 days"));
    expect(last30?.answer).toBe(
      "3 expenses totaling $24.70 in the last 30 days.",
    );
  });

  it("offers a year-to-date fact that excludes future-dated rows", () => {
    const starters = insightStarters(data, today);
    const year = starters.find(
      (s) => s.question.includes("this year") && s.question.includes("spent"),
    );
    expect(year?.answer).toBe("So far this year: 6 expenses totaling $455.70.");
  });

  it("names the biggest recent expense with its category", () => {
    const starters = insightStarters(data, today);
    const biggest = starters.find((s) => s.question.includes("biggest"));
    expect(biggest?.answer).toBe(
      "Your biggest expense in the last 90 days is $299.00: OfficeMax · Office Supplies.",
    );
  });

  it("ranks reports by this year's totals", () => {
    const starters = insightStarters(data, today);
    const report = starters.find((s) => s.question.includes("report"));
    expect(report?.answer).toBe(
      "2026 Test leads this year's reports: 4 expenses worth $346.50.",
    );
  });

  it("counts unfiled expenses", () => {
    const starters = insightStarters(data, today);
    const unfiled = starters.find((s) => s.question.includes("report?"));
    expect(unfiled?.answer).toBe(
      "3 expenses worth $116.20 have no report yet.",
    );
  });

  it("labels mileage rows by description", () => {
    const starters = insightStarters(data, today);
    const biggest = starters.find((s) => s.question.includes("biggest"));
    expect(biggest?.answer).not.toContain("Client drive");
    const mileageOnly = insightStarters(
      [
        exp({
          description: "Client drive",
          type: "mileage",
          amount: "32.00",
          date: "2026-07-02",
          category: "Travel",
          report: "R",
        }),
      ],
      today,
    );
    expect(
      mileageOnly.find((s) => s.question.includes("biggest"))?.answer,
    ).toBe(
      "Your biggest expense in the last 90 days is $32.00: Client drive · Travel.",
    );
  });

  it("offers nothing for an account without expenses", () => {
    expect(insightStarters([], today)).toEqual([]);
  });

  it("picks a different starter as the rng walks", () => {
    const starters = insightStarters(data, today);
    expect(pickStarter(starters, () => 0)).toBe(starters[0]);
    expect(pickStarter(starters, () => 0.999)).toBe(
      starters[starters.length - 1],
    );
    expect(pickStarter([], () => 0.5)).toBe(null);
  });
});

describe("revealTo", () => {
  const text = "hello world from the reveal function";

  it("does not pass the end", () => {
    expect(revealTo(text, 0, 60_000)).toBe(text.length);
    expect(revealTo(text, text.length, 16)).toBe(text.length);
  });

  it("advances by roughly the elapsed characters per second", () => {
    const next = revealTo(text, 0, 100);
    expect(next).toBeGreaterThanOrEqual(25);
    expect(next).toBeLessThanOrEqual(60);
  });

  it("cuts on word boundaries, never mid-word", () => {
    const partial = revealTo("alpha beta gamma delta", 0, 100);
    expect("alpha beta gamma delta".slice(0, partial)).toMatch(
      /^(\w+)( \w+)*$/,
    );
  });

  it("streams long answers fast enough to finish in a few seconds", () => {
    const long = "word ".repeat(2_000);
    const next = revealTo(long, 0, 100);
    expect(next).toBeGreaterThan(200);
  });
});
