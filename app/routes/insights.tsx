import {
  ChartColumn,
  Check,
  Lightbulb,
  Sparkles,
  SquarePen,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import { RevealText } from "~/components/RevealText";
import { authLockedUntil, recordAuthFailure } from "~/lib/db/auth-attempts";
import { PageShell } from "~/components/PageShell";
import { Card } from "~/components/ui/Card";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { MonthlyChart } from "~/components/MonthlyChart";
import { requireUser } from "~/lib/auth.server";
import { readAccount, readAccountUsers } from "~/lib/db/accounts";
import { readCategories } from "~/lib/db/categories";
import { readExpenses } from "~/lib/db/expenses";
import { readLocations } from "~/lib/db/locations";
import { readReports } from "~/lib/db/reports";
import { readSettings } from "~/lib/db/settings";
import {
  appendExchange,
  readLatestConversation,
  startNewConversation,
} from "~/lib/db/insights-chat";
import { countLabel, formatShortDate, formatUsd } from "~/lib/format";
import {
  insightExpense,
  insightStarters,
  insightSummary,
  knownMerchants,
  matchingExpenses,
  pickStarter,
  recentTripStops,
  monthlyTotals,
  type InsightExpense,
  type MonthBucket,
} from "~/lib/insights";
import {
  parseTripConfirmation,
  type PendingTrip,
} from "~/lib/insights-mileage-tool.server";
import { resolveMileage, saveMileageTrip } from "~/lib/mcp-write.server";
import { MILEAGE_TYPE_LABELS, formatRate } from "~/lib/mileage-rates";
import {
  answerInsightQuestion,
  insightProfile,
  insightReportNames,
  translateInsightQuery,
  LLMError,
} from "~/lib/insights-ai.server";
import { periodScope, withPeriodRange } from "~/lib/insight-periods";
import { useToday } from "~/lib/use-today";
import { formString, unknownIntent } from "~/lib/validation";
import type { Route } from "./+types/insights";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const [conversation, expenses] = await Promise.all([
    readLatestConversation(user.id),
    readExpenses(user.accountId),
  ]);
  return {
    expenses: expenses.map(insightExpense),
    // The most recent conversation reloads with the page; older ones stay
    // in the database as a record.
    messages: conversation?.exchanges ?? [],
    // The opening starter is picked at random; visual-regression captures
    // need that pick deterministic (the same env pin _index.tsx uses for
    // the home highlight). Read here because only server code can see
    // process.env; the flag travels to the browser in loader data.
    pinStarter: process.env.SCREENSHOT_HIGHLIGHT_PIN === "1",
  };
}

/** Two grounded LLM calls: the question becomes a
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
  if (intent === "confirm") {
    // The confirm card's submission, not a model call: it makes no LLM
    // request and costs no throttle. The payload carries only the trip's
    // inputs, so a re-resolved trip is the only thing that gets filed.
    const confirmed = parseTripConfirmation(formString(form, "pending"));
    if (!confirmed) {
      return {
        ok: false as const,
        error: "That trip is no longer available. Ask for it again.",
      };
    }
    const resolved = await resolveMileage(user.accountId, {
      locations: confirmed.stops,
      date: confirmed.date,
      type: confirmed.type,
      report: confirmed.report,
    });
    if (!resolved.ok) return { ok: false as const, error: resolved.error };
    const saved = await saveMileageTrip(user.accountId, resolved.trip, {
      description: confirmed.description,
    });
    // The reply reports the STORED figures: if the routing service changed
    // state between the proposal and the confirm, the user sees what was
    // actually filed, not what was previewed.
    const distance = saved.distanceMiles
      ? `${saved.distanceMiles} mi`
      : "a trip";
    const amount = saved.amount
      ? ` for ${formatUsd(Number(saved.amount))}`
      : "";
    const note = resolved.trip.approximate
      ? " (straight-line estimate — the route service was unavailable)"
      : "";
    const answer = `Logged ${distance}${amount} on ${resolved.trip.date}${note}.`;
    await appendExchange(user.id, user.accountId, {
      question: "Log it",
      answer,
      chart: false,
      query: "",
      months: 12,
      title: "Logged the trip",
    });
    return {
      ok: true as const,
      answer,
      logged: {
        expenseId: saved.expenseId,
        distanceMiles: saved.distanceMiles,
        amount: saved.amount,
      },
    };
  }
  if (intent !== "translate") return unknownIntent();
  // Same bound the translator applies internally, so the answer call and
  // the stored exchange never see an uncapped string.
  const text = formString(form, "text").trim().slice(0, 500);
  if (!text) return { ok: false as const, error: "Type a question first." };

  // The client's local today: the server must not guess the user's day.
  const today = formString(form, "today");
  const localTime = formString(form, "localTime");
  // The client's IANA timezone: report dates are formatted in it (the
  // server's clock is UTC and must not guess the user's zone).
  const tz = formString(form, "tz");

  // Cost throttle: every translate request drives two LLM calls. A
  // per-user counter on the auth_attempts keyspace (a rate limit here,
  // not a lockout: each request counts as one "failure") keeps scripted
  // loops from running up the bill. THROTTLE-2 class counter; the plan
  // gate lands with the plan feature itself.
  const throttleKey = `insights:${user.id}`;
  if (await authLockedUntil(throttleKey)) {
    return {
      ok: false as const,
      error: "Too many questions in a row. Try again in a few minutes.",
    };
  }
  await recordAuthFailure(throttleKey, {
    windowMs: 15 * 60_000,
    threshold: 12,
    lockMs: 15 * 60_000,
  });

  const [account, categories, reports, settings, members, locations] =
    await Promise.all([
      readAccount(user.accountId),
      readCategories(user.accountId),
      readReports(user.accountId),
      readSettings(user.accountId),
      readAccountUsers(user.accountId),
      readLocations(user.accountId),
    ]);
  const expenses = (await readExpenses(user.accountId)).map(insightExpense);
  const merchants = knownMerchants(expenses);
  // The settings lists are authoritative (they include unused entries,
  // unlike the ones derived from expenses).
  const categoryNames = categories.map((c) => c.name);
  const reportNames = insightReportNames(reports, tz);
  const profile = insightProfile({
    account,
    settings,
    locations: locations.map((l) => ({ name: l.name, address: l.address })),
    userEmail: user.email,
    members,
    categories,
    reports,
    recentStops: recentTripStops(expenses, settings.homeAddress),
    tz,
  });
  // Full anchor: an unanchored pattern let padded strings (multi-MB
  // prompt stuffing) ride into the answer prompt (INS-INPUT-1-RESIDUAL).
  // The page sends toLocaleTimeString("en-US", {hour, minute}).
  const localTimeOk = /^\d{1,2}:\d{2}( [AP]M)?$/i.test(localTime);
  const conversation = await readLatestConversation(user.id);
  try {
    const translated = await translateInsightQuery({
      text,
      history: conversation?.exchanges.slice(-3) ?? [],
      today,
      merchants,
      categories: categoryNames,
      reports: reportNames,
    });
    // The app owns the period (range and chart shape): a day, a week, or a
    // single-month window has no monthly shape to plot, so the model's
    // guess is replaced whenever the question names a period (see
    // insight-periods).
    const scope = periodScope(text, today);
    const t = {
      ...translated,
      query: withPeriodRange(translated.query, text, today),
      ...(scope ? { chart: scope.chart, months: scope.months } : {}),
    };
    // Ground the text answer in real numbers: compute the same view the
    // chart shows and let the model phrase it. Invalid client dates (the
    // field is always sent by this page) degrade to a chart-only answer.
    if (/^\d{4}-\d{2}-\d{2}$/.test(today)) {
      const buckets = monthlyTotals(expenses, t.query, today, t.months);
      const matched = matchingExpenses(expenses, t.query, buckets);
      const { answer, pending } = await answerInsightQuestion({
        question: text,
        history: conversation?.exchanges.slice(-3) ?? [],
        summary: insightSummary(buckets, matched),
        // The read tool queries the request's own snapshot, so a follow-up
        // question ("what about this week?") needs no second DB read.
        expenses,
        // The plan tool resolves a trip the user asked to log; the app
        // files it only when the confirm card is submitted. The report
        // names are the plain ones (the profile annotates them for the
        // model, but a stored expense's report must be the bare name).
        writes: {
          accountId: user.accountId,
          reportNames: reports.map((r) => r.name),
          today,
        },
        // The answer step needs the user's local DATE, not just the clock:
        // the chart data is month-bucketed, so without this a "what's
        // today?" question gets a date inferred from the expense rows.
        // Same `Current date:` wording the translator prompt uses.
        profile: [
          profile,
          `Current date: ${today} (user's local date)`,
          ...(localTimeOk
            ? [`Current time: ${localTime} (user's local clock)`]
            : []),
        ].join("\n"),
      });
      await appendExchange(user.id, user.accountId, {
        question: text,
        answer,
        chart: t.chart,
        query: t.query,
        months: t.months,
        title: t.title,
      });
      // The proposal is a one-shot UI affordance, never persisted: a reload
      // drops the card, and asking again plans a fresh trip.
      return {
        ok: true as const,
        ...t,
        answer,
        ...(pending ? { pending } : {}),
      };
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
  /** A mileage trip the model worked out for the user to confirm. */
  pending?: PendingTrip;
}
interface TranslateErr {
  ok: false;
  error: string;
}

/** A confirmed trip was filed: the stored figures and the line the server
 * recorded as the exchange's answer. */
interface ConfirmOk {
  ok: true;
  answer: string;
  logged: {
    expenseId: string;
    distanceMiles: string;
    amount: string;
  };
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
  /** A trip this exchange proposed, until the user logs or discards it. */
  pending?: PendingTrip;
}

const EXAMPLES = ["my AI expenses", "coffee", "software", "travel"];

/** The rows behind a chart: collapsed by default, since the chart answers
 * the question and the table is the evidence. The toggle is a real
 * disclosure (aria-expanded), so it reads correctly to assistive tech. */
export function ExpenseTable({ expenses }: { expenses: InsightExpense[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="mt-4">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide" : "Show"} {expenses.length}{" "}
        {expenses.length === 1 ? "expense" : "expenses"}
      </Button>
      {open ? (
        <div id={id} className="mt-2 overflow-x-auto">
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
              {expenses.map((e) => (
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
                    {formatUsd(Number(e.amount) || 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export default function InsightsPage({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof action>();
  const newFetcher = useFetcher<typeof action>();
  const confirmFetcher = useFetcher<typeof action>();
  const [ask, setAsk] = useState("");
  // The most recent conversation reloads with the page from the
  // database; new exchanges append to it.
  const [transcript, setTranscript] = useState<Exchange[]>(loaderData.messages);
  // Which exchange's confirm card was submitted: the one whose pending
  // proposal this reply answers.
  const [confirmedIndex, setConfirmedIndex] = useState<number | null>(null);
  const today = useToday();
  // True while the newest answer is being revealed; restored history
  // never animates.
  const [revealing, setRevealing] = useState(false);

  const result = fetcher.data as
    | (TranslateOk & { fresh?: boolean })
    | TranslateErr
    | undefined;
  useEffect(() => {
    if (!result) return;
    // "New conversation" starts a fresh exchange stream.
    if ("fresh" in result && result.fresh) {
      if (fetcher.state === "idle") setTranscript([]);
      setRevealing(false);
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
                ...(result.pending ? { pending: result.pending } : {}),
              }
            : {}),
        };
        return copy;
      });
      // A fresh answer reveals progressively; see RevealText.
      setRevealing(true);
    }
  }, [result, fetcher.state]);

  // A confirmed trip: the card is replaced by the exchange the server
  // recorded, so the transcript reads the same after a reload.
  const confirmResult = confirmFetcher.data as
    | ConfirmOk
    | TranslateErr
    | undefined;
  const handledConfirm = useRef<unknown>(null);
  useEffect(() => {
    if (!confirmResult || confirmFetcher.state !== "idle") return;
    // The fetcher's data survives re-renders; only a new reply may append.
    if (handledConfirm.current === confirmResult) return;
    handledConfirm.current = confirmResult;
    if (!confirmResult.ok || !("logged" in confirmResult)) return;
    const answer = confirmResult.answer;
    setTranscript((t) => [
      ...t.map((ex, i) =>
        i === confirmedIndex ? { ...ex, pending: undefined } : ex,
      ),
      {
        question: "Log it",
        answer,
        chart: false,
        query: "",
        months: 12,
        title: "Logged the trip",
      },
    ]);
    setConfirmedIndex(null);
  }, [confirmResult, confirmFetcher.state, confirmedIndex]);

  /** Drop a proposal the user does not want (nothing was filed). */
  const discardTrip = (index: number) => {
    setTranscript((t) =>
      t.map((ex, i) => (i === index ? { ...ex, pending: undefined } : ex)),
    );
  };

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

  // The opening card: one computed fact about the account, rotating per
  // visit (the "start with an answer" pattern). Computed client-side
  // from the loaded expenses and the local today, so no server timezone
  // and no LLM call. Under the screenshot pin (loaderData.pinStarter)
  // the pick is the first starter so captures stay deterministic.
  const starter = useMemo(
    () =>
      today
        ? pickStarter(
            insightStarters(loaderData.expenses, today),
            loaderData.pinStarter ? () => 0 : undefined,
          )
        : null,
    [loaderData.expenses, loaderData.pinStarter, today],
  );

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
  // Observes the transcript content: a rendered answer (markdown blocks,
  // chart SVG, images) keeps growing after the state update lands, so the
  // "scroll to the new answer" effect alone strands the view above it.
  const contentRef = useRef<HTMLDivElement>(null);
  // True while a question is in flight: follow the bottom unconditionally
  // (asking a question is an explicit request to watch the answer).
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    const content = contentRef.current;
    const el = scrollRef.current;
    if (!content || !el) return;
    const ro = new ResizeObserver(() => {
      if (nearBottom.current || busyRef.current) {
        nearBottom.current = true;
        el.scrollTo({ top: el.scrollHeight });
      }
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);
  // Submitting a question jumps to the bottom even if the user had
  // scrolled up: the answer renders there.
  useEffect(() => {
    if (!busy) return;
    const el = scrollRef.current;
    if (!el) return;
    nearBottom.current = true;
    el.scrollTo({ top: el.scrollHeight });
  }, [busy]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  // The input focus stays explicit; landing at the end and following the
  // growing answer are both the ResizeObserver's job above (its initial
  // observation fires on mount, and every later content change re-fires:
  // fonts, chart SVG, the reveal's own growth).
  useEffect(() => {
    askRef.current?.focus({ preventScroll: true });
  }, [today]);

  return (
    <PageShell
      icon={<ChartColumn aria-hidden="true" className="h-6 w-6" />}
      title="Insights"
      maxWidth="max-w-3xl"
      fullHeight
      headerRight={
        <newFetcher.Form method="post">
          <input type="hidden" name="intent" value="new" />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            className="px-1.5 sm:px-3"
          >
            <SquarePen aria-hidden="true" className="h-4 w-4" />
            <span className="hidden sm:inline">New chat</span>
          </Button>
        </newFetcher.Form>
      }
    >
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div ref={contentRef} className="space-y-4">
          {transcript.length === 0 && starter ? (
            <Card className="p-4">
              <div className="flex items-start gap-2">
                <Lightbulb
                  aria-hidden="true"
                  className="mt-0.5 h-4 w-4 shrink-0 text-amber-500 dark:text-amber-400"
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-100">
                    {starter.question}
                  </p>
                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                    {starter.answer}
                  </p>
                </div>
              </div>
            </Card>
          ) : transcript.length === 0 ? (
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
                    <RevealText
                      text={ex.answer}
                      reveal={revealing && i === views.length - 1}
                      onDone={() => setRevealing(false)}
                    />
                  </div>
                ) : (
                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                    {busy && i === views.length - 1
                      ? "Thinking…"
                      : "No answer recorded."}
                  </p>
                )}
                {/* The proposed trip: the model resolved it, the user
                 * files it. Nothing is written until "Log trip" submits
                 * (and the server re-resolves then, so the numbers shown
                 * are the server's, not the client's). */}
                {ex.pending ? (
                  <Card variant="amber" className="mt-3 p-3">
                    <p className="text-xs font-medium tracking-wide text-amber-700 uppercase dark:text-amber-300">
                      Mileage trip
                    </p>
                    <p className="mt-1 text-sm text-gray-800 dark:text-gray-100">
                      {ex.pending.stops.map((stop) => stop.address).join(" → ")}
                    </p>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                      {[
                        ex.pending.distanceMiles
                          ? `${ex.pending.distanceMiles} mi`
                          : "",
                        ex.pending.amount
                          ? formatUsd(Number(ex.pending.amount))
                          : "",
                        MILEAGE_TYPE_LABELS[ex.pending.type],
                        formatShortDate(ex.pending.date),
                        ex.pending.rate
                          ? `$${formatRate(ex.pending.rate)}/mi`
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {ex.pending.approximate ? (
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        Straight-line estimate: the route service was
                        unavailable.
                      </p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <confirmFetcher.Form
                        method="post"
                        onSubmit={() => setConfirmedIndex(i)}
                      >
                        <input type="hidden" name="intent" value="confirm" />
                        <input
                          type="hidden"
                          name="pending"
                          value={JSON.stringify({
                            stops: ex.pending.stops,
                            date: ex.pending.date,
                            type: ex.pending.type,
                            report: ex.pending.report,
                            description: ex.pending.description,
                          })}
                        />
                        <Button
                          type="submit"
                          size="sm"
                          className="px-2 sm:px-4"
                          disabled={confirmFetcher.state !== "idle"}
                        >
                          <Check aria-hidden="true" className="h-4 w-4" />
                          Log trip
                        </Button>
                      </confirmFetcher.Form>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="px-2 sm:px-4"
                        onClick={() => discardTrip(i)}
                      >
                        Discard
                      </Button>
                    </div>
                    {confirmResult &&
                    !confirmResult.ok &&
                    i === confirmedIndex ? (
                      <p className="mt-2 text-sm text-red-700 dark:text-red-400">
                        {confirmResult.error}
                      </p>
                    ) : null}
                  </Card>
                ) : null}
                {/* Chart + table wait for the text reveal to finish, so
                 * the answer streams in like a sentence, not a pop-in. */}
                {ex.chart && today && !(revealing && i === views.length - 1) ? (
                  <>
                    <div className="mb-3 mt-3 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm text-gray-600 dark:text-gray-300">
                        {ex.title} ·{" "}
                        {count
                          ? `${countLabel(count)} · ${formatUsd(total)} total`
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
                      <ExpenseTable expenses={matched} />
                    ) : null}
                  </>
                ) : null}
              </Card>
            );
          })}
        </div>
      </div>

      <Card className="p-4">
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
              setRevealing(false);
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
              value={Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}
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
      </Card>
    </PageShell>
  );
}
