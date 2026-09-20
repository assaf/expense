import { beforeEach, describe, expect, it, vi } from "vitest";
import { reportConnectionFailure } from "~/lib/email-connection-notice.server";
import {
  createEmailConnection,
  setEmailConnectionStatus,
} from "~/lib/db/email-connections";
import { OAuthRefreshError } from "~/lib/oauth-token-refresh.server";
import { encryptSecret } from "~/lib/token-crypto.server";
import { testPrisma } from "./helpers/seedTestData";
import { cleanupConnection, connection } from "./helpers/email-test-fixtures";

/**
 * The reconnect notice: when a provider refuses the stored grant, every
 * verified user of the account is told once, the episode is marked, and a
 * recovery (an active status write or a fresh grant) puts the marker back
 * so a later failure tells them again.
 *
 * Outbound email is mocked (the transport itself is exercised in
 * test/fastmail-send.test.ts): what this feature promises is who gets which
 * email and when, not how it leaves the building.
 */

interface SentMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const SEND = vi.hoisted(() => ({
  sendEmail: vi.fn(async (_input: SentMail) => true),
}));

vi.mock("~/lib/reply.server", () => ({ sendEmail: SEND.sendEmail }));

const NOW = "2026-06-15T00:00:00.000Z";

/** The error the token endpoint produces for a replayed/revoked refresh
 * token (Sentry EXPENSE-13's `invalid_grant ratchet`). */
function deadGrant(): OAuthRefreshError {
  return new OAuthRefreshError(
    'Fastmail token endpoint returned HTTP 400: {"error":"invalid_grant"}',
  );
}

let seq = 0;

interface TestAccount {
  accountId: string;
  /** The addresses the notice must reach. */
  verified: string[];
  /** The address it must never reach: no verification, so it cannot sign in
   * and its owner has no account access to fix. */
  unverified: string;
}

/** A dedicated account with two verified users and one unverified. */
async function makeAccount(): Promise<TestAccount> {
  const n = ++seq;
  const accountId = `acct_conn_${n}`;
  const verified = [`owner${n}@example.com`, `partner${n}@example.com`];
  const unverified = `pending${n}@example.com`;
  await testPrisma.account.create({
    data: {
      id: accountId,
      name: `Connected ${n}`,
      inviteCode: `conncode${n}`,
      createdAt: NOW,
    },
  });
  for (const [i, email] of [...verified, unverified].entries()) {
    await testPrisma.user.create({
      data: {
        id: `user_conn_${n}_${i}`,
        accountId,
        email,
        passwordHash: "unused-in-this-suite",
        emailVerifiedAt: email === unverified ? null : NOW,
        createdAt: NOW,
      },
    });
  }
  return { accountId, verified, unverified };
}

/** The account's mailbox, as the pipeline stores it. */
async function makeConnection(
  accountId: string,
  overrides: { provider?: string; emailAddress?: string } = {},
) {
  const conn = connection({
    accountId,
    provider: overrides.provider ?? "fastmail",
    emailAddress: overrides.emailAddress ?? "mailbox@example.com",
  });
  await testPrisma.emailConnection.create({
    data: {
      id: conn.id,
      accountId: conn.accountId,
      provider: conn.provider,
      emailAddress: conn.emailAddress,
      remoteAccountId: conn.remoteAccountId,
      tokenEnc: conn.tokenEnc,
      createdAt: conn.createdAt,
    },
  });
  return conn;
}

/** The persisted marker, as the test-only client types it. */
async function marker(connectionId: string): Promise<unknown> {
  const row = await testPrisma.emailConnection.findUnique({
    where: { id: connectionId },
    select: { errorNotifiedAt: true },
  });
  return row?.errorNotifiedAt ?? null;
}

function recipients(): string[] {
  return SEND.sendEmail.mock.calls.map(([input]) => input.to).sort();
}

describe("reportConnectionFailure", () => {
  beforeEach(async () => {
    await cleanupConnection();
    SEND.sendEmail.mockClear();
    SEND.sendEmail.mockResolvedValue(true);
  });

  it("tells every verified user, and marks the episode", async () => {
    const account = await makeAccount();
    const conn = await makeConnection(account.accountId);

    await reportConnectionFailure({ connection: conn, error: deadGrant() });

    expect(recipients()).toEqual([...account.verified].sort());
    expect(SEND.sendEmail.mock.calls.map(([input]) => input.to)).not.toContain(
      account.unverified,
    );
    const mail = SEND.sendEmail.mock.calls[0]![0];
    expect(mail.subject).toBe(
      "mailbox@example.com needs reconnecting on Expense",
    );
    // The reader must learn which mailbox died and where to fix it, in both
    // flavors of the message.
    expect(mail.html).toContain("mailbox@example.com");
    expect(mail.html).toContain("/connect-fastmail");
    expect(mail.text).toContain("mailbox@example.com");
    expect(mail.text).toContain("/connect-fastmail");
    expect(await marker(conn.id)).not.toBeNull();
  });

  it("does not tell them again for the same failure episode", async () => {
    const account = await makeAccount();
    const conn = await makeConnection(account.accountId);

    await reportConnectionFailure({ connection: conn, error: deadGrant() });
    SEND.sendEmail.mockClear();
    await reportConnectionFailure({ connection: conn, error: deadGrant() });

    expect(SEND.sendEmail).not.toHaveBeenCalled();
  });

  it("tells them again after the connection recovers and fails once more", async () => {
    const account = await makeAccount();
    const conn = await makeConnection(account.accountId);

    await reportConnectionFailure({ connection: conn, error: deadGrant() });
    // A successful renewal, drain or push verification lands here.
    await setEmailConnectionStatus(conn.id, "active");
    expect(await marker(conn.id)).toBeNull();

    SEND.sendEmail.mockClear();
    await reportConnectionFailure({ connection: conn, error: deadGrant() });
    expect(recipients()).toEqual([...account.verified].sort());
  });

  it("re-arms the notice when the user reconnects the mailbox", async () => {
    const account = await makeAccount();
    const conn = await makeConnection(account.accountId);
    await reportConnectionFailure({ connection: conn, error: deadGrant() });

    // The remedy the notice links to (createEmailConnection saves the fresh
    // grant over the row in place).
    await createEmailConnection({
      accountId: account.accountId,
      provider: "fastmail",
      emailAddress: conn.emailAddress,
      remoteAccountId: "jmap-2",
      tokenEnc: encryptSecret("fresh-token"),
      refreshTokenEnc: encryptSecret("fresh-refresh"),
      tokenExpiresAt: "2026-06-15T01:00:00.000Z",
    });
    expect(await marker(conn.id)).toBeNull();

    SEND.sendEmail.mockClear();
    await reportConnectionFailure({ connection: conn, error: deadGrant() });
    expect(recipients()).toEqual([...account.verified].sort());
  });

  it("stays quiet for a failure the user cannot act on", async () => {
    const account = await makeAccount();
    const conn = await makeConnection(account.accountId);

    await reportConnectionFailure({
      connection: conn,
      error: new Error("fetch failed"),
    });

    expect(SEND.sendEmail).not.toHaveBeenCalled();
    expect(await marker(conn.id)).toBeNull();
  });

  it("links a Gmail connection to the Gmail connect flow", async () => {
    const account = await makeAccount();
    const conn = await makeConnection(account.accountId, { provider: "gmail" });

    await reportConnectionFailure({
      connection: conn,
      error: new OAuthRefreshError(
        'Google token endpoint returned HTTP 400: {"error":"invalid_grant"}',
      ),
    });

    const mail = SEND.sendEmail.mock.calls[0]![0];
    expect(mail.html).toContain("/connect-gmail");
    expect(mail.text).toContain("/connect-gmail");
    expect(mail.html).not.toContain("/connect-fastmail");
    // The provider is named correctly, not always Fastmail.
    expect(mail.html).toContain("Google no longer accepts");
  });

  it("leaves the episode unmarked when the transport refuses the send", async () => {
    const account = await makeAccount();
    const conn = await makeConnection(account.accountId);
    SEND.sendEmail.mockResolvedValue(false);

    await reportConnectionFailure({ connection: conn, error: deadGrant() });

    // Unmarked, so the next failure tries again instead of leaving the
    // account with a silent, dead mailbox.
    expect(await marker(conn.id)).toBeNull();
  });
});
