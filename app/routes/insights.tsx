import {
  ChartColumn,
  Check,
  Lightbulb,
  Sparkles,
  Square,
  SquarePen,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import { RevealText } from "~/components/RevealText";
import { authLockedUntil, recordAuthFailure } from "~/lib/db/auth-attempts";
import { PageShell } from "~/components/PageShell";
import { Alert } from "~/components/ui/Alert";
import { Card } from "~/components/ui/Card";
import { Button } from "~/components/ui/Button";
import { Textarea } from "~/components/ui/Textarea";
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
import { parseExpenseConfirmation } from "~/lib/insights-expense-tool.server";
import { parseTripConfirmation } from "~/lib/insights-mileage-tool.server";
import {
  resolveExpense,
  resolveMileage,
  saveMileageTrip,
  saveReceiptExpense,
} from "~/lib/mcp-write.server";
import { MILEAGE_TYPE_LABELS, formatRate } from "~/lib/mileage-rates";
import type { ProposalKind } from "~/lib/types";
import { formatFxRate } from "~/lib/fx-note";
import {
  answerInsightQuestion,
  insightProfile,
  insightReportNames,
  translateInsightQuery,
  LLMError,
  type PendingProposal,
} from "~/lib/insights-ai.server";
import { periodScope, withPeriodRange } from "~/lib/insight-periods";
import { useToday } from "~/lib/use-today";
import { captureError } from "~/lib/errors.server";
import { requireIntent } from "~/lib/route-helpers.server";
import { formString, unknownIntent } from "~/lib/validation";
import type { Route } from "./+types/insights";

/**
 * Record an exchange without failing the work that produced it: the row (or
 * the answer) is the deliverable, and the transcript is the retelling the
 * model reads back next turn.
 */
async function recordExchange(
  user: { id: string; accountId: string },
  exchange: Parameters<typeof appendExchange>[2],
): Promise<void> {
  try {
    await appendExchange(user.id, user.accountId, exchange);
  } catch (err) {
    captureError(err, { where: "insights-record-exchange" });
  }
}

/** The transcript entry for a filed proposal: both confirm branches write
 * the same shape, differing only in the answer, the title, and the review
 * link they carry. */
function logFiledExchange(
  user: { id: string; accountId: string },
  entry: {
    title: string;
    answer: string;
    expenseId: string;
    proposalKind: ProposalKind;
  },
): Promise<void> {
  return recordExchange(user, {
    question: "Log it",
    answer: entry.answer,
    chart: false,
    query: "",
    months: 12,
    title: entry.title,
    expenseId: entry.expenseId,
    proposalKind: entry.proposalKind,
  });
}

/**
 * Confirming a proposal writes rows and can call the FX or routing
 * providers, and the plan tools already gate the question that proposed
 * them. This is the matching gate on the confirmation itself: a separate
 * key family from the question budget (a user who asks several questions
 * must still be able to confirm each one), high enough that only a scripted
 * loop ever reaches it.
 */
async function overWriteBudget(userId: string): Promise<boolean> {
  const key = `insights-write:${userId}`;
  if (await authLockedUntil(key)) return true;
  await recordAuthFailure(key, {
    windowMs: 15 * 60_000,
    threshold: 30,
    lockMs: 5 * 60_000,
  });
  return false;
}

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
  const { user, form, intent } = await requireIntent(request);
  if (intent === "new") {
    // Start a fresh conversation; the previous one stays in the database
    // as a record. No LLM call, so no plan gate needed here.
    await startNewConversation(user.id, user.accountId);
    return { ok: true as const, fresh: true };
  }
  if (intent === "confirm") {
    if (await overWriteBudget(user.id)) {
      return {
        ok: false as const,
        error: "Too many changes in a row. Try again in a few minutes.",
      };
    }
    // The confirm card's submission, not a model call: it makes no LLM
    // request and costs no question budget. The payload carries only the
    // trip's inputs, so a re-resolved trip is the only thing that gets
    // filed.
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
      roundTrip: confirmed.roundTrip,
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
    await logFiledExchange(user, {
      title: "Logged the trip",
      answer,
      // The transcript links to the filed trip, so it can be reviewed and
      // corrected long after this reply scrolls away.
      expenseId: saved.expenseId,
      proposalKind: "mileage",
    });
    return {
      ok: true as const,
      answer,
      proposalKind: "mileage" as const,
      logged: {
        expenseId: saved.expenseId,
        distanceMiles: saved.distanceMiles,
        amount: saved.amount,
      },
    };
  }
  if (intent === "confirmExpense") {
    if (await overWriteBudget(user.id)) {
      return {
        ok: false as const,
        error: "Too many changes in a row. Try again in a few minutes.",
      };
    }
    // Same shape as the trip confirm: no LLM call, no question budget. The
    // card posts the fields the user described, and the server resolves them
    // again, so nothing the client sends is filed on trust.
    const confirmed = parseExpenseConfirmation(formString(form, "pending"));
    if (!confirmed) {
      return {
        ok: false as const,
        error: "That expense is no longer available. Ask for it again.",
      };
    }
    // Re-resolved against the account, never trusted from the card: the
    // amount is re-normalized and the category re-picked here.
    const resolved = await resolveExpense(user.accountId, confirmed);
    if (!resolved.ok) return { ok: false as const, error: resolved.error };
    const saved = await saveReceiptExpense(user.accountId, resolved.expense);
    const filed = resolved.expense;
    const at = filed.merchant ? ` at ${filed.merchant}` : "";
    // A foreign purchase reports both figures: the dollars the app stored and
    // what the user actually paid.
    const printed =
      filed.currency !== "USD" && filed.originalAmount
        ? ` (${filed.currency} ${filed.originalAmount})`
        : "";
    const answer = `Logged ${formatUsd(Number(filed.amount))}${printed}${at} on ${filed.date}.`;
    await logFiledExchange(user, {
      title: "Logged the expense",
      answer,
      expenseId: saved.expenseId,
      proposalKind: "expense",
    });
    return {
      ok: true as const,
      answer,
      proposalKind: "expense" as const,
      logged: { expenseId: saved.expenseId },
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
      // The browser's own signal: pressing Stop aborts the fetch, which
      // aborts this request, which cancels the provider call.
      signal: request.signal,
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
        signal: request.signal,
      });
      // The browser went away (the user pressed Stop): the answer has no
      // reader, and a transcript row nobody saw is a lie about the
      // conversation.
      if (request.signal.aborted) {
        return { ok: false as const, error: "Stopped." };
      }
      await recordExchange(user, {
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
    // A cancelled request is not a failure to report: the user asked for
    // it. Checked first because the cancelled provider call arrives here
    // as an LLMError, and Sentry should not hear about an intentional stop.
    if (request.signal.aborted) {
      return { ok: false as const, error: "Stopped." };
    }
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
  /** A trip or a purchase the model worked out for the user to confirm. */
  pending?: PendingProposal;
}
interface TranslateErr {
  ok: false;
  error: string;
}

/** A confirmed proposal was filed: what it was, the line the server
 * recorded as the exchange's answer, and the stored figures. */
interface ConfirmOk {
  ok: true;
  answer: string;
  /** Which plan tool the confirmed proposal came from: the transcript labels
   * its review link with it. */
  proposalKind: ProposalKind;
  logged: {
    expenseId: string;
    /** Trip only; absent for an expense. */
    distanceMiles?: string;
    amount?: string;
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
  /** A trip or a purchase this exchange proposed, until the user logs or
   * discards it. */
  pending?: PendingProposal;
  /** The expense a logged proposal filed, linked for review. */
  expenseId?: string;
  /** What that link points at; the card is gone by the time it renders. */
  proposalKind?: ProposalKind;
  /** The user stopped this question before it answered; client-only, never
   * persisted (see markPendingStopped). */
  stopped?: boolean;
}

const EXAMPLES = ["my AI expenses", "coffee", "software", "travel"];

/** How many lines the composer's question field grows to before it starts to
 * scroll: past that it would eat the transcript it is asking about. */
const ASK_MAX_LINES = 5;

/** The newest exchange with no answer yet: the question the composer is
 * waiting on, or -1 when nothing is in flight. A stopped exchange is not
 * pending: its request was aborted, so nothing is coming for it. */
function pendingIndex(t: Exchange[]): number {
  const last = t[t.length - 1];
  return last && last.answer === "" && !last.stopped ? t.length - 1 : -1;
}

/** Mark the in-flight question stopped: the card keeps the question the user
 * asked and drops the "Thinking…" placeholder. Pure. */
function markPendingStopped(t: Exchange[]): Exchange[] {
  const i = pendingIndex(t);
  if (i === -1) return t;
  return t.map((ex, j) => (j === i ? { ...ex, stopped: true } : ex));
}

/** The proposal card's chrome, shared by both kinds: the amber eyebrow, the
 * primary line, the facts row and the muted note. */
const PROPOSAL_EYEBROW =
  "text-xs font-medium tracking-wide text-amber-700 uppercase dark:text-amber-300";
const PROPOSAL_PRIMARY = "mt-1 text-sm text-gray-800 dark:text-gray-100";
const PROPOSAL_FACTS = "mt-1 text-sm text-gray-600 dark:text-gray-300";
const PROPOSAL_NOTE = "mt-1 text-xs text-gray-500 dark:text-gray-400";

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
  // The composer's own failure line. Held in state rather than read from
  // fetcher.data, so it clears the moment the next question is sent (and
  // never reappears from a fetcher's retained data).
  const [composerError, setComposerError] = useState<string | null>(null);
  // The composer form, submitted imperatively: the hidden intent/today/
  // localTime/tz inputs stay the single source of the request body, and
  // `text` is overridden with the trimmed question.
  const formRef = useRef<HTMLFormElement>(null);

  const result = fetcher.data as TranslateOk | TranslateErr | undefined;
  useEffect(() => {
    if (!result) return;
    if (fetcher.state !== "idle") return;
    // Fill the answer into the question the composer is waiting on (pushed
    // optimistically at submit time); idempotent across re-renders, and a
    // stopped card is skipped: its row was never recorded.
    setTranscript((t) => {
      const i = pendingIndex(t);
      if (i === -1) return t;
      const copy = [...t];
      copy[i] = {
        ...copy[i]!,
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
    setComposerError(
      result.ok ? null : (result.error ?? "Something went wrong."),
    );
  }, [result, fetcher.state]);

  // A confirmed proposal: the card is replaced by the exchange the server
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
    const expenseId = confirmResult.logged.expenseId;
    const proposalKind = confirmResult.proposalKind;
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
        title:
          proposalKind === "expense" ? "Logged the expense" : "Logged the trip",
        expenseId,
        proposalKind,
      },
    ]);
    setConfirmedIndex(null);
  }, [confirmResult, confirmFetcher.state, confirmedIndex]);

  /** Drop a proposal the user does not want (nothing was filed). */
  const discardProposal = (index: number) => {
    setTranscript((t) =>
      t.map((ex, i) => (i === index ? { ...ex, pending: undefined } : ex)),
    );
  };

  // "New conversation" clears the transcript optimistically (see the
  // header form): the intent has no failure branch, so waiting for the
  // round trip would only make the button feel broken.

  const busy = fetcher.state !== "idle";
  // While a question is in flight an empty field means Stop; a field with the
  // next question means Ask (which interrupts). The composer is never dead.
  const stopping = busy && !ask.trim();

  /** Send the typed question. While one is already in flight this is a
   * barge-in: that question is marked stopped, its request is aborted, and
   * the new question goes out. */
  const askQuestion = () => {
    const text = ask.trim();
    const form = formRef.current;
    if (!text || !form) return;
    setTranscript((t) => [
      ...markPendingStopped(t),
      {
        question: text,
        answer: "",
        chart: false,
        query: "",
        months: 12,
        title: "",
      },
    ]);
    setAsk("");
    setRevealing(false);
    setComposerError(null);
    // Abort the in-flight question before submitting: reset() is the
    // documented way to cancel a fetcher, and the interrupted answer must
    // not land in the new card.
    if (busy) fetcher.reset();
    const data = new FormData(form);
    data.set("text", text);
    // flushSync flips the composer to Stop in the same paint as the click,
    // instead of riding a transition behind the reveal's interval. The
    // submission itself reports through fetcher state, not this promise.
    void fetcher.submit(data, { method: "post", flushSync: true });
    // Keep the field hot: the next question is typed, not re-targeted.
    askRef.current?.focus({ preventScroll: true });
  };

  /** Stop waiting on the in-flight question. Its request is aborted, so the
   * server records nothing. */
  const stopAnswer = () => {
    const i = pendingIndex(transcript);
    const question = i === -1 ? null : transcript[i]!.question;
    setTranscript(markPendingStopped);
    // Hand the question back, unless the user has already typed the next one.
    if (question && !ask.trim()) setAsk(question);
    fetcher.reset();
    askRef.current?.focus({ preventScroll: true });
  };

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
  const askRef = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  // Observes the transcript content: a rendered answer (markdown blocks,
  // chart SVG, images) keeps growing after the state update lands, so the
  // "scroll to the new answer" effect alone strands the view above it.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const content = contentRef.current;
    const el = scrollRef.current;
    if (!content || !el) return;
    // Follow a growing answer only while the user is at the bottom:
    // scrolling up during a slow answer means they are reading, not waiting.
    const ro = new ResizeObserver(() => {
      if (nearBottom.current) el.scrollTo({ top: el.scrollHeight });
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

  // Grow the field with the question, up to ASK_MAX_LINES; past that it
  // scrolls. A textarea needs its height measured from the live element (CSS
  // cannot), and every bound comes from that element's computed style, so the
  // cap tracks the theme instead of a hardcoded pixel size. Runs on every path
  // that changes the text, including the Try chips and Stop handing the
  // question back.
  useEffect(() => {
    const el = askRef.current;
    if (!el) return;
    const styles = getComputedStyle(el);
    const lineHeight = Number.parseFloat(styles.lineHeight);
    const padding =
      Number.parseFloat(styles.paddingTop) +
      Number.parseFloat(styles.paddingBottom);
    // scrollHeight covers the padding box, not the border: without this the
    // box lands 2px short of its own text (a permanent 2px scroll).
    const border =
      Number.parseFloat(styles.borderTopWidth) +
      Number.parseFloat(styles.borderBottomWidth);
    const cap = lineHeight * ASK_MAX_LINES + padding + border;
    // Collapse to one row first, or a shrink measures the box it is still
    // sitting in and never comes back down.
    el.style.height = "auto";
    // Chrome sizes an empty textarea's intrinsic height from its placeholder,
    // so a phone (where the hint wraps) rests two lines tall and shows the
    // whole hint: clipping it leaves a sliver of the second line under the
    // text, which reads as damage.
    const needed = el.scrollHeight + border;
    el.style.height = `${Math.min(needed, cap)}px`;
    // Only a field past the cap scrolls: a scrollbar on an empty composer
    // (or one holding a clipped placeholder) is noise.
    el.style.overflowY = needed > cap ? "auto" : "hidden";
  }, [ask]);

  /**
   * One proposal card body: the amber eyebrow, the primary line, the facts
   * row, an optional note, then the confirm form (whose hidden payload is
   * the only thing submitted) and Discard. A plain function called from the
   * render rather than a component, so it can use the confirm fetcher and
   * the discard handler without prop plumbing; it holds no state.
   */
  const proposalCard = (proposal: {
    index: number;
    eyebrow: string;
    primary: string;
    facts: string[];
    note: string | null;
    intent: "confirm" | "confirmExpense";
    payload: unknown;
    label: string;
  }) => (
    <>
      <p className={PROPOSAL_EYEBROW}>{proposal.eyebrow}</p>
      <p className={PROPOSAL_PRIMARY}>{proposal.primary}</p>
      <p className={PROPOSAL_FACTS}>
        {proposal.facts.filter(Boolean).join(" · ")}
      </p>
      {proposal.note ? <p className={PROPOSAL_NOTE}>{proposal.note}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <confirmFetcher.Form
          method="post"
          onSubmit={() => setConfirmedIndex(proposal.index)}
        >
          <input type="hidden" name="intent" value={proposal.intent} />
          <input
            type="hidden"
            name="pending"
            value={JSON.stringify(proposal.payload)}
          />
          <Button
            type="submit"
            size="sm"
            className="px-2 sm:px-4"
            disabled={confirmFetcher.state !== "idle"}
          >
            <Check aria-hidden="true" className="h-4 w-4" /> {proposal.label}
          </Button>
        </confirmFetcher.Form>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="px-2 sm:px-4"
          onClick={() => discardProposal(proposal.index)}
        >
          Discard
        </Button>
      </div>
    </>
  );

  return (
    <PageShell
      icon={<ChartColumn aria-hidden="true" className="h-6 w-6" />}
      title="Insights"
      maxWidth="max-w-3xl"
      fullHeight
      headerRight={
        <newFetcher.Form
          method="post"
          onSubmit={() => {
            setTranscript([]);
            setRevealing(false);
            setComposerError(null);
          }}
        >
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
                    {ex.stopped
                      ? "Stopped."
                      : busy && i === views.length - 1
                        ? "Thinking…"
                        : "No answer recorded."}
                  </p>
                )}
                {/* The proposal: the model resolved it, the user files it.
                 * Nothing is written until the card's button submits (and
                 * the server re-resolves then, so the figures shown are the
                 * server's, not the client's). */}
                {ex.pending ? (
                  <Card variant="amber" className="mt-3 p-3">
                    {ex.pending.kind === "mileage"
                      ? proposalCard({
                          index: i,
                          eyebrow: "Mileage trip",
                          primary: ex.pending.stops
                            .map((stop) => stop.address)
                            .join(" → "),
                          facts: [
                            ex.pending.distanceMiles
                              ? `${ex.pending.distanceMiles} mi`
                              : "",
                            ex.pending.amount
                              ? formatUsd(Number(ex.pending.amount))
                              : "",
                            MILEAGE_TYPE_LABELS[ex.pending.type],
                            ex.pending.roundTrip ? "Round trip" : "One way",
                            formatShortDate(ex.pending.date),
                            ex.pending.rate
                              ? `$${formatRate(ex.pending.rate)}/mi`
                              : "",
                          ],
                          note: ex.pending.approximate
                            ? "Straight-line estimate: the route service was unavailable."
                            : null,
                          intent: "confirm",
                          payload: {
                            stops: ex.pending.stops,
                            date: ex.pending.date,
                            type: ex.pending.type,
                            report: ex.pending.report,
                            description: ex.pending.description,
                            roundTrip: ex.pending.roundTrip,
                          },
                          label: "Log trip",
                        })
                      : proposalCard({
                          index: i,
                          eyebrow: "Expense",
                          primary:
                            ex.pending.merchant ||
                            ex.pending.description ||
                            "Expense",
                          facts: [
                            formatUsd(Number(ex.pending.amount) || 0),
                            ex.pending.category,
                            ex.pending.report,
                            formatShortDate(ex.pending.date),
                          ],
                          // What the user actually paid, and the rate the
                          // app used: the figure above is the converted one.
                          note:
                            ex.pending.currency !== "USD"
                              ? `${ex.pending.currency} ${ex.pending.originalAmount}${
                                  ex.pending.fxRate
                                    ? ` converted at ${formatFxRate(ex.pending.fxRate)} USD/${ex.pending.currency}`
                                    : ""
                                }${
                                  ex.pending.rateDate
                                    ? ` (rate for ${ex.pending.rateDate})`
                                    : ""
                                }`
                              : null,
                          intent: "confirmExpense",
                          payload: {
                            merchant: ex.pending.merchant,
                            // The amount as the user stated it, with its
                            // currency: confirming converts it again.
                            amount: ex.pending.originalAmount,
                            currency: ex.pending.currency,
                            category: ex.pending.category,
                            date: ex.pending.date,
                            report: ex.pending.report,
                            description: ex.pending.description,
                          },
                          label: "Log expense",
                        })}
                    {confirmResult &&
                    !confirmResult.ok &&
                    i === confirmedIndex ? (
                      <p className="mt-2 text-sm text-red-700 dark:text-red-400">
                        {confirmResult.error}
                      </p>
                    ) : null}
                  </Card>
                ) : null}
                {ex.expenseId ? (
                  <p className="mt-1 text-sm">
                    <Link
                      to={`/expense/${ex.expenseId}`}
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {ex.proposalKind === "expense"
                        ? "Review the expense"
                        : "Review the trip"}
                    </Link>
                  </p>
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
        <fetcher.Form
          ref={formRef}
          method="post"
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            askQuestion();
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
          <div className="flex items-end gap-2">
            {/* One line at rest (the 44px touch target the button shares),
                growing with the question to ASK_MAX_LINES before it scrolls;
                text-base keeps mobile Safari from zooming the page on focus. */}
            <Textarea
              ref={askRef}
              id="insights-ask"
              name="text"
              rows={1}
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              onKeyDown={(e) => {
                // A textarea owns Enter, so the send key is handled here
                // instead of by implicit submission: Shift+Enter is the
                // newline (and an IME's Enter commits its candidate, it does
                // not send).
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  askQuestion();
                }
              }}
              autoComplete="off"
              autoCapitalize="off"
              enterKeyHint="send"
              placeholder='e.g. "did I spend more on AI this month than last?"'
              className="min-h-11 min-w-0 flex-1 resize-none text-base"
            />
            {/* One button whose `type` never changes: React DOM's form-action
                support rebuilds FormData from the submit event's submitter
                after this form's onSubmit prevents the default, so flipping
                the submitter's type to `button` in the same dispatch throws.
                Only the label swaps: Stop cancels the pending submission
                instead. */}
            <Button
              type="submit"
              onClick={(e) => {
                if (stopping) {
                  e.preventDefault();
                  stopAnswer();
                }
              }}
              className="h-11 min-w-24 shrink-0"
            >
              {stopping ? (
                <>
                  <Square aria-hidden="true" className="h-4 w-4" />
                  Stop
                </>
              ) : (
                <>
                  <Sparkles aria-hidden="true" className="h-4 w-4" />
                  Ask
                </>
              )}
            </Button>
          </div>
          {composerError ? <Alert icon>{composerError}</Alert> : null}
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="text-gray-500 dark:text-gray-400">Try:</span>
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => {
                  setAsk(ex);
                  askRef.current?.focus();
                }}
                className="rounded-full border border-gray-300 px-2.5 py-0.5 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                {ex}
              </button>
            ))}
          </div>
        </fetcher.Form>
      </Card>
    </PageShell>
  );
}
