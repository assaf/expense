import { ChartColumn, Sparkles, SquarePen } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import { Markdown } from "~/components/Markdown";
import { PageShell } from "~/components/PageShell";
import { Card } from "~/components/ui/Card";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { MonthlyChart } from "~/components/MonthlyChart";
import { requireUser } from "~/lib/auth.server";
import { readAccount, readAccountUsers } from "~/lib/db/accounts";
import { readCategories } from "~/lib/db/categories";
import { readExpenses } from "~/lib/db/expenses";
import { readReports } from "~/lib/db/reports";
import { readSettings } from "~/lib/db/settings";
import {
  appendExchange,
  readLatestConversation,
  startNewConversation,
} from "~/lib/db/insights-chat";
import { formatShortDate } from "~/lib/format";
import {
  accountHasAI,
  insightExpense,
  insightSummary,
  knownMerchants,
  matchingExpenses,
  monthlyTotals,
  type InsightExpense,
  type MonthBucket,
} from "~/lib/insights";
import {
  answerInsightQuestion,
  translateInsightQuery,
  LLMError,
} from "~/lib/insights-ai.server";
import { useToday } from "~/lib/use-today";
import { formString, unknownIntent } from "~/lib/validation";
import type { Route } from "./+types/insights";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const [account, conversation, expenses] = await Promise.all([
    readAccount(user.accountId),
    readLatestConversation(user.id),
    readExpenses(user.accountId),
  ]);
  return {
    aiEnabled: accountHasAI(account?.plan),
    expenses: expenses.map(insightExpense),
    // The most recent conversation reloads with the page; older ones stay
    // in the database as a record.
    messages: conversation?.exchanges ?? [],
  };
}

/** Two grounded LLM calls behind the plan gate: the question becomes a
 * filter (translate), the app computes the exact numbers from the real
 * expenses, and the model phrases the answer from those numbers — it
 * never invents figures. Chart questions carry their own chart in the
 * transcript. */
export async function action({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const form = await request.formData();
  const intent = formString(form, "intent");
  if (intent === "new") {
    // Start a fresh conversation; the previous one stays in the database
    // as a record. No LLM call, so no plan gate needed here.
    await startNewConversation(user.id, user.accountId);
    return { ok: true as const, fresh: true };
  }
  if (intent !== "translate") return unknownIntent();
  const planAccount = await readAccount(user.accountId);
  if (!accountHasAI(planAccount?.plan)) {
    return {
      ok: false as const,
      error: "Conversational search needs a paid or gratis account.",
    };
  }
  const text = formString(form, "text").trim();
  if (!text) return { ok: false as const, error: "Type a question first." };

  // The client's local today: the server must not guess the user's day.
  const today = formString(form, "today");
  const localTime = formString(form, "localTime");
  // The client's IANA timezone: report dates are formatted in it (the
  // server's clock is UTC and must not guess the user's zone).
  const tz = formString(form, "tz");

  const [account, categories, reports, settings, members] = await Promise.all([
    readAccount(user.accountId),
    readCategories(user.accountId),
    readReports(user.accountId),
    readSettings(user.accountId),
    readAccountUsers(user.accountId),
  ]);
  const expenses = (await readExpenses(user.accountId)).map(insightExpense);
  const merchants = knownMerchants(expenses);
  // The settings lists are authoritative (they include unused entries,
  // unlike the ones derived from expenses).
  const categoryNames = categories.map((c) => c.name);
  const reportNames = reports.map((r) =>
    r.createdAt
      ? `${r.name} (created ${formatUserDate(new Date(r.createdAt), tz)})`
      : r.name,
  );
  const emails = [...new Set([user.email, ...members.map((m) => m.email)])];
  const profile = [
    `Name (account): ${account?.name ?? ""}`,
    settings.homeAddress ? `Home location: ${settings.homeAddress}` : "",
    `Email addresses: ${emails.join(", ")}`,
    `Categories: ${categoryNames.join(", ")}`,
    `Reports: ${reportNames.join(", ")}`,
  ]
    .filter((line) => !line.endsWith(": "))
    .join("\n");
  const localTimeOk = /^\d{1,2}:\d{2}/.test(localTime);
  const conversation = await readLatestConversation(user.id);
  try {
    const t = await translateInsightQuery({
      text,
      history: conversation?.exchanges.slice(-3) ?? [],
      today,
      merchants,
      categories: categoryNames,
      reports: reportNames,
    });
    // Ground the text answer in real numbers: compute the same view the
    // chart shows and let the model phrase it. Invalid client dates (the
    // field is always sent by this page) degrade to a chart-only answer.
    if (/^\d{4}-\d{2}-\d{2}$/.test(today)) {
      const buckets = monthlyTotals(expenses, t.query, today, t.months);
      const matched = matchingExpenses(expenses, t.query, buckets);
      const answer = await answerInsightQuestion({
        question: text,
        history: conversation?.exchanges.slice(-3) ?? [],
        summary: insightSummary(buckets, matched),
        profile: localTimeOk
          ? `${profile}\nCurrent time: ${localTime} (user's local clock)`
          : profile,
      });
      await appendExchange(user.id, user.accountId, {
        question: text,
        answer,
        chart: t.chart,
        query: t.query,
        months: t.months,
        title: t.title,
      });
      return { ok: true as const, ...t, answer };
    }
    return {
      ok: true as const,
      ...t,
      answer: `Charting ${t.title}.`,
    };
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

/** Format an instant in the user's timezone ("Sep 8, 2026, 1:15 PM"); an
 * invalid client-supplied zone falls back to UTC. */
export function formatUserDate(date: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
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
  /** Whether the question was best answered with a chart. */
  chart: boolean;
  /** The grounded text answer (computed figures, phrased by the model). */
  answer: string;
}
interface TranslateErr {
  ok: false;
  error: string;
}

/** One question/answer exchange in the conversation. Chart exchanges
 * carry their own filter and window so they render their own chart. */
interface Exchange {
  question: string;
  answer: string;
  chart: boolean;
  query: string;
  months: number;
  title: string;
}

const EXAMPLES = ["my AI expenses", "coffee", "software", "travel"];

export default function InsightsPage({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof action>();
  const newFetcher = useFetcher<typeof action>();
  const [ask, setAsk] = useState("");
  // The most recent conversation reloads with the page from the
  // database; new exchanges append to it.
  const [transcript, setTranscript] = useState<Exchange[]>(loaderData.messages);
  const today = useToday();

  const result = fetcher.data as
    | (TranslateOk & { fresh?: boolean })
    | TranslateErr
    | undefined;
  useEffect(() => {
    if (!result) return;
    // "New conversation" starts a fresh exchange stream.
    if ("fresh" in result && result.fresh) {
      if (fetcher.state === "idle") setTranscript([]);
      return;
    }
    // Fill the answer into the newest exchange (pushed optimistically at
    // submit time); idempotent across re-renders.
    if (fetcher.state === "idle") {
      setTranscript((t) => {
        const last = t[t.length - 1];
        if (!last || last.answer !== "") return t;
        const copy = [...t];
        copy[copy.length - 1] = {
          ...last,
          answer: result.ok
            ? result.answer
            : (result.error ?? "Something went wrong."),
          ...(result.ok
            ? {
                chart: result.chart,
                query: result.query,
                months: result.months,
                title: result.title,
              }
            : {}),
        };
        return copy;
      });
    }
  }, [result, fetcher.state]);

  // "New conversation" clears the transcript once the fresh conversation
  // row exists.
  const newResult = newFetcher.data as
    | { ok: boolean; fresh: boolean }
    | undefined;
  useEffect(() => {
    if (newResult?.ok && newResult.fresh && newFetcher.state === "idle") {
      setTranscript([]);
    }
  }, [newResult, newFetcher.state]);

  const busy = fetcher.state !== "idle";

  // Each chart exchange renders its own view from the shared expense
  // snapshot and its own filter/window.
  const views = useMemo(
    () =>
      transcript.map((ex) => {
        if (!ex.chart || !today) {
          return {
            ex,
            buckets: [] as MonthBucket[],
            matched: [] as InsightExpense[],
          };
        }
        const buckets = monthlyTotals(
          loaderData.expenses,
          ex.query,
          today,
          ex.months,
        );
        const matched = matchingExpenses(
          loaderData.expenses,
          ex.query,
          buckets,
        );
        return { ex, buckets, matched };
      }),
    [transcript, loaderData.expenses, today],
  );

  // Chat scroll: the transcript is its own scroll region (hidden
  // scrollbar); new answers scroll into view only when the user is
  // already near the bottom, never yanking them out of history.
  const scrollRef = useRef<HTMLDivElement>(null);
  const askRef = useRef<HTMLInputElement>(null);
  const nearBottom = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  // On load: land at the end of the restored conversation with the input
  // focused (instant scroll — smooth is for new answers, not page load).
  // Re-scroll briefly after mount: fonts and the chart SVG settle after
  // hydration and grow the content past the first scroll position.
  useEffect(() => {
    const scrollToEnd = () => {
      const el = scrollRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight });
    };
    scrollToEnd();
    const raf = requestAnimationFrame(scrollToEnd);
    const timer = window.setTimeout(scrollToEnd, 250);
    askRef.current?.focus({ preventScroll: true });
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [today]);
  // Skip the initial run: page load is handled by the settle effect above
  // (a smooth animation racing it leaves the view stranded mid-scroll).
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const el = scrollRef.current;
    if (!el || !nearBottom.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [transcript]);

  return (
    <PageShell
      icon={<ChartColumn aria-hidden="true" className="h-6 w-6" />}
      title="Insights"
      maxWidth="max-w-3xl"
      fullHeight
      headerRight={
        <newFetcher.Form method="post">
          <input type="hidden" name="intent" value="new" />
          <Button type="submit" variant="secondary" size="sm">
            <SquarePen aria-hidden="true" className="h-4 w-4" /> New chat
          </Button>
        </newFetcher.Form>
      }
    >
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {transcript.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Ask a question to get started.
            </p>
          </div>
        ) : null}
        {views.map(({ ex, buckets, matched }, i) => {
          const total = buckets.reduce((sum, b) => sum + b.total, 0);
          const count = matched.length;
          return (
            <Card key={i} className="p-4">
              <p className="text-sm font-medium text-gray-800 dark:text-gray-100">
                {ex.question}
              </p>
              {ex.answer ? (
                <div className="mt-1 text-sm text-gray-600 dark:text-gray-300 [&_strong]:font-semibold [&_strong]:text-gray-800 dark:[&_strong]:text-gray-100">
                  <Markdown text={ex.answer} />
                </div>
              ) : (
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                  {busy && i === views.length - 1
                    ? "Thinking…"
                    : "No answer recorded."}
                </p>
              )}
              {ex.chart && today ? (
                <>
                  <div className="mb-3 mt-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm text-gray-600 dark:text-gray-300">
                      {ex.title} ·{" "}
                      {count
                        ? `${count} ${count === 1 ? "expense" : "expenses"} · ${usd.format(total)} total`
                        : "No expenses in this window"}
                    </p>
                    <p className="text-xs text-gray-400 dark:text-gray-500">
                      {ex.months === -1
                        ? "This year"
                        : ex.months === 0
                          ? "All time"
                          : `${ex.months} months`}
                    </p>
                  </div>
                  <MonthlyChart buckets={buckets} />
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
                            <th
                              scope="col"
                              className="py-1.5 text-right font-medium"
                            >
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
                </>
              ) : null}
            </Card>
          );
        })}
      </div>

      <Card className="p-4">
        {loaderData.aiEnabled ? (
          <div className="flex flex-col gap-2">
            <fetcher.Form
              method="post"
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                if (!ask.trim() || busy) {
                  e.preventDefault();
                  return;
                }
                setTranscript((t) => [
                  ...t,
                  {
                    question: ask.trim(),
                    answer: "",
                    chart: false,
                    query: "",
                    months: 12,
                    title: "",
                  },
                ]);
                setAsk("");
              }}
            >
              <input type="hidden" name="intent" value="translate" />
              <input type="hidden" name="today" value={today ?? ""} />
              <input
                type="hidden"
                name="localTime"
                value={new Date().toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              />
              <input
                type="hidden"
                name="tz"
                value={
                  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
                }
              />
              <div className="flex gap-2">
                <Input
                  ref={askRef}
                  id="insights-ask"
                  name="text"
                  type="text"
                  value={ask}
                  onChange={(e) => setAsk(e.target.value)}
                  autoComplete="off"
                  placeholder='e.g. "did I spend more on AI this month than last?"'
                  className="min-w-0 flex-1"
                />
                <Button type="submit" disabled={busy}>
                  <Sparkles aria-hidden="true" className="h-4 w-4" />
                  {busy ? "Thinking…" : "Ask"}
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
          </div>
        ) : (
          <div className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
            <Sparkles aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Conversational search ("did I spend more on AI this month?",
              "what's my medical spend this year?") is available on paid and
              gratis accounts.
            </p>
          </div>
        )}
      </Card>
    </PageShell>
  );
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
