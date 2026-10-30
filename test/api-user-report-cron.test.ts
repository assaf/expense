import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * /api/user-report-cron: the weekly all-users report. CRON_SECRET-gated; one
 * table row per user carrying the account's expense total and last expense.
 */

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(
    async (_input: { to: string; subject: string; html: string }) => true,
  ),
}));

vi.mock("~/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/env")>()),
  FASTMAIL_TOKEN: "test-fastmail-token",
  CRON_SECRET: "cron-secret",
}));

vi.mock("~/lib/reply.server", () => ({ sendEmail: mocks.sendEmail }));

import { loader } from "~/routes/api.user-report-cron";
import {
  OTHER_ACCOUNT_ID,
  TEST_ACCOUNT_ID,
  TEST_EMAIL,
  testPrisma,
} from "./helpers/seedTestData";

const OTHER_EMAIL = "otheruser@example.com";
const SEEDED_AT = "2026-06-15T00:00:00.000Z";

/** A rendered date cell: "Jun 15, 2026". */
const DATE = /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/;

function args(request: Request): Parameters<typeof loader>[0] {
  return {
    request,
    url: new URL(request.url),
    params: {},
    pattern: "api/user-report-cron",
    context: {} as never,
  };
}

function request(): Request {
  return new Request("https://expense.test/api/user-report-cron", {
    headers: { authorization: "Bearer cron-secret" },
  });
}

/** The table cells of the one row mentioning `marker`, in column order:
 * account, email, joined, expenses, last expense. */
function cells(html: string, marker: string): string[] {
  const row = html.split("<tr>").find((chunk) => chunk.includes(marker));
  if (!row) throw new Error(`no report row for ${marker}`);
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
    (m[1] ?? "").trim(),
  );
}

/** The account's expense total, straight from the rows the report counts. */
async function expenseCount(accountId: string): Promise<number> {
  const rows = await testPrisma.expense.findMany({
    where: { accountId },
    select: { createdAt: true },
  });
  return rows.length;
}

describe("api.user-report-cron", () => {
  beforeEach(() => {
    mocks.sendEmail.mockClear();
    mocks.sendEmail.mockResolvedValue(true);
  });

  it("rejects requests without the cron secret", async () => {
    const res = await loader(
      args(new Request("https://expense.test/api/user-report-cron")),
    );
    expect(res.status).toBe(401);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("reports every user with their account's expense totals", async () => {
    const [mine, other] = await Promise.all([
      expenseCount(TEST_ACCOUNT_ID),
      expenseCount(OTHER_ACCOUNT_ID),
    ]);
    // The two accounts must differ, or a report that leaked one total into
    // both rows would still pass.
    expect(mine).not.toBe(other);

    const res = await loader(args(request()));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      sent: true,
      count: 2,
    });

    const sent = mocks.sendEmail.mock.calls[0]![0];
    expect(sent.to).toBe("assaf@labnotes.org");
    expect(sent.subject).toContain("2 accounts");

    const row = cells(sent.html, TEST_EMAIL);
    expect(row[0]).toBe("Test Account");
    expect(row[1]).toBe(TEST_EMAIL);
    expect(row[2]).toMatch(DATE);
    expect(row[3]).toBe(String(mine));
    expect(row[4]).toMatch(DATE);

    const otherRow = cells(sent.html, OTHER_EMAIL);
    expect(otherRow[0]).toBe("Other Account");
    expect(otherRow[3]).toBe(String(other));
  });

  it("shows a new account with no expenses as zero and an em dash", async () => {
    await testPrisma.account.create({
      data: {
        id: "acct_empty",
        name: "Empty Account",
        inviteCode: "EMPTY01",
        createdAt: SEEDED_AT,
      },
    });
    await testPrisma.user.create({
      data: {
        id: "user_empty",
        accountId: "acct_empty",
        email: "empty@example.com",
        passwordHash: "x",
        emailVerifiedAt: SEEDED_AT,
        createdAt: SEEDED_AT,
      },
    });

    const res = await loader(args(request()));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      sent: true,
      count: 3,
    });

    const row = cells(
      mocks.sendEmail.mock.calls[0]![0].html,
      "empty@example.com",
    );
    expect(row[0]).toBe("Empty Account");
    expect(row[3]).toBe("0");
    expect(row[4]).toBe("—");
  });
});
