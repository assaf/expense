import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * gmailMailAdapter against scripted Gmail API responses: the drain
 * contract (afterIso exclusivity, oldest-first, limit), the review scan
 * contract (descending, newest-first), raw email decode, the TRASH label
 * body, the preview path, and the owner-notification import (never send).
 * fetch is stubbed and routed by URL path.
 */

const mocks = vi.hoisted(() => ({
  saveEmailConnectionWatch: vi.fn(async () => {}),
}));

vi.mock("~/lib/db/email-connections", () => ({
  saveEmailConnectionWatch: mocks.saveEmailConnectionWatch,
}));

import {
  ensureGmailWatch,
  gmailInboxSummaries,
  gmailMailAdapter,
  gmailMoveToTrash,
  gmailSendConnectionEmailToOwner,
} from "~/lib/gmail.server";

// Newest-first, per messages.list. internalDate is epoch-ms text.
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 7, 10, 12, 0, 0); // Aug 10 2026, 12:00 UTC
const MESSAGES: Array<{
  id: string;
  at: number;
  subject: string;
  from: string;
  snippet?: string;
}> = [
  { id: "m3", at: T0 + 2 * DAY, subject: "Third", from: "c@x.com" },
  {
    id: "m2",
    at: T0 + 3600_000,
    subject: "Second",
    from: "b@x.com",
    snippet: "partial body",
  },
  { id: "m1b", at: T0 - 3600_000, subject: "Boundary-early", from: "b2@x.com" },
  { id: "m1", at: T0 - 2 * DAY, subject: "First", from: "a@x.com" },
];

function meta(id: string) {
  const m = MESSAGES.find((x) => x.id === id)!;
  return {
    id,
    internalDate: String(m.at),
    snippet: m.snippet ?? "",
    payload: {
      headers: [
        { name: "Subject", value: m.subject },
        { name: "From", value: m.from },
        { name: "To", value: "me@gmail.com" },
        { name: "Message-ID", value: `<${id}@x.com>` },
      ],
    },
  };
}

let calls: Array<{ path: string; init?: RequestInit }> = [];

function respond(path: string): string {
  if (path.startsWith("/gmail/v1/users/me/messages?")) {
    return JSON.stringify({
      messages: MESSAGES.map((m) => ({ id: m.id })),
    });
  }
  const metaMatch = path.match(/messages\/(\w+)\?format=metadata/);
  if (metaMatch) return JSON.stringify(meta(metaMatch[1]!));
  const rawMatch = path.match(/messages\/(\w+)\?format=raw/);
  if (rawMatch) {
    const m = MESSAGES.find((x) => x.id === rawMatch[1]!)!;
    const source = `From: ${m.from}\r\nTo: me@gmail.com\r\nSubject: ${m.subject}\r\nMessage-ID: <${m.id}@x.com>\r\n\r\nbody of ${m.id}`;
    return JSON.stringify({
      id: m.id,
      raw: Buffer.from(source).toString("base64url"),
    });
  }
  if (path.includes("/messages/import"))
    return JSON.stringify({ id: "imported" });
  if (path.endsWith("/watch"))
    return JSON.stringify({ historyId: "9", expiration: String(T0 + 6 * DAY) });
  if (path.endsWith("/modify")) return JSON.stringify({ id: "m1" });
  throw new Error(`unscripted path: ${path}`);
}

function bodyOf(call: { init?: RequestInit }): string {
  const body = call.init?.body;
  return typeof body === "string" ? body : "";
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = `${url.pathname}${url.search}`;
      calls.push({ path, init });
      return new Response(respond(path), { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gmailInboxSummaries", () => {
  it("enforces afterIso exclusivity, oldest-first order, and limit", async () => {
    const afterIso = new Date(T0).toISOString(); // Aug 10, 12:00 UTC
    const summaries = await gmailInboxSummaries({
      token: "t",
      afterIso,
      limit: 2,
    });
    // m1b shares the boundary day but predates afterIso: excluded.
    expect(summaries.map((s) => s.id)).toEqual(["m2", "m3"]);
    expect(Date.parse(summaries[0]!.receivedAt)).toBeLessThan(
      Date.parse(summaries[1]!.receivedAt),
    );
    // The Gmail query over-selects the boundary day (day-granular after:).
    const list = calls.find((c) => c.path.includes("/messages?"));
    expect(list!.path).toContain("q=in%3Ainbox+after%3A2026%2F08%2F10");
  });

  it("returns the newest-first batch for the review scan", async () => {
    const summaries = await gmailInboxSummaries({
      token: "t",
      afterIso: new Date(T0 - 3 * DAY).toISOString(),
      limit: 10,
      descending: true,
    });
    expect(summaries.map((s) => s.id)).toEqual(["m3", "m2", "m1b", "m1"]);
  });

  it("carries the snippet as preview only when asked", async () => {
    const opts = {
      token: "t",
      afterIso: new Date(T0 - 3 * DAY).toISOString(),
      limit: 10,
      descending: true,
    };
    const withPreview = (
      await gmailInboxSummaries({ ...opts, includePreview: true })
    ).find((s) => s.id === "m2")!;
    expect(withPreview.preview).toBe("partial body");
    const without = (await gmailInboxSummaries(opts)).find(
      (s) => s.id === "m2",
    )!;
    expect(without.preview).toBeUndefined();
  });
});

describe("gmailMoveToTrash", () => {
  it("adds TRASH and removes INBOX/UNREAD", async () => {
    await gmailMoveToTrash("t", "m1");
    const call = calls.find((c) => c.path.endsWith("/modify"))!;
    expect(call.path).toContain("/gmail/v1/users/me/messages/m1/modify");
    expect(JSON.parse(bodyOf(call))).toEqual({
      addLabelIds: ["TRASH"],
      removeLabelIds: ["INBOX", "UNREAD"],
    });
  });
});

describe("gmailSendConnectionEmailToOwner", () => {
  it("imports the RFC 822 bytes into the inbox, never sends", async () => {
    await gmailSendConnectionEmailToOwner(
      { id: "conn-1", emailAddress: "me@gmail.com" },
      "t",
      { subject: "Expense saved", html: "<p>Saved</p>", text: "Saved" },
    );
    const importCalls = calls.filter((c) =>
      c.path.includes("/messages/import"),
    );
    // One call, and it is messages.import with neverMarkSpam: there is no
    // gmail.send scope, so no /send endpoint may appear.
    expect(importCalls).toHaveLength(1);
    expect(importCalls[0]!.path).toContain("neverMarkSpam=true");
    expect(importCalls[0]!.path).toContain("internalDateSource=dateHeader");
    expect(calls.some((c) => c.path.includes("/send"))).toBe(false);
    const body = bodyOf(importCalls[0]!);
    expect(body).toContain("Content-Type: message/rfc822");
    // The base64 part decodes to a message addressed from/to the owner.
    const parts = body.split("\r\n\r\n");
    const encoded = parts[2]!.split("\r\n--")[0]!;
    const raw = Buffer.from(encoded, "base64").toString("utf8");
    expect(raw).toContain("To: me@gmail.com");
    expect(raw).toContain("Subject: Expense saved");
  });
});

describe("ensureGmailWatch", () => {
  it("starts the INBOX watch and persists the expiration", async () => {
    await ensureGmailWatch({ id: "conn-1" }, "t");
    const call = calls.find((c) => c.path.endsWith("/watch"))!;
    expect(JSON.parse(bodyOf(call))).toEqual({
      topicName: "projects/test/topics/expense-test",
      labelIds: ["INBOX"],
      labelFilterBehavior: "INCLUDE",
    });
    expect(mocks.saveEmailConnectionWatch).toHaveBeenCalledWith(
      "conn-1",
      new Date(T0 + 6 * DAY).toISOString(),
    );
  });
});

describe("gmailMailAdapter", () => {
  it("wires the adapter methods over one token", async () => {
    const adapter = gmailMailAdapter("t");
    const summaries = await adapter.inboxEmailSummaries({
      afterIso: new Date(T0).toISOString(),
      limit: 5,
    });
    expect(summaries[0]!.id).toBe("m2");
    await adapter.moveToTrash("m1");
    expect(calls.some((c) => c.path.endsWith("/modify"))).toBe(true);
    const raw = await adapter.rawEmail("m3");
    expect(raw.id).toBe("m3");
  });
});
