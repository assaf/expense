import { ulid } from "ulid";
import { db } from "~/lib/prisma.server";
import { asJson, fromIso } from "~/lib/db/wire";

export interface StoredExchange {
  question: string;
  answer: string;
  chart: boolean;
  query: string;
  months: number;
  title: string;
  /** The expense a "Log it" exchange filed, so the transcript can link to it
   * for review and correction. Absent on every other exchange. */
  expenseId?: string;
  /** What that link points at: a mileage trip or a typed purchase. The
   * proposal card knows its own kind, but that card is a one-shot
   * affordance, so the exchange has to carry it for the reloaded transcript
   * to label the link. Absent on every other exchange. */
  proposalKind?: "mileage" | "expense";
}

/** The in-process cache mirrors the 5-minute pattern used for accounts
 * and reports: the conversation only changes through this module. */
import { cachedRead, createCache, bust } from "~/lib/db/shared";

const conversationCache = createCache<{
  id: string;
  exchanges: StoredExchange[];
}>(300_000);

/** Defensive parse of the jsonb messages column: only well-shaped
 * exchanges survive, strings are length-capped. */
function parseExchanges(raw: unknown): StoredExchange[] {
  const list = typeof raw === "string" ? safeParse(raw) : raw;
  if (!Array.isArray(list)) return [];
  const out: StoredExchange[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    if (
      !("question" in entry) ||
      !("answer" in entry) ||
      !("chart" in entry) ||
      !("query" in entry) ||
      !("months" in entry) ||
      !("title" in entry)
    ) {
      continue;
    }
    const { question, answer, chart, query, months, title, expenseId } = entry;
    const proposalKind = entry.proposalKind;
    if (
      typeof question !== "string" ||
      typeof answer !== "string" ||
      typeof chart !== "boolean" ||
      typeof query !== "string" ||
      typeof months !== "number" ||
      typeof title !== "string"
    ) {
      continue;
    }
    out.push({
      question: question.slice(0, 300),
      answer: answer.slice(0, 2000),
      chart,
      query: query.slice(0, 300),
      // The translator's windows are the offered options, but the app also
      // stores the span a question's period resolved to (1..60 months), so
      // the read side accepts any positive span instead of flattening it
      // back to 12.
      months:
        Number.isInteger(months) &&
        (months === -1 || months === 0 || (months >= 1 && months <= 60))
          ? months
          : 12,
      title: title.slice(0, 60),
      // Only the app writes this (a filed expense's id), so a non-string is
      // dropped rather than repaired.
      ...(typeof expenseId === "string" && expenseId
        ? { expenseId: expenseId.slice(0, 40) }
        : {}),
      ...(proposalKind === "mileage" || proposalKind === "expense"
        ? { proposalKind }
        : {}),
    });
  }
  return out;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The user's most recent conversation, or null when they have none.
 * Cached for 5 minutes like accounts/reports. */
export async function readLatestConversation(
  userId: string,
): Promise<{ id: string; exchanges: StoredExchange[] } | null> {
  return cachedRead(conversationCache, userId, async () => {
    const row = await db.orm.public.InsightConversation.where((c) =>
      c.userId.eq(userId),
    )
      .orderBy((c) => c.updatedAt.desc())
      .first();
    if (!row) return null;
    return {
      id: row.id,
      exchanges: parseExchanges(row.messages),
    };
  });
}

async function bustConversationCache(userId: string): Promise<void> {
  bust(conversationCache, userId);
}

/** Append one exchange to the user's most recent conversation, creating
 * the conversation on first use. All prior conversations stay in the
 * table as a record. */
export async function appendExchange(
  userId: string,
  accountId: string,
  exchange: StoredExchange,
): Promise<void> {
  const existing = await readLatestConversation(userId);
  if (existing) {
    const exchanges = [...existing.exchanges, exchange].slice(-200);
    await db.orm.public.InsightConversation.where((c) =>
      c.id.eq(existing.id),
    ).updateAll({
      messages: asJson(exchanges),
      updatedAt: fromIso(new Date().toISOString()),
    });
  } else {
    await db.orm.public.InsightConversation.create({
      id: ulid(),
      userId,
      accountId,
      messages: asJson([exchange]),
      createdAt: fromIso(new Date().toISOString()),
      updatedAt: fromIso(new Date().toISOString()),
    });
  }
  await bustConversationCache(userId);
}

/** The transcript's own line for an exchange whose expense is gone: the
 * answer becomes "Logged ... (deleted afterwards)." An answer that does not
 * end in a sentence gets the note appended as it is. */
function withDeletedNote(answer: string): string {
  return answer.endsWith(".")
    ? `${answer.slice(0, -1)} (deleted afterwards).`
    : `${answer} (deleted afterwards)`;
}

/** Note that the expense a "Log it" exchange filed has been deleted: drop the
 * link and say so in the answer.
 *
 * The transcript is the only thing the answer model reads back about earlier
 * turns. A plain "Logged $50.00 at Costa Coffee on 2026-09-11." stays in the
 * history long after the user deletes the row, which is how the model ends up
 * telling the user something is already logged when nothing is. Rewriting the
 * answer makes the history a record of what happened rather than a claim about
 * the records now.
 *
 * updatedAt is deliberately untouched: it decides which conversation the chat
 * opens, and deleting an expense must not jump the user back to an older one. */
export async function markFiledExpenseDeleted(
  userId: string,
  expenseId: string,
): Promise<void> {
  // The exchange that filed it lives in the conversation that was current
  // then: the newest handful covers it (the user would have to start a new
  // chat between filing and deleting to push it further back).
  const rows = await db.orm.public.InsightConversation.where((c) =>
    c.userId.eq(userId),
  )
    .orderBy((c) => c.updatedAt.desc())
    .limit(20)
    .all();
  for (const row of rows) {
    const exchanges = parseExchanges(row.messages);
    const index = exchanges.findIndex((e) => e.expenseId === expenseId);
    if (index < 0) continue;
    const target = exchanges[index]!;
    // Both fields describe the link that is going away; the "Log it"
    // question and the answer's own words stay as written.
    const { expenseId: _filed, proposalKind: _kind, ...rest } = target;
    exchanges[index] = { ...rest, answer: withDeletedNote(target.answer) };
    await db.orm.public.InsightConversation.where((c) =>
      c.id.eq(row.id),
    ).updateAll({ messages: asJson(exchanges) });
    await bustConversationCache(userId);
    return;
  }
}

/** Start a fresh conversation for the user; the previous one remains in
 * the table as part of the history record. Returns the new id. */
export async function startNewConversation(
  userId: string,
  accountId: string,
): Promise<string> {
  const id = ulid();
  const now = fromIso(new Date().toISOString());
  await db.orm.public.InsightConversation.create({
    id,
    userId,
    accountId,
    messages: asJson([]),
    createdAt: now,
    updatedAt: now,
  });
  await bustConversationCache(userId);
  return id;
}
