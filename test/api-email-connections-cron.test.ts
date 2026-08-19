import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/email-connections-cron — the daily renewal cron. CRON_SECRET-gated;
 * every connection is renewed, failures flag status=error.
 */

const mocks = vi.hoisted(() => ({
  listAllEmailConnections: vi.fn(
    async () => [] as Array<Record<string, unknown>>,
  ),
  setEmailConnectionStatus: vi.fn(async () => {}),
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
}));

vi.mock("~/lib/email-connection-push.server", () => ({
  ensureConnectionPushSubscription: mocks.ensureConnectionPushSubscription,
}));

import { loader } from "~/routes/api.email-connections-cron";

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
    jmapAccountId: "jmap-1",
    ...overrides,
  };
}

describe("api.email-connections-cron", () => {
  beforeEach(() => {
    mocks.listAllEmailConnections.mockImplementation(async () => []);
    mocks.setEmailConnectionStatus.mockClear();
    mocks.ensureConnectionPushSubscription.mockClear();
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
});
