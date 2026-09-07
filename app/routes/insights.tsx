import { ChartColumn, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useFetcher } from "react-router";
import { PageShell } from "~/components/PageShell";
import { Card } from "~/components/ui/Card";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Select } from "~/components/ui/Select";
import { MonthlyChart } from "~/components/MonthlyChart";
import { requireUser } from "~/lib/auth.server";
import { readAccount } from "~/lib/db/accounts";
import { readExpenses } from "~/lib/db/expenses";
import { countLabel, formatShortDate } from "~/lib/format";
import {
  accountHasAI,
  insightExpense,
  knownMerchantNames,
  matchingExpenses,
  monthlyTotals,
} from "~/lib/insights";
import { translateInsightQuery, LLMError } from "~/lib/insights-ai.server";
import { useToday } from "~/lib/use-today";
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

/** Chart windows. "year" means the calendar year so far (January 1
 * through the current month), anchored on the browser's local today;
 * the numeric strings are trailing month counts, "all" is everything. */
type Window = "6" | "12" | "24" | "all" | "year";

const WINDOW_OPTIONS: { value: Window; label: string }[] = [
  { value: "year", label: "This year" },
  { value: "6", label: "6 months" },
  { value: "12", label: "12 months" },
  { value: "24", label: "24 months" },
  { value: "all", label: "All time" },
];

const EXAMPLES = ["my AI expenses", "coffee", "software", "travel"];

export default function InsightsPage({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof action>();
  const [query, setQuery] = useState("");
  const [window_, setWindow] = useState<Window>("12");
  const [ask, setAsk] = useState("");
  const today = useToday();

  const result = fetcher.data as TranslateOk | TranslateErr | undefined;
  useEffect(() => {
    if (result?.ok) {
      setQuery(result.query);
      // The AI picks a trailing window (0 = all time); "year" is a
      // viewer-side convenience the model never returns.
      setWindow(
        result.months === 0 ? "all" : (String(result.months) as Window),
      );
    }
  }, [result]);

  const months = useMemo(() => {
    if (window_ === "all") return 0;
    if (window_ === "year") {
      // January through the current month: walking back from today's
      // month by its 1-based month number lands on January 1.
      return today ? Number(today.slice(5, 7)) : 12;
    }
    return Number(window_);
  }, [window_, today]);

  const buckets = useMemo(
    () =>
      today ? monthlyTotals(loaderData.expenses, query, today, months) : [],
    [loaderData.expenses, query, today, months],
  );
  const matched = useMemo(
    () => (today ? matchingExpenses(loaderData.expenses, query, buckets) : []),
    [loaderData.expenses, query, buckets, today],
  );
  const total = buckets.reduce((sum, b) => sum + b.total, 0);
  const count = buckets.reduce((sum, b) => sum + b.count, 0);
  const busy = fetcher.state !== "idle";

  const suggestions = useMemo(() => {
    const merchants = new Map<string, number>();
    const categories = new Map<string, number>();
    const reports = new Map<string, number>();
    for (const e of loaderData.expenses) {
      if (e.type === "receipt" && e.merchant) {
        merchants.set(e.merchant, (merchants.get(e.merchant) ?? 0) + 1);
      }
      if (e.category) {
        categories.set(e.category, (categories.get(e.category) ?? 0) + 1);
      }
      if (e.report) {
        reports.set(e.report, (reports.get(e.report) ?? 0) + 1);
      }
    }
    const byCount = (a: [string, number], b: [string, number]) =>
      b[1] - a[1] || a[0].localeCompare(b[0]);
    return {
      merchants: [...merchants.entries()].toSorted(byCount),
      categories: [...categories.entries()].toSorted(byCount),
      reports: [...reports.entries()].toSorted(byCount),
    };
  }, [loaderData.expenses]);

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
              <Input
                id="insights-ask"
                name="text"
                type="text"
                value={ask}
                onChange={(e) => setAsk(e.target.value)}
                autoComplete="off"
                placeholder='e.g. "my AI expenses"'
                className="min-w-0 flex-1"
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
                  onClick={() => setAsk(ex)}
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
            value={window_}
            onChange={(e) => setWindow(e.target.value as Window)}
            className="w-36"
          >
            {WINDOW_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="relative mb-4">
          <Input
            id="insights-query"
            list="insights-filter-suggestions"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter: merchant: category: report: description: or free text"
            autoComplete="off"
            className="w-full pr-9"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear filter"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-300"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          ) : null}
          <datalist id="insights-filter-suggestions">
            {suggestions.merchants.map(([name, c]) => (
              <option
                key={`op-merchant:${name}`}
                value={`merchant:${name}`}
                label={`${countLabel(c)} as a merchant`}
              />
            ))}
            {suggestions.categories.map(([name, c]) => (
              <option
                key={`op-category:${name}`}
                value={`category:${name}`}
                label={`${countLabel(c)} in this category`}
              />
            ))}
            {suggestions.reports.map(([name, c]) => (
              <option
                key={`report:${name}`}
                value={`report:${name}`}
                label={`${countLabel(c)} as a report`}
              />
            ))}
          </datalist>
        </div>
        {today ? (
          <MonthlyChart buckets={buckets} />
        ) : (
          <div className="h-[200px]" aria-hidden="true" />
        )}
        {matched.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <th scope="col" className="py-1.5 pr-2 font-medium">
                    Date
                  </th>
                  <th scope="col" className="py-1.5 pr-2 font-medium">
                    Expense
                  </th>
                  <th
                    scope="col"
                    className="hidden py-1.5 pr-2 font-medium sm:table-cell"
                  >
                    Category
                  </th>
                  <th
                    scope="col"
                    className="hidden py-1.5 pr-2 font-medium md:table-cell"
                  >
                    Report
                  </th>
                  <th scope="col" className="py-1.5 text-right font-medium">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {matched.map((e) => (
                  <tr
                    key={e.id}
                    className="border-b border-gray-100 last:border-0 dark:border-gray-800"
                  >
                    <td className="py-1.5 pr-2 whitespace-nowrap text-gray-500 dark:text-gray-400">
                      {formatShortDate(e.date)}
                    </td>
                    <td className="min-w-0 max-w-52 py-1.5 pr-2">
                      <Link
                        to={`/expense/${e.id}`}
                        className="block truncate hover:underline"
                      >
                        {e.merchant || e.description || "Untitled"}
                        {e.merchant && e.description ? (
                          <span className="text-gray-400 dark:text-gray-500">
                            {" "}
                            · {e.description}
                          </span>
                        ) : null}
                      </Link>
                    </td>
                    <td className="hidden py-1.5 pr-2 text-gray-500 sm:table-cell dark:text-gray-400">
                      {e.category}
                    </td>
                    <td className="hidden py-1.5 pr-2 text-gray-500 md:table-cell dark:text-gray-400">
                      {e.report}
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap tabular-nums">
                      {usd.format(Number(e.amount) || 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </PageShell>
  );
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
