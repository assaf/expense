import { ulid } from "ulid";
import { and } from "@prisma/orm-postgres/orm-client";
import { db } from "~/lib/prisma.server";
import { asJson, fromIso, toIso } from "~/lib/db/wire";

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

/** How many conversations a user keeps. Older ones exist only as a record,
 * and the delete marker walks the newest 20 looking for a filed expense, so
 * this leaves plenty of headroom while stopping the table from growing for
 * every "New chat" click. */
const MAX_CONVERSATIONS = 50;

/** Drop the user's conversations past MAX_CONVERSATIONS, oldest first. */
async function pruneConversations(userId: string): Promise<void> {
  const rows = await db.orm.public.InsightConversation.where((c) =>
    c.userId.eq(userId),
  )
    .orderBy((c) => c.updatedAt.desc())
    .select("id")
    .all();
  const stale = rows.slice(MAX_CONVERSATIONS).map((r) => r.id);
  if (stale.length === 0) return;
  await db.orm.public.InsightConversation.where((c) =>
    c.id.in(stale),
  ).deleteAll();
}

/** Claim a conversation row for a rewrite: the write only lands when the
 * stored `messages` are still the array the caller read (`updatedAt` alone
 * is not enough — the delete marker deliberately leaves it untouched, and
 * timestamp(3) cannot tell two writes in one millisecond apart). Returns
 * false when another writer got there first; the callers retry with a fresh
 * read. */
async function swapMessages(
  id: string,
  expected: unknown,
  next: StoredExchange[],
  update: { updatedAt?: string },
): Promise<boolean> {
  const rows = await db.orm.public.InsightConversation.where((c) =>
    and(c.id.eq(id), c.messages.eq(asJson(expected))),
  ).updateAll({
    messages: asJson(next),
    ...(update.updatedAt ? { updatedAt: fromIso(update.updatedAt) } : {}),
  });
  return rows.length > 0;
}

/** The timestamp for a write that must be strictly newer than the row just
 * read: `now`, or one millisecond past it when the clock has not moved (the
 * chat opens the newest conversation by this value, so a tie is ambiguous). */
function nextWriteTime(readWire: string): string {
  const readMs = Date.parse(toIso(readWire));
  const nowMs = Date.now();
  return new Date(readMs >= nowMs ? readMs + 1 : nowMs).toISOString();
}

/** Append one exchange to the user's most recent conversation, creating
 * the conversation on first use.
 *
 * The row is read fresh and the write claims it against the array that was
 * read: the cached copy above can be minutes old, and replacing the array
 * from it would drop an exchange another request appended (or a deletion
 * note another request wrote) in the meantime. A lost claim re-reads and
 * tries again. */
export async function appendExchange(
  userId: string,
  accountId: string,
  exchange: StoredExchange,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await db.orm.public.InsightConversation.where((c) =>
      c.userId.eq(userId),
    )
      .orderBy((c) => c.updatedAt.desc())
      .first();
    if (!row) {
      await db.orm.public.InsightConversation.create({
        id: ulid(),
        userId,
        accountId,
        messages: asJson([exchange]),
        createdAt: fromIso(new Date().toISOString()),
        updatedAt: fromIso(new Date().toISOString()),
      });
      await pruneConversations(userId);
      await bustConversationCache(userId);
      return;
    }
    const exchanges = [...parseExchanges(row.messages), exchange].slice(-200);
    if (
      await swapMessages(row.id, row.messages, exchanges, {
        updatedAt: nextWriteTime(row.updatedAt),
      })
    ) {
      await bustConversationCache(userId);
      return;
    }
  }
  // Three lost races in a row means something is appending in a tight loop;
  // losing the record of one answer is better than failing the request that
  // already did its work (the expense or trip is filed by now).
  console.warn("[insights] dropped an exchange after repeated write conflicts");
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
  for (let attempt = 0; attempt < 3; attempt++) {
    const rows = await db.orm.public.InsightConversation.where((c) =>
      c.userId.eq(userId),
    )
      .orderBy((c) => c.updatedAt.desc())
      .limit(20)
      .all();
    let lost = false;
    for (const row of rows) {
      const exchanges = parseExchanges(row.messages);
      const index = exchanges.findIndex((e) => e.expenseId === expenseId);
      if (index < 0) continue;
      const target = exchanges[index]!;
      // Both fields describe the link that is going away; the "Log it"
      // question and the answer's own words stay as written.
      const { expenseId: _filed, proposalKind: _kind, ...rest } = target;
      exchanges[index] = { ...rest, answer: withDeletedNote(target.answer) };
      // No updatedAt: it decides which conversation the chat opens, and
      // deleting an expense must not jump the user to an older one. The
      // claim is on the array that was read instead.
      const won = await swapMessages(row.id, row.messages, exchanges, {});
      if (!won) {
        lost = true;
        break;
      }
      await bustConversationCache(userId);
      return;
    }
    if (!lost) return;
  }
  console.warn("[insights] could not note a deleted expense after retries");
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
  await pruneConversations(userId);
  await bustConversationCache(userId);
  return id;
}
