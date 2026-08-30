import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureSubscription: vi.fn(async () => "sub-1"),
  processUnprocessedReceipts: vi.fn(async () => ({
    processed: 1,
    failed: 0,
    destroyed: 0,
  })),
}));

// Mutable, read live via getters: individual tests flip FASTMAIL_TOKEN /
// CRON_SECRET to reach the route's unconfigured and disabled branches;
// beforeEach restores them. The rest of the env module stays real because
// the route's import chain (prisma.server) needs DATABASE_URL.
const env = vi.hoisted(() => ({
  FASTMAIL_TOKEN: "fm-token",
  CRON_SECRET: "cron-secret",
}));

vi.mock("~/lib/env", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    get FASTMAIL_TOKEN() {
      return env.FASTMAIL_TOKEN;
    },
    get CRON_SECRET() {
      return env.CRON_SECRET;
    },
  };
});
vi.mock("~/lib/fastmail-push.server", () => ({
  ensureSubscription: mocks.ensureSubscription,
}));
vi.mock("~/lib/inbound-fastmail.server", () => ({
  processUnprocessedReceipts: mocks.processUnprocessedReceipts,
}));

import { loader } from "~/routes/api.inbound-cron";

function args(request: Request): Parameters<typeof loader>[0] {
  return { request, params: {}, context: {} } as Parameters<typeof loader>[0];
}

function cronRequest(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  return new Request("http://localhost/api/inbound-cron", { headers });
}

describe("GET /api/inbound-cron", () => {
  beforeEach(() => {
    env.FASTMAIL_TOKEN = "fm-token";
    env.CRON_SECRET = "cron-secret";
    vi.clearAllMocks();
  });

  it("rejects a missing Authorization header", async () => {
    const res = await loader(args(cronRequest()));
    expect(res.status).toBe(401);
    expect(mocks.ensureSubscription).not.toHaveBeenCalled();
    expect(mocks.processUnprocessedReceipts).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret", async () => {
    const res = await loader(args(cronRequest("Bearer nope")));
    expect(res.status).toBe(401);
    expect(mocks.processUnprocessedReceipts).not.toHaveBeenCalled();
  });

  it("is unreachable when CRON_SECRET is unset", async () => {
    env.CRON_SECRET = "";
    const res = await loader(args(cronRequest("Bearer cron-secret")));
    expect(res.status).toBe(401);
  });

  it("reports 503 when FastMail is not configured on the deployment", async () => {
    // The unconfigured check comes before the secret check: a deployment
    // without FastMail answers 503 to everything, cron secret or not.
    env.FASTMAIL_TOKEN = "";
    const res = await loader(args(cronRequest("Bearer cron-secret")));
    expect(res.status).toBe(503);
    expect(mocks.ensureSubscription).not.toHaveBeenCalled();
  });

  it("renews the subscription and drains on a good tick", async () => {
    const res = await loader(args(cronRequest("Bearer cron-secret")));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      subscriptionId: "sub-1",
      processed: 1,
      failed: 0,
      destroyed: 0,
    });
    expect(mocks.ensureSubscription).toHaveBeenCalledTimes(1);
    expect(mocks.processUnprocessedReceipts).toHaveBeenCalledTimes(1);
  });

  it("answers 500 when the drain fails", async () => {
    mocks.processUnprocessedReceipts.mockRejectedValueOnce(
      new Error("JMAP down"),
    );
    const res = await loader(args(cronRequest("Bearer cron-secret")));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "cron failed" });
  });
});
