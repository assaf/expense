import { ChartColumn, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { PageShell } from "~/components/PageShell";
import { Card } from "~/components/ui/Card";
import { Button } from "~/components/ui/Button";
import { Select } from "~/components/ui/Select";
import { MonthlyChart } from "~/components/MonthlyChart";
import { requireUser } from "~/lib/auth.server";
import { readAccount } from "~/lib/db/accounts";
import { readExpenses } from "~/lib/db/expenses";
import {
  accountHasAI,
  insightExpense,
  knownMerchantNames,
  monthlyTotals,
} from "~/lib/insights";
import { translateInsightQuery, LLMError } from "~/lib/insights-ai.server";
import { todayDate } from "~/lib/format";
import { formString, unknownIntent } from "~/lib/validation";
import type { Route } from "./+types/insights";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const [account, expenses] = await Promise.all([
    readAccount(user.accountId),
    readExpenses(user.accountId),
  ]);
  return {
    aiEnabled: accountHasAI(account?.plan),
    expenses: expenses.map(insightExpense),
  };
}

/** Translate free text into a chart filter. Gated on the account's plan
 * (the LLM call costs money); the rest of the page works for everyone. */
export async function action({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const form = await request.formData();
  if (formString(form, "intent") !== "translate") return unknownIntent();
  const account = await readAccount(user.accountId);
  if (!accountHasAI(account?.plan)) {
    return {
      ok: false as const,
      error: "Conversational search needs a paid or gratis account.",
    };
  }
  const text = formString(form, "text").trim();
  if (!text) return { ok: false as const, error: "Type a question first." };

  const expenses = (await readExpenses(user.accountId)).map(insightExpense);
  const merchants = knownMerchantNames(expenses);
  const categories = [
    ...new Set(expenses.map((e) => e.category).filter(Boolean)),
  ].toSorted();
  const reports = [
    ...new Set(expenses.map((e) => e.report).filter(Boolean)),
  ].toSorted();
  try {
    const t = await translateInsightQuery({
      text,
      merchants,
      categories,
      reports,
    });
    return { ok: true as const, ...t };
  } catch (err) {
    if (err instanceof LLMError) {
      return {
        ok: false as const,
        error: "The AI service didn't answer. Try again in a moment.",
      };
    }
    throw err;
  }
}

export function meta(): Route.MetaDescriptors {
  return [{ title: "Insights — Expense" }];
}

interface TranslateOk {
  ok: true;
  query: string;
  title: string;
  months: number;
}
interface TranslateErr {
  ok: false;
  error: string;
}

const MONTH_OPTIONS = [
  { value: "6", label: "6 months" },
  { value: "12", label: "12 months" },
  { value: "24", label: "24 months" },
  { value: "0", label: "All time" },
];

const EXAMPLES = ["my AI expenses", "coffee", "software", "travel"];

export default function InsightsPage({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof action>();
  const [query, setQuery] = useState("");
  const [months, setMonths] = useState(12);
  // The month window anchors on the browser's local today (timezone rule:
  // the server must not guess the user's day), so the chart fills in
  // after mount like home's future badges.
  const [today, setToday] = useState("");
  useEffect(() => setToday(todayDate()), []);

  const result = fetcher.data as TranslateOk | TranslateErr | undefined;
  useEffect(() => {
    if (result?.ok) {
      setQuery(result.query);
      setMonths(result.months);
    }
  }, [result]);

  const buckets = useMemo(
    () =>
      today ? monthlyTotals(loaderData.expenses, query, today, months) : [],
    [loaderData.expenses, query, today, months],
  );
  const total = buckets.reduce((sum, b) => sum + b.total, 0);
  const count = buckets.reduce((sum, b) => sum + b.count, 0);
  const busy = fetcher.state !== "idle";

  return (
    <PageShell
      icon={<ChartColumn aria-hidden="true" className="h-6 w-6" />}
      title="Insights"
      maxWidth="max-w-3xl"
    >
      <Card className="p-4">
        {loaderData.aiEnabled ? (
          <fetcher.Form method="post" className="flex flex-col gap-2">
            <input type="hidden" name="intent" value="translate" />
            <label htmlFor="insights-ask" className="text-sm font-medium">
              Describe what you want to see
            </label>
            <div className="flex gap-2">
              <input
                id="insights-ask"
                name="text"
                type="text"
                autoComplete="off"
                placeholder='e.g. "my AI expenses"'
                className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
              />
              <Button type="submit" disabled={busy}>
                <Sparkles aria-hidden="true" className="h-4 w-4" />
                {busy ? "Thinking…" : "Chart it"}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-sm">
              <span className="text-gray-500 dark:text-gray-400">Try:</span>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => {
                    setQuery(ex);
                    if (!busy)
                      void fetcher.submit(
                        { intent: "translate", text: ex },
                        { method: "post" },
                      );
                  }}
                  className="rounded-full border border-gray-300 px-2.5 py-0.5 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  {ex}
                </button>
              ))}
            </div>
            {result && !result.ok ? (
              <p className="text-sm text-red-700 dark:text-red-400">
                {result.error}
              </p>
            ) : null}
          </fetcher.Form>
        ) : (
          <div className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
            <Sparkles aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Conversational search ("my AI expenses") is available on paid and
              gratis accounts. You can still chart anything by typing a filter
              below, like{" "}
              <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">
                merchant:acme
              </code>
              .
            </p>
          </div>
        )}
      </Card>

      <Card className="mt-4 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {result?.ok ? `${result.title} · ` : ""}
            {count
              ? `${count} ${count === 1 ? "expense" : "expenses"} · ${usd.format(total)} total`
              : "No expenses in this window"}
          </p>
          <Select
            aria-label="Time window"
            value={String(months)}
            onChange={(e) => setMonths(Number(e.target.value))}
            className="w-32"
          >
            {MONTH_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <label htmlFor="insights-query" className="sr-only">
          Filter (merchant: category: report: or free text)
        </label>
        <input
          id="insights-query"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter: merchant: category: report: description: or free text"
          autoComplete="off"
          className="mb-4 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        />
        {today ? (
          <MonthlyChart buckets={buckets} />
        ) : (
          <div className="h-[200px]" aria-hidden="true" />
        )}
      </Card>
    </PageShell>
  );
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
