import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/email-connections-cron: the daily renewal cron. CRON_SECRET-gated;
 * every connection is renewed, failures flag status=error.
 */

const mocks = vi.hoisted(() => ({
  listAllEmailConnections: vi.fn(
    async () => [] as Array<Record<string, unknown>>,
  ),
  setEmailConnectionStatus: vi.fn(async () => {}),
  readEmailConnectionById: vi.fn(async (_id: string) => undefined as unknown),
  setEmailConnectionErrorNotified: vi.fn(async () => {}),
  readAccountUsers: vi.fn(async () => [] as Array<Record<string, unknown>>),
  sendEmail: vi.fn(async (_input: { to: string; subject: string }) => true),
  captureError: vi.fn(),
  ensureGmailWatch: vi.fn(async () => {}),
  connectionAccessToken: vi.fn(async () => "test-token"),
  drainEmailConnection: vi.fn(async (_connection: { id: string }) => ({
    evaluated: 0,
    created: 0,
    partial: 0,
    ignored: 0,
    failed: 0,
  })),
  captureWarning: vi.fn(),
  ensureConnectionPushSubscription: vi.fn(
    async (_connection: { id: string }) => ({
      subscriptionId: "sub-1",
      expires: "x",
      created: true,
    }),
  ),
}));

vi.mock("~/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/env")>()),
  PUSH_PRIVATE_KEY: "test-push-key",
  PUSH_AUTH: "test-push-auth",
  EMAIL_TOKEN_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  CRON_SECRET: "cron-secret",
}));

vi.mock("~/lib/db/email-connections", () => ({
  listAllEmailConnections: mocks.listAllEmailConnections,
  setEmailConnectionStatus: mocks.setEmailConnectionStatus,
  readEmailConnectionById: mocks.readEmailConnectionById,
  setEmailConnectionErrorNotified: mocks.setEmailConnectionErrorNotified,
  updateEmailConnectionTokens: vi.fn(async () => {}),
}));

vi.mock("~/lib/db/accounts", () => ({
  readAccountUsers: mocks.readAccountUsers,
}));

vi.mock("~/lib/reply.server", () => ({ sendEmail: mocks.sendEmail }));

vi.mock("~/lib/email-connection-push.server", () => ({
  ensureConnectionPushSubscription: mocks.ensureConnectionPushSubscription,
}));

vi.mock("~/lib/gmail.server", () => ({
  ensureGmailWatch: mocks.ensureGmailWatch,
}));

vi.mock("~/lib/fastmail-oauth.server", () => ({
  connectionAccessToken: mocks.connectionAccessToken,
}));

vi.mock("~/lib/email-connection-process.server", () => ({
  drainEmailConnection: mocks.drainEmailConnection,
}));

vi.mock("~/lib/errors.server", () => ({
  captureWarning: mocks.captureWarning,
  captureError: mocks.captureError,
}));

import { loader } from "~/routes/api.email-connections-cron";
import { JmapMethodError } from "~/lib/jmap.server";
import { OAuthRefreshError } from "~/lib/oauth-token-refresh.server";

function args(request: Request): Parameters<typeof loader>[0] {
  return {
    request,
    url: new URL(request.url),
    params: {},
    pattern: "api/email-connections-cron",
    context: {} as never,
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn1",
    provider: "fastmail",
    emailAddress: "mailbox@example.com",
    status: "active",
    receivedCount: 0,
    processedCount: 0,
    lastPushAt: null,
    pushSubscriptionId: null,
    pushExpiresAt: null,
    createdAt: "2026-08-19T00:00:00.000Z",
    tokenEnc: "enc",
    remoteAccountId: "jmap-1",
    ...overrides,
  };
}
describe("api.email-connections-cron", () => {
  beforeEach(() => {
    mocks.listAllEmailConnections.mockImplementation(async () => []);
    mocks.setEmailConnectionStatus.mockClear();
    mocks.ensureConnectionPushSubscription.mockClear();
    mocks.ensureGmailWatch.mockClear();
    mocks.connectionAccessToken.mockClear();
    mocks.drainEmailConnection.mockClear();
    mocks.drainEmailConnection.mockImplementation(async () => ({
      evaluated: 0,
      created: 0,
      partial: 0,
      ignored: 0,
      failed: 0,
    }));
    mocks.captureWarning.mockClear();
    mocks.captureError.mockClear();
    // The notice re-reads the row it was handed and addresses the account's
    // verified users; one verified member keeps the fan-out at one send.
    mocks.readEmailConnectionById.mockImplementation(async (id: string) =>
      connection({ id }),
    );
    mocks.readAccountUsers.mockImplementation(async () => [
      {
        email: "owner@example.com",
        emailVerifiedAt: "2026-06-15T00:00:00.000Z",
        createdAt: "2026-06-15T00:00:00.000Z",
      },
    ]);
    mocks.sendEmail.mockClear();
    mocks.sendEmail.mockResolvedValue(true);
    mocks.setEmailConnectionErrorNotified.mockClear();
    mocks.ensureGmailWatch.mockResolvedValue(undefined);
    mocks.ensureConnectionPushSubscription.mockImplementation(async () => ({
      subscriptionId: "sub-1",
      expires: "x",
      created: true,
    }));
  });

  it("rejects requests without the cron secret", async () => {
    const res = await loader(
      args(new Request("https://expense.test/api/email-connections-cron")),
    );
    expect(res.status).toBe(401);
    expect(mocks.ensureConnectionPushSubscription).not.toHaveBeenCalled();
  });

  it("renews every connection", async () => {
    mocks.listAllEmailConnections.mockImplementation(async () => [
      connection({ id: "a", status: "error" }),
      connection({ id: "b" }),
    ]);
    const res = await loader(
      args(
        new Request("https://expense.test/api/email-connections-cron", {
          headers: { Authorization: "Bearer cron-secret" },
        }),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      total: number;
      failed: number;
    };
    expect(body).toEqual({
      ok: true,
      total: 2,
      failed: 0,
      results: expect.any(Array),
    });
    expect(mocks.ensureConnectionPushSubscription).toHaveBeenCalledTimes(2);
    // A previously-flagged connection recovers once renewal succeeds.
    expect(mocks.setEmailConnectionStatus).toHaveBeenCalledWith("a", "active");
  });

  it("flags a connection as error when renewal fails", async () => {
    mocks.listAllEmailConnections.mockImplementation(async () => [
      connection({ id: "a" }),
      connection({ id: "b" }),
    ]);
    mocks.ensureConnectionPushSubscription.mockImplementation(
      async (c: { id: string }) => {
        if (c.id === "b") throw new Error("token revoked");
        return { subscriptionId: "sub-1", expires: "x", created: false };
      },
    );
    const res = await loader(
      args(
        new Request("https://expense.test/api/email-connections-cron", {
          headers: { Authorization: "Bearer cron-secret" },
        }),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; failed: number };
    expect(body.total).toBe(2);
    expect(body.failed).toBe(1);
    expect(mocks.setEmailConnectionStatus).toHaveBeenCalledWith("b", "error");
    expect(mocks.setEmailConnectionStatus).not.toHaveBeenCalledWith(
      "a",
      "error",
    );
  });

  it("flags a connection as error when the catch-up drain fails", async () => {
    mocks.listAllEmailConnections.mockImplementation(async () => [
      connection({ id: "a" }),
      connection({ id: "b" }),
    ]);
    mocks.drainEmailConnection.mockImplementation(async (c: { id: string }) => {
      if (c.id === "b") throw new Error("invalid_grant");
      return { evaluated: 0, created: 0, partial: 0, ignored: 0, failed: 0 };
    });
    const res = await loader(
      args(
        new Request("https://expense.test/api/email-connections-cron", {
          headers: { Authorization: "Bearer cron-secret" },
        }),
      ),
    );
    expect(res.status).toBe(200);
    // The renewal succeeded, so the drain is where a dead token surfaces.
    // The user has to see it in Settings, and the tick carries on.
    expect(mocks.setEmailConnectionStatus).toHaveBeenCalledWith("b", "error");
    expect(mocks.captureWarning).toHaveBeenCalledTimes(1);
    expect(mocks.drainEmailConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
    );
  });

  it("tells the account when the drain hits a grant only the user can renew", async () => {
    mocks.listAllEmailConnections.mockImplementation(async () => [
      connection({ id: "b" }),
    ]);
    mocks.drainEmailConnection.mockRejectedValue(
      new OAuthRefreshError(
        'Fastmail token endpoint returned HTTP 400: {"error":"invalid_grant"}',
      ),
    );
    const res = await loader(
      args(
        new Request("https://expense.test/api/email-connections-cron", {
          headers: { Authorization: "Bearer cron-secret" },
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(mocks.setEmailConnectionStatus).toHaveBeenCalledWith("b", "error");
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0]![0]).toMatchObject({
      to: "owner@example.com",
      subject: "mailbox@example.com needs reconnecting on Expense",
    });
    expect(mocks.setEmailConnectionErrorNotified).toHaveBeenCalledWith(
      "b",
      expect.any(String),
    );
  });

  it("says nothing for a drain failure the user cannot act on", async () => {
    mocks.listAllEmailConnections.mockImplementation(async () => [
      connection({ id: "b" }),
    ]);
    mocks.drainEmailConnection.mockRejectedValue(
      new Error("Fastmail token endpoint returned HTTP 500: gateway"),
    );
    const res = await loader(
      args(
        new Request("https://expense.test/api/email-connections-cron", {
          headers: { Authorization: "Bearer cron-secret" },
        }),
      ),
    );
    expect(res.status).toBe(200);
    // Still flagged for Settings, exactly as before this notice existed.
    expect(mocks.setEmailConnectionStatus).toHaveBeenCalledWith("b", "error");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.setEmailConnectionErrorNotified).not.toHaveBeenCalled();
  });

  it("reports a connection that is already flagged only once", async () => {
    mocks.listAllEmailConnections.mockImplementation(async () => [
      connection({ id: "a", status: "error" }),
    ]);
    mocks.drainEmailConnection.mockRejectedValue(new Error("invalid_grant"));
    const res = await loader(
      args(
        new Request("https://expense.test/api/email-connections-cron", {
          headers: { Authorization: "Bearer cron-secret" },
        }),
      ),
    );
    expect(res.status).toBe(200);
    // Already flagged: nothing new for the user, and no daily Sentry event
    // for a mailbox nobody has reconnected.
    expect(mocks.captureWarning).not.toHaveBeenCalled();
    expect(mocks.setEmailConnectionStatus).toHaveBeenCalledWith("a", "error");
  });

  it("keeps renewing when the failure flag itself cannot be written", async () => {
    mocks.listAllEmailConnections.mockImplementation(async () => [
      connection({ id: "a" }),
      connection({ id: "b" }),
    ]);
    mocks.ensureConnectionPushSubscription.mockImplementation(
      async (c: { id: string }) => {
        if (c.id === "a") throw new Error("token revoked");
        return { subscriptionId: "sub-1", expires: "x", created: false };
      },
    );
    // The status write is the last thing the failure path does: a database
    // hiccup there must not abort the tick, or every connection after the
    // failing one gets neither renewal nor drain.
    mocks.setEmailConnectionStatus.mockRejectedValueOnce(new Error("db down"));
    const res = await loader(
      args(
        new Request("https://expense.test/api/email-connections-cron", {
          headers: { Authorization: "Bearer cron-secret" },
        }),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; failed: number };
    expect(body.total).toBe(2);
    expect(body.failed).toBe(1);
    expect(mocks.drainEmailConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: "b" }),
    );
  });

  it("handles an empty registry", async () => {
    const res = await loader(
      args(
        new Request("https://expense.test/api/email-connections-cron", {
          headers: { Authorization: "Bearer cron-secret" },
        }),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(0);
  });

  it("renews an expiring gmail watch and skips a fresh one", async () => {
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
    mocks.listAllEmailConnections.mockImplementation(async () => [
      // Expiring within the 48h margin: renewed.
      connection({ id: "g1", provider: "gmail", pushExpiresAt: soon }),
      // Fresh for 6 days: skipped.
      connection({ id: "g2", provider: "gmail", pushExpiresAt: fresh }),
      // No expiration at all: renewed.
      connection({ id: "g3", provider: "gmail" }),
    ]);
    const res = await loader(
      args(
        new Request("https://expense.test/api/email-connections-cron", {
          headers: { Authorization: "Bearer cron-secret" },
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(mocks.ensureGmailWatch).toHaveBeenCalledTimes(2);
    expect(mocks.ensureGmailWatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: "g1" }),
      "test-token",
    );
    expect(mocks.ensureGmailWatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: "g3" }),
      "test-token",
    );
    // The Fastmail connection still takes the JMAP renewal path.
    expect(mocks.ensureConnectionPushSubscription).not.toHaveBeenCalled();
  });

  it("flags a connection as error when the gmail watch renewal fails", async () => {
    mocks.listAllEmailConnections.mockImplementation(async () => [
      connection({ id: "g1", provider: "gmail", pushExpiresAt: null }),
    ]);
    mocks.ensureGmailWatch.mockRejectedValue(new Error("watch refused"));
    const res = await loader(
      args(
        new Request("https://expense.test/api/email-connections-cron", {
          headers: { Authorization: "Bearer cron-secret" },
        }),
      ),
    );
    const body = (await res.json()) as { total: number; failed: number };
    expect(body.failed).toBe(1);
    expect(mocks.setEmailConnectionStatus).toHaveBeenCalledWith("g1", "error");
  });

  it("keeps a JMAP connection active when the server has no push support", async () => {
    mocks.listAllEmailConnections.mockImplementation(async () => [
      connection({ id: "a", provider: "jmap" }),
    ]);
    mocks.ensureConnectionPushSubscription.mockRejectedValue(
      new JmapMethodError("PushSubscription/set", "unknownMethod", {
        type: "unknownMethod",
      }),
    );
    const res = await loader(
      args(
        new Request("https://expense.test/api/email-connections-cron", {
          headers: { Authorization: "Bearer cron-secret" },
        }),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; failed: number };
    // A push-less server is usable through the drain: no needs-attention.
    expect(mocks.setEmailConnectionStatus).not.toHaveBeenCalledWith(
      "a",
      "error",
    );
    expect(body.failed).toBe(0);
    // The catch-up drain still ran for that connection.
    expect(mocks.drainEmailConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
    );
  });

  it("still flags a genuine push failure on a JMAP connection", async () => {
    mocks.listAllEmailConnections.mockImplementation(async () => [
      connection({ id: "a", provider: "jmap" }),
    ]);
    mocks.ensureConnectionPushSubscription.mockRejectedValue(
      new Error("PushSubscription/set failed: 500"),
    );
    const res = await loader(
      args(
        new Request("https://expense.test/api/email-connections-cron", {
          headers: { Authorization: "Bearer cron-secret" },
        }),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; failed: number };
    expect(body.failed).toBe(1);
    expect(mocks.setEmailConnectionStatus).toHaveBeenCalledWith("a", "error");
    expect(mocks.drainEmailConnection).not.toHaveBeenCalled();
  });
});
