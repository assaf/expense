import { describe, expect, it, vi } from "vitest";
import { MAX_TOOL_ARGUMENTS } from "~/lib/insights-tools.server";
import type { ResolvedExpense, resolveExpense } from "~/lib/mcp-write.server";
import {
  parseExpenseConfirmation,
  runPlanExpense,
} from "~/lib/insights-expense-tool.server";

/**
 * The expense plan tool is the chat's second path toward a write: it
 * resolves a purchase the user describes and hands the route a proposal,
 * and must reject anything it cannot resolve exactly. The DB is replaced by
 * an injected resolver here; the real validate/amount/category flow is
 * covered by the route's end-to-end test.
 */

function expense(overrides: Partial<ResolvedExpense> = {}): ResolvedExpense {
  return {
    date: "2026-07-15",
    report: "",
    category: "Meals and entertainment",
    merchant: "Peet's Coffee",
    description: "coffee with Dana",
    amount: "50.00",
    currency: "USD",
    originalAmount: "50.00",
    fxRate: "",
    rateDate: "",
    ...overrides,
  };
}

/** The request context the route supplies (the user's local date, since
 * the server runs UTC). */
const writes = {
  accountId: "acct_1",
  reportNames: ["Q3"],
  today: "2026-07-15",
};

function call(args: unknown): { function: { arguments: string } } {
  return { function: { arguments: JSON.stringify(args) } };
}

function resolvesTo(resolved: ResolvedExpense) {
  return vi.fn<typeof resolveExpense>(async () => ({
    ok: true as const,
    expense: resolved,
  }));
}

function failsWith(error: string) {
  return vi.fn<typeof resolveExpense>(async () => ({
    ok: false as const,
    error,
  }));
}

describe("runPlanExpense", () => {
  it("proposes the resolved expense and reports it to the model", async () => {
    const resolver = resolvesTo(expense());
    const out = await runPlanExpense(
      writes,
      call({
        amount: "50",
        merchant: "Peet's Coffee",
        description: "coffee with Dana",
      }),
      resolver,
    );

    // The card's data: what the app will file, dated the user's today.
    expect(out.pending).toEqual({
      kind: "expense",
      merchant: "Peet's Coffee",
      amount: "50.00",
      originalAmount: "50.00",
      currency: "USD",
      fxRate: "",
      rateDate: "",
      category: "Meals and entertainment",
      date: "2026-07-15",
      report: "",
      description: "coffee with Dana",
    });
    // The model reads the same entry, structured.
    expect(JSON.parse(out.result)).toEqual({
      ok: true,
      date: "2026-07-15",
      merchant: "Peet's Coffee",
      amount: "50.00",
      originalAmount: "50.00",
      currency: "USD",
      fxRate: null,
      rateDate: null,
      category: "Meals and entertainment",
      report: "",
    });
    // The model's own fields are what the resolver gets: it normalizes the
    // amount (the unparsed "50" arrives here), converts a stated currency,
    // and resolves the category.
    expect(resolver.mock.calls[0]![0]).toBe("acct_1");
    expect(resolver.mock.calls[0]![1]).toEqual({
      merchant: "Peet's Coffee",
      amount: "50",
      currency: undefined,
      category: undefined,
      date: "2026-07-15",
      report: undefined,
      description: "coffee with Dana",
    });
  });

  it("hands a stated currency to the resolver and shows both figures", async () => {
    const resolver = resolvesTo(
      expense({
        amount: "58.10",
        currency: "EUR",
        originalAmount: "50.00",
        fxRate: "1.162",
        rateDate: "2026-07-14",
      }),
    );
    const out = await runPlanExpense(
      writes,
      call({ amount: "50", currency: "EUR", merchant: "Costa Coffee" }),
      resolver,
    );
    // The conversion is the app's: the model passes what the user said.
    expect(resolver.mock.calls[0]![1]).toEqual({
      merchant: "Costa Coffee",
      amount: "50",
      currency: "EUR",
      category: undefined,
      date: "2026-07-15",
      report: undefined,
      description: undefined,
    });
    expect(out.pending).toMatchObject({
      amount: "58.10",
      originalAmount: "50.00",
      currency: "EUR",
      fxRate: "1.162",
      rateDate: "2026-07-14",
    });
    expect(JSON.parse(out.result)).toMatchObject({
      amount: "58.10",
      originalAmount: "50.00",
      currency: "EUR",
      fxRate: "1.162",
      rateDate: "2026-07-14",
    });
  });

  it("accepts an amount the model sent as a number", async () => {
    const resolver = resolvesTo(expense({ amount: "50.00" }));
    const out = await runPlanExpense(writes, call({ amount: 50 }), resolver);
    // A model asked for an amount often emits a bare number: the schema
    // takes a number or a numeric string, and the resolver gets text.
    expect(resolver.mock.calls[0]![1]).toMatchObject({ amount: "50" });
    expect(out.pending?.amount).toBe("50.00");
  });

  it("rejects a present-but-null amount instead of coercing it to text", async () => {
    // `z.coerce.string()` used to turn the null a model sends for an empty
    // required field into the amount "null", which the resolver then
    // reported as a *missing* amount — so the model retried the same broken
    // call instead of being told the argument was malformed.
    const resolver = resolvesTo(expense({ amount: "null" }));
    const out = await runPlanExpense(writes, call({ amount: null }), resolver);
    expect(JSON.parse(out.result).error).toBe("invalid expense");
    expect(out.pending).toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });

  it("lets an explicit date win over the user's today", async () => {
    const resolver = resolvesTo(expense({ date: "2026-07-14" }));
    await runPlanExpense(
      writes,
      call({
        amount: "12.50",
        date: "2026-07-14",
        category: "Meals and entertainment",
      }),
      resolver,
    );
    expect(resolver.mock.calls[0]![1]).toMatchObject({
      date: "2026-07-14",
      category: "Meals and entertainment",
    });
  });

  it("surfaces the resolver's validation error", async () => {
    const out = await runPlanExpense(
      writes,
      call({ amount: "50", report: "Q4" }),
      failsWith('Report "Q4" is closed.'),
    );
    expect(JSON.parse(out.result)).toEqual({
      error: 'Report "Q4" is closed.',
    });
    expect(out.pending).toBeUndefined();
  });

  it("rejects malformed, over-long, and amountless arguments without resolving", async () => {
    const resolver = resolvesTo(expense());
    const malformed = await runPlanExpense(
      writes,
      { function: { arguments: "not json" } },
      resolver,
    );
    expect(JSON.parse(malformed.result)).toEqual({
      error: "arguments were not valid JSON",
    });
    const tooLong = await runPlanExpense(
      writes,
      { function: { arguments: " ".repeat(MAX_TOOL_ARGUMENTS + 1) } },
      resolver,
    );
    expect(JSON.parse(tooLong.result)).toEqual({
      error: "arguments were too long",
    });
    // No amount is the one thing the tool cannot work out: the model is
    // told to ask for it instead (and no pending is proposed).
    const noAmount = await runPlanExpense(
      writes,
      call({ merchant: "Peet's Coffee" }),
      resolver,
    );
    expect(JSON.parse(noAmount.result).error).toBe("invalid expense");
    expect(malformed.pending).toBeUndefined();
    expect(tooLong.pending).toBeUndefined();
    expect(noAmount.pending).toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe("parseExpenseConfirmation", () => {
  const payload = {
    merchant: "Peet's Coffee",
    amount: "50.00",
    currency: "EUR",
    category: "Meals and entertainment",
    date: "2026-07-14",
    report: "Q3",
    description: "coffee with Dana",
  };

  it("round-trips the card's payload, currency and all", () => {
    expect(parseExpenseConfirmation(JSON.stringify(payload))).toEqual(payload);
    // A dollar purchase posts no currency, and a card opened before the chat
    // handled currencies posts none either: both mean dollars.
    const { currency: _currency, ...dollars } = payload;
    expect(parseExpenseConfirmation(JSON.stringify(dollars))).toEqual(dollars);
  });

  it("rejects anything the card did not produce", () => {
    expect(parseExpenseConfirmation("")).toBeNull();
    expect(parseExpenseConfirmation("not json")).toBeNull();
    // A missing amount, and an amount that is not a string: the card posts
    // a string, so both are a stale tab or an edited request.
    const withoutAmount = Object.fromEntries(
      Object.entries(payload).filter(([key]) => key !== "amount"),
    );
    expect(parseExpenseConfirmation(JSON.stringify(withoutAmount))).toBeNull();
    expect(
      parseExpenseConfirmation(JSON.stringify({ ...payload, amount: {} })),
    ).toBeNull();
    // A currency is a 3-letter code; anything longer never came from a card.
    expect(
      parseExpenseConfirmation(
        JSON.stringify({ ...payload, currency: "EURO" }),
      ),
    ).toBeNull();
  });
});
