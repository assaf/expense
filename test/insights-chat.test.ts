import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import {
  appendExchange,
  readLatestConversation,
  startNewConversation,
  type StoredExchange,
} from "~/lib/db/insights-chat";
import { db } from "~/lib/prisma.server";
import { asJson, nowWire } from "~/lib/db/wire";
import { TEST_ACCOUNT_ID } from "./helpers/seedTestData";

/**
 * The stored transcript: appends and the "New chat" cap. These use a
 * throwaway user id per test (the table has no foreign key, and the
 * insights-route suite asserts on the seeded user's own transcripts), and
 * clean up after themselves because a reseed does not clear the table.
 */
function freshUser(): string {
  return `chat-test-${ulid()}`;
}

function exchange(question: string): StoredExchange {
  return {
    question,
    answer: `${question} answered.`,
    chart: false,
    query: "",
    months: 12,
    title: question,
  };
}

describe("insights transcript", () => {
  const users: string[] = [];
  const newUser = (): string => {
    const id = freshUser();
    users.push(id);
    return id;
  };

  afterEach(async () => {
    if (users.length > 0) {
      await db.orm.public.InsightConversation.where((c) =>
        c.userId.in(users),
      ).deleteAll();
      users.length = 0;
    }
  });

  it("keeps both exchanges when two appends race", async () => {
    const userId = newUser();
    await startNewConversation(userId, TEST_ACCOUNT_ID);
    // Both appends read the row before either writes: the write has to be a
    // compare-and-swap, or the loser's exchange disappears from the record
    // (and with it the link to the expense it filed).
    await Promise.all([
      appendExchange(userId, TEST_ACCOUNT_ID, exchange("first")),
      appendExchange(userId, TEST_ACCOUNT_ID, exchange("second")),
    ]);
    const conversation = await readLatestConversation(userId);
    expect(conversation?.exchanges.map((e) => e.question).sort()).toEqual([
      "first",
      "second",
    ]);
  });

  it("builds on the row, not on this process's cached copy", async () => {
    const userId = newUser();
    await startNewConversation(userId, TEST_ACCOUNT_ID);
    await appendExchange(userId, TEST_ACCOUNT_ID, exchange("first"));
    // Warm the in-process cache (5-minute TTL), then let "another instance"
    // append straight to the row. A write assembled from the cached array
    // would drop that entry.
    await readLatestConversation(userId);
    const row = await db.orm.public.InsightConversation.where((c) =>
      c.userId.eq(userId),
    ).first();
    // jsonb reads back as a parsed array (or its text, depending on the
    // codec): normalize without trusting either.
    const rawMessages = row?.messages;
    const current = Array.isArray(rawMessages)
      ? rawMessages
      : typeof rawMessages === "string"
        ? JSON.parse(rawMessages)
        : [];
    await db.orm.public.InsightConversation.where({ id: row!.id }).updateAll({
      messages: asJson([
        ...(Array.isArray(current) ? current : []),
        exchange("other-instance"),
      ]),
      updatedAt: nowWire(),
    });

    await appendExchange(userId, TEST_ACCOUNT_ID, exchange("third"));
    const conversation = await readLatestConversation(userId);
    expect(conversation?.exchanges.map((e) => e.question).sort()).toEqual([
      "first",
      "other-instance",
      "third",
    ]);
  });

  it("carries an entry this build cannot read through a rewrite", async () => {
    const userId = newUser();
    await startNewConversation(userId, TEST_ACCOUNT_ID);
    // A row written by an older schema (`months` as text): the reader shows
    // nothing for it, but an append must not delete it.
    const legacy = {
      question: "old",
      answer: "old",
      chart: false,
      query: "",
      months: "6",
      title: "Old",
    };
    const row = await db.orm.public.InsightConversation.where((c) =>
      c.userId.eq(userId),
    ).first();
    await db.orm.public.InsightConversation.where({ id: row!.id }).updateAll({
      messages: asJson([legacy]),
      updatedAt: nowWire(),
    });

    await appendExchange(userId, TEST_ACCOUNT_ID, exchange("new"));

    const stored = await db.orm.public.InsightConversation.where((c) =>
      c.userId.eq(userId),
    ).first();
    const raw = stored?.messages;
    const entries = Array.isArray(raw) ? raw : [];
    expect(entries).toHaveLength(2);
    expect(entries).toEqual([legacy, exchange("new")]);
  });

  it("picks the newest conversation by id when the timestamps tie", async () => {
    const userId = newUser();
    // Two rows written in the same millisecond: with `updatedAt` as the
    // ordering key the reader could return either one (which is how the chat
    // opened the wrong conversation, and how a test on "the newest one"
    // flaked). Ids are unique, so the pick is stable.
    const older = "01AAAAAAAAAAAAAAAAAAAAAAAA";
    const newer = "01BBBBBBBBBBBBBBBBBBBBBBBB";
    for (const id of [older, newer]) {
      await db.orm.public.InsightConversation.create({
        id,
        userId,
        accountId: TEST_ACCOUNT_ID,
        messages: asJson([]),
        createdAt: nowWire(),
        updatedAt: nowWire(),
      });
    }

    await appendExchange(userId, TEST_ACCOUNT_ID, exchange("newest"));
    const conversation = await readLatestConversation(userId);
    expect(conversation?.id).toBe(newer);
    expect(conversation?.exchanges.map((e) => e.question)).toEqual(["newest"]);
  });

  it("keeps only the newest conversations", async () => {
    const userId = newUser();
    for (let i = 0; i < 55; i++) {
      await startNewConversation(userId, TEST_ACCOUNT_ID);
    }
    const kept = await db.orm.public.InsightConversation.where((c) =>
      c.userId.eq(userId),
    )
      .select("id")
      .all();
    expect(kept.length).toBe(50);
  });
});
