import type { Route } from "./+types/insights.stream";
import { authLockedUntil, recordAuthFailure } from "~/lib/db/auth-attempts";
import {
  appendExchange,
  readLatestConversation,
  updateLastExchange,
} from "~/lib/db/insights-chat";
import { captureError } from "~/lib/errors.server";
import {
  answerInsightQuestion,
  loadInsightContext,
  translateInsightQuery,
  LLMError,
  type PendingProposal,
} from "~/lib/insights-ai.server";
import {
  insightSummary,
  matchingExpenses,
  monthlyTotals,
} from "~/lib/insights";
import { DEFAULT_CHART_SHAPE } from "~/lib/insight-charts";
import { checkupText, moneyCheckup } from "~/lib/money-checkup";
import { periodScope, withPeriodRange } from "~/lib/insight-periods";
import { requireIntent } from "~/lib/route-helpers.server";
import { formString, unknownIntent } from "~/lib/validation";

/**
 * The Insights question as a server-sent event stream. The answer streams
 * first through the tool loop, grounded in the account-wide totals and the
 * model's own query_expenses calls. The chart's translator runs alongside
 * the answer (its event still waits for done), so the chart lands when the
 * answer does instead of a model call later. Every failure before the
 * answer surfaces as an `error` event so the composer can show it without
 * the client having to parse a non-SSE response.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const { user, form, intent } = await requireIntent(request, context);
  if (intent !== "stream") return unknownIntent();

  const text = formString(form, "text").trim().slice(0, 500);
  const today = formString(form, "today");
  const localTime = formString(form, "localTime");
  const tz = formString(form, "tz");

  const encoder = new TextEncoder();
  // Once the answer event is out, a later failure (the chart's model call)
  // must not surface as a composer error: the exchange is complete, and the
  // chart is best-effort decoration on top of it.
  let answerSent = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // One start line when the question comes in, one finish line with the
      // outcome and wall time when the stream closes, whichever path closes
      // it. The finish is logged exactly once.
      const startedAt = performance.now();
      let closed = false;
      const finish = (outcome: string) => {
        if (closed) return;
        closed = true;
        console.info(
          `[insights] stream finished (${outcome}) after ${(
            (performance.now() - startedAt) /
            1000
          ).toFixed(1)}s`,
        );
        controller.close();
      };
      console.info("[insights] stream start:", text.slice(0, 80));
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };
      try {
        // The question budget: the same per-user counter the page action
        // uses — every stream drives the same two LLM calls.
        const throttleKey = `insights:${user.id}`;
        if (await authLockedUntil(throttleKey)) {
          send({
            type: "error",
            error: "Too many questions in a row. Try again in a few minutes.",
          });
          finish("rejected: throttled");
          return;
        }
        await recordAuthFailure(throttleKey, {
          windowMs: 15 * 60_000,
          threshold: 12,
          lockMs: 15 * 60_000,
        });

        const context = await loadInsightContext(user, tz);
        const conversation = await readLatestConversation(user.id);

        // The answer streams first, with no model call in front of it: the
        // rule-based period scope sizes the window, the all-spending totals
        // ground the first draft, and the model pulls topic numbers itself
        // through query_expenses. The translator runs only after the answer
        // is in hand, to name the chart.
        const scope = periodScope(text, today);
        const months = scope?.months ?? 12;

        // The translator runs alongside the answer rather than after it:
        // it costs a full GLM-5.3 call (reasoning plus the provider queue)
        // regardless of how few expenses the chart draws, so starting it
        // now is what makes the chart land right after the answer instead
        // of a model call later. The chart event still waits for done.
        const chartPromise: Promise<
          | Awaited<ReturnType<typeof translateInsightQuery>>
          | { failure: unknown }
        > = translateInsightQuery({
          text,
          history: conversation?.exchanges.slice(-3) ?? [],
          today,
          merchants: context.merchants,
          categories: context.categoryNames,
          reports: context.reportNames,
          signal: request.signal,
        }).catch((err: unknown) => ({ failure: err }));

        let answer = "";
        let pending: PendingProposal | undefined;
        if (/^\d{4}-\d{2}-\d{2}$/.test(today)) {
          const buckets = monthlyTotals(context.expenses, "", today, months);
          const matched = matchingExpenses(context.expenses, "", buckets);
          const checkup = moneyCheckup({
            expenses: context.expenses,
            today,
            dismissed: context.dismissed,
          });
          const result = await answerInsightQuestion({
            question: text,
            history: conversation?.exchanges.slice(-3) ?? [],
            summary: [
              insightSummary(buckets, matched),
              checkupText(checkup),
            ].join("\n"),
            expenses: context.expenses,
            writes: {
              accountId: user.accountId,
              reportNames: context.reportNames,
              today,
            },
            profile: [
              context.profile,
              `Current date: ${today} (user's local date)`,
              ...(localTimeOk(localTime)
                ? [`Current time: ${localTime} (user's local clock)`]
                : []),
            ].join("\n"),
            signal: request.signal,
            onEvent: (event) => {
              if (event.type === "tools") send({ type: "tools" });
              if (event.type === "delta")
                send({ type: "delta", text: event.text });
            },
          });
          answer = result.answer;
          pending = result.pending;
        }

        // The browser went away: the answer has no reader, and a transcript
        // row nobody saw is a lie about the conversation.
        if (request.signal.aborted) {
          finish("aborted mid-answer");
          return;
        }
        await appendExchange(user.id, user.accountId, {
          question: text,
          answer,
          chart: false,
          shape: DEFAULT_CHART_SHAPE,
          query: "",
          months,
          title: "",
        });
        send({
          type: "done",
          answer,
          ...(pending ? { pending } : {}),
        });
        answerSent = true;

        const translated = await chartPromise;
        if ("failure" in translated) {
          console.warn(
            "[insights] chart skipped after the answer:",
            translated.failure instanceof Error
              ? translated.failure.message
              : String(translated.failure),
          );
          finish("completed; chart skipped");
          return;
        }
        // The app owns the period: the model's guess is replaced whenever
        // the question names one (see insight-periods).
        const t = {
          ...translated,
          query: withPeriodRange(translated.query, text, today),
          ...(scope ? { chart: scope.chart, months: scope.months } : {}),
        };
        send({
          type: "translation",
          query: t.query,
          title: t.title,
          chart: t.chart,
          shape: t.shape,
          months: t.months,
        });
        await updateLastExchange(user.id, text, {
          chart: t.chart,
          shape: t.shape,
          query: t.query,
          months: t.months,
          title: t.title,
        });
        finish("completed");
      } catch (err) {
        if (request.signal.aborted) {
          finish(
            answerSent ? "aborted during the chart" : "aborted mid-answer",
          );
          return;
        }
        if (answerSent) {
          console.warn(
            "[insights] chart skipped after the answer:",
            err instanceof Error ? err.message : String(err),
          );
          finish("completed; chart skipped");
          return;
        }
        if (err instanceof LLMError) {
          console.error(
            `[insights] LLM call failed (status ${err.status}): ${err.message}` +
              (err.body ? ` — ${err.body.slice(0, 300)}` : ""),
          );
          send({
            type: "error",
            error: "The AI service didn't answer. Try again in a moment.",
          });
        } else {
          captureError(err, { url: request.url });
          send({
            type: "error",
            error: "Something went wrong. Try again in a moment.",
          });
        }
        finish("failed");
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // Vercel's proxy buffers responses unless this is set; without it the
      // deltas arrive in one lump and there is nothing to stream.
      "X-Accel-Buffering": "no",
    },
  });
}

function localTimeOk(localTime: string): boolean {
  return /^\d{1,2}:\d{2}( [AP]M)?$/i.test(localTime);
}
