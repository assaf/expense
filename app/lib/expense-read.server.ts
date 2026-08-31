import Decimal from "decimal.js";
import type { Expense } from "~/lib/types";
import { readExpenses } from "~/lib/db/expenses";
import { sortExpenses, summarizeBy } from "~/lib/format";
import type { ExpenseFilters } from "~/lib/expense-read-tools";

/**
 * The read-tool implementations shared by the MCP server and the WebMCP
 * JSON mirror, so both surfaces answer identically: same filtering, same
 * serialization, same totals, same limit clamping. The MCP handlers and
 * the /api/webmcp loader are thin adapters over these functions.
 */

/** Keep only the expenses matching the shared filter fields. */
export function filterExpenses(
  expenses: Expense[],
  f: ExpenseFilters,
): Expense[] {
  return expenses.filter((e) => {
    if (f.dateFrom && (!e.date || e.date < f.dateFrom)) return false;
    if (f.dateTo && (!e.date || e.date > f.dateTo)) return false;
    if (f.category && e.category.toLowerCase() !== f.category.toLowerCase())
      return false;
    if (f.merchant) {
      const q = f.merchant.toLowerCase();
      const hay =
        e.type === "receipt"
          ? e.merchant
          : e.locations.map((l) => l.address).join(" ");
      if (!hay.toLowerCase().includes(q)) return false;
    }
    if (f.report && e.report !== f.report) return false;
    if (f.unreported && e.report !== "") return false;
    if (f.type && e.type !== f.type) return false;
    return true;
  });
}

/** The wire shape of an expense: JSON-safe, money as decimal strings. */
export function serializeExpense(e: Expense) {
  return {
    id: e.id,
    type: e.type,
    date: e.date || null,
    report: e.report || null,
    category: e.category || null,
    description: e.description,
    amount: e.amount || null,
    ...(e.type === "receipt"
      ? {
          merchant: e.merchant || null,
          currency: e.currency || "USD",
          // Set together, only for a receipt captured in another currency.
          originalAmount: e.originalAmount || null,
          fxRate: e.fxRate || null,
        }
      : {
          mileageType: e.mileageType,
          distanceMiles: e.distanceMiles || null,
          stops: e.locations.map((l) => l.address).filter(Boolean),
        }),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

/** The expense_summary payload: count + exact total, and the per-category
 * breakdown (sorted by total, descending). The grand total is the exact sum
 * of the category buckets: every amount-bearing expense lands in exactly
 * one bucket. */
export function summarizeExpenses(expenses: Expense[]): {
  count: number;
  total: string;
  byCategory: { category: string; count: number; total: string }[];
} {
  const byCategory = summarizeBy(
    expenses,
    (e) => e.category || "Uncategorized",
  );
  const total = [...byCategory.values()].reduce(
    (sum, b) => sum.add(b.total),
    new Decimal(0),
  );
  const breakdown = [...byCategory.entries()]
    .sort((a, b) =>
      b[1].total.greaterThan(a[1].total)
        ? 1
        : b[1].total.lessThan(a[1].total)
          ? -1
          : 0,
    )
    .map(([category, b]) => ({
      category,
      count: b.count,
      total: b.total.toFixed(2),
    }));
  return {
    count: expenses.length,
    total: total.toFixed(2),
    byCategory: breakdown,
  };
}

/** The list_expenses payload: read, filter, sort newest first, clamp the
 * limit (1-500, default 100), and serialize. */
export async function readExpensesPage(
  accountId: string,
  filters: ExpenseFilters,
  limit?: number,
): Promise<{
  count: number;
  returned: number;
  expenses: ReturnType<typeof serializeExpense>[];
}> {
  const expenses = filterExpenses(await readExpenses(accountId), filters);
  const max =
    Number.isInteger(limit) && limit !== undefined && limit >= 1 && limit <= 500
      ? limit
      : 100;
  const limited = sortExpenses(expenses).slice(0, max);
  return {
    count: expenses.length,
    returned: limited.length,
    expenses: limited.map(serializeExpense),
  };
}

/** The expense_summary payload for the matching expenses. */
export async function readExpenseSummary(
  accountId: string,
  filters: ExpenseFilters,
): Promise<{
  count: number;
  total: string;
  byCategory: { category: string; count: number; total: string }[];
}> {
  return summarizeExpenses(
    filterExpenses(await readExpenses(accountId), filters),
  );
}
