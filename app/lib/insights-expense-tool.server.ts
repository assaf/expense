import { z } from "zod";
import type { PlanContext } from "~/lib/insights-plan.server";
import { MAX_TOOL_ARGUMENTS } from "~/lib/insights-tools.server";
import { resolveExpense } from "~/lib/mcp-write.server";
import type { ToolSpec } from "~/lib/receipt-ai.server";

/**
 * The insights chat's expense plan tool: the model resolves "log $50 spent
 * on coffee" into the fields the app files, and the app shows the user a
 * card to confirm. Nothing is written here.
 *
 * A module of its own, like the mileage tool: the read tool
 * (insights-tools.server.ts) is in-memory only, while this one resolves a
 * category against the account's own rows and its merchant history. The
 * model reaches `resolveExpense` (validate the date and report, normalize
 * the amount, resolve the category) and never a write; confirming is the
 * user's click, not a model decision.
 */

export const PLAN_EXPENSE = "plan_expense";

/** What the chat resolved a purchase into: everything the confirm card
 * shows, and the only thing the confirm action accepts back. */
export interface PendingExpense {
  kind: "expense";
  merchant: string;
  /** The USD figure the app would file (converted when the user paid in
   * another currency). */
  amount: string;
  /** The amount as the user stated it, in `currency`; the card posts this
   * back, so confirming resolves the purchase again from the same inputs.
   * Equal to `amount` for a dollar purchase. */
  originalAmount: string;
  /** ISO 4217 code the user stated, "USD" when they named none. */
  currency: string;
  /** USD per unit of `currency` as used, "" for USD. */
  fxRate: string;
  /** YYYY-MM-DD the rate is as-of, "" for USD. */
  rateDate: string;
  category: string;
  date: string;
  report: string;
  description: string;
}

const planExpenseInput = z.object({
  amount: z.coerce
    .string()
    .min(1)
    .max(20)
    .describe('The amount as a plain number, like "50" or "12.50".'),
  currency: z
    .string()
    .max(3)
    .optional()
    .describe(
      'ISO 4217 code when the user states a currency other than dollars, like "EUR"; omit for dollars. Never pass a converted amount.',
    ),
  merchant: z
    .string()
    .max(200)
    .optional()
    .describe("Merchant name, when the user names one."),
  category: z
    .string()
    .max(200)
    .optional()
    .describe(
      "One of the account's category names, only when the user's words make it obvious.",
    ),
  date: z
    .string()
    .optional()
    .describe("Expense date YYYY-MM-DD; omit for today."),
  report: z
    .string()
    .max(200)
    .optional()
    .describe("Report name; omit unless the user names one."),
  description: z
    .string()
    .max(300)
    .optional()
    .describe('Short note, e.g. "coffee with Dana".'),
});

export function planExpenseTool(): ToolSpec {
  return {
    type: "function",
    function: {
      name: PLAN_EXPENSE,
      description:
        "Work out a purchase the user asked to log as an expense (no image): normalize the amount, convert a currency they stated at the ECB rate for the date, resolve the category from the merchant's history or the account's own names, and return the entry for the user to confirm — it files nothing. Call it at most once per question.",
      parameters: z.toJSONSchema(planExpenseInput),
    },
  };
}

/** The purchase inputs the confirm card posts back: what the user stated and
 * nothing computed, so confirming resolves (and converts) it again. The
 * currency is optional because a card opened before the chat handled
 * currencies posts none, and no currency means dollars. */
export interface ExpenseConfirmation {
  merchant: string;
  /** The amount as the user stated it, in `currency`. */
  amount: string;
  currency?: string;
  category: string;
  date: string;
  report: string;
  description: string;
}

// Plain strings, not the input schema's coercion: the card is the only
// producer of this payload, so a non-string amount is a tampered request
// rather than model output. The currency is optional because a card opened
// before the chat handled currencies posts none, and "no currency" means
// dollars, exactly as it did then.
const confirmationSchema = z.object({
  merchant: z.string().max(200),
  amount: z.string().min(1).max(20),
  currency: z.string().max(3).optional(),
  category: z.string().max(200),
  date: z.string().max(20),
  report: z.string().max(200),
  description: z.string().max(300),
});

/** Parse the confirm card's payload (its JSON, in one form field). Returns
 * null when it is missing or malformed: the card is the only producer, so
 * anything else is a stale tab or an edited request. */
export function parseExpenseConfirmation(
  raw: string,
): ExpenseConfirmation | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = confirmationSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data;
}

/**
 * Resolve one plan_expense call. `resolve` is injectable (the house
 * pattern) so tests exercise the tool without the DB.
 *
 * The result is what the model reads; `pending` is the proposal the route
 * returns to the browser. Every rejection carries `{ error }` and no
 * pending: a wrong expense is worse than no expense.
 */
export async function runPlanExpense(
  writes: PlanContext,
  call: { function: { arguments: string } },
  resolve: typeof resolveExpense = resolveExpense,
): Promise<{ result: string; pending?: PendingExpense }> {
  // Same bound the read tool applies: the provider is untrusted, and this
  // argument string is parsed on the request path.
  if (call.function.arguments.length > MAX_TOOL_ARGUMENTS) {
    return { result: JSON.stringify({ error: "arguments were too long" }) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(call.function.arguments || "{}");
  } catch {
    return {
      result: JSON.stringify({ error: "arguments were not valid JSON" }),
    };
  }
  const parsed = planExpenseInput.safeParse(raw);
  if (!parsed.success) {
    return {
      result: JSON.stringify({
        error: "invalid expense",
        issues: parsed.error.issues.map((i) => i.message).slice(0, 5),
      }),
    };
  }
  const args = parsed.data;
  const resolved = await resolve(writes.accountId, {
    merchant: args.merchant,
    amount: args.amount,
    currency: args.currency,
    category: args.category,
    date: args.date || writes.today || undefined,
    report: args.report,
    description: args.description,
  });
  if (!resolved.ok) {
    return { result: JSON.stringify({ error: resolved.error }) };
  }
  const expense = resolved.expense;
  return {
    result: JSON.stringify({
      ok: true,
      date: expense.date,
      merchant: expense.merchant,
      // The amount the expense will store (USD), plus what the user said when
      // they paid in another currency: the conversion is the app's to make.
      amount: expense.amount,
      currency: expense.currency,
      originalAmount: expense.originalAmount,
      fxRate: expense.fxRate || null,
      rateDate: expense.rateDate || null,
      category: expense.category,
      report: expense.report,
    }),
    pending: {
      kind: "expense",
      merchant: expense.merchant,
      amount: expense.amount,
      originalAmount: expense.originalAmount,
      currency: expense.currency,
      fxRate: expense.fxRate,
      rateDate: expense.rateDate,
      category: expense.category,
      date: expense.date,
      report: expense.report,
      description: expense.description,
    },
  };
}
