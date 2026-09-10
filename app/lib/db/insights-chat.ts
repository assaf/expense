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
    const { question, answer, chart, query, months, title } = entry;
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
      months: [-1, 0, 6, 12, 24].includes(months) ? months : 12,
      title: title.slice(0, 60),
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
