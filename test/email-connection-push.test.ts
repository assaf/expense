import { beforeEach, describe, expect, it, vi } from "vitest";
import { createECDH, randomBytes } from "node:crypto";

/**
 * ensureConnectionPushSubscription: the per-connection renewal logic.
 * The JMAP wire ops (jmapPush*) and the DB write are mocked; the token
 * decryption is real (EMAIL_TOKEN_ENCRYPTION_KEY from the vitest env).
 */

vi.mock("~/lib/env", async (importOriginal) => {
  const push = createECDH("prime256v1");
  push.generateKeys();
  return {
    ...(await importOriginal<typeof import("~/lib/env")>()),
    PUBLIC_URL: "https://expense.test",
    // CI has no .env; generate fixed push keys so p256dhFromPrivate works.
    PUSH_PRIVATE_KEY: push.getPrivateKey("base64url"),
    PUSH_AUTH: randomBytes(16).toString("base64url"),
  };
});

const mocks = vi.hoisted(() => ({
  save: vi.fn(async () => {}),
}));

vi.mock("~/lib/db/email-connections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/db/email-connections")>()),
  saveEmailConnectionSubscription: mocks.save,
}));

// Scriptable JMAP push ops: list reads `state.subs`; create/destroy mutate it.
const jmap = vi.hoisted(() => {
  const state = {
    subs: [] as Array<{
      id: string;
      deviceClientId: string;
      expires: string | null;
      url: string;
    }>,
    destroyed: [] as string[],
  };
  return {
    state,
    jmapPushList: vi.fn(async () => state.subs.map((s) => ({ ...s }))),
    jmapPushCreate: vi.fn(
      async (
        _token: string,
        opts: { url: string; deviceClientId: string; expires: string },
      ) => {
        const id = `sub-${state.subs.length + 1}`;
        state.subs.push({
          id,
          deviceClientId: opts.deviceClientId,
          expires: opts.expires,
          url: opts.url,
        });
        return id;
      },
    ),
    jmapPushVerify: vi.fn(async () => {}),
    jmapPushDestroy: vi.fn(async (_token: string, id: string) => {
      state.destroyed.push(id);
      state.subs = state.subs.filter((s) => s.id !== id);
    }),
  };
});

vi.mock("~/lib/jmap.server", () => ({
  jmapPushList: jmap.jmapPushList,
  jmapPushCreate: jmap.jmapPushCreate,
  jmapPushVerify: jmap.jmapPushVerify,
  jmapPushDestroy: jmap.jmapPushDestroy,
}));

import { ensureConnectionPushSubscription } from "~/lib/email-connection-push.server";
import { encryptSecret } from "~/lib/token-crypto.server";

const TOKEN = "fmu1-conn-tok";

function connection() {
  return { id: "conn1", tokenEnc: encryptSecret(TOKEN) };
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

describe("ensureConnectionPushSubscription", () => {
  beforeEach(() => {
    jmap.state.subs = [];
    jmap.state.destroyed = [];
    mocks.save.mockClear();
  });

  it("creates a 30-day subscription when none exists", async () => {
    const result = await ensureConnectionPushSubscription(connection());
    expect(result.created).toBe(true);
    expect(jmap.state.subs).toHaveLength(1);
    const sub = jmap.state.subs[0]!;
    expect(sub.deviceClientId).toBe("expense-conn-conn1");
    expect(sub.url).toBe(
      "https://expense.test/api/email-connections-push?c=conn1",
    );
    expect(new Date(result.expires).getTime()).toBeGreaterThan(
      Date.now() + 29 * 24 * 60 * 60 * 1000,
    );
    expect(mocks.save).toHaveBeenCalledWith(
      "conn1",
      result.subscriptionId,
      result.expires,
    );
  });

  it("keeps a live subscription and only saves its state", async () => {
    const liveExpiry = daysFromNow(20);
    jmap.state.subs = [
      {
        id: "live-1",
        deviceClientId: "expense-conn-conn1",
        expires: liveExpiry,
        url: "old",
      },
    ];
    const result = await ensureConnectionPushSubscription(connection());
    expect(result).toEqual({
      subscriptionId: "live-1",
      expires: liveExpiry,
      created: false,
    });
    expect(jmap.state.subs).toHaveLength(1);
    expect(mocks.save).toHaveBeenCalledWith("conn1", "live-1", liveExpiry);
  });

  it("destroys an expiring subscription and recreates it", async () => {
    jmap.state.subs = [
      {
        id: "old-1",
        deviceClientId: "expense-conn-conn1",
        expires: daysFromNow(3),
        url: "old",
      },
    ];
    const result = await ensureConnectionPushSubscription(connection());
    expect(result.created).toBe(true);
    expect(jmap.state.destroyed).toEqual(["old-1"]);
    expect(jmap.state.subs.map((s) => s.id)).toEqual([result.subscriptionId]);
  });

  it("ignores other devices' subscriptions", async () => {
    jmap.state.subs = [
      {
        id: "foreign",
        deviceClientId: "expense-receipts",
        expires: daysFromNow(3),
        url: "other app",
      },
    ];
    const result = await ensureConnectionPushSubscription(connection());
    expect(result.created).toBe(true);
    expect(jmap.state.destroyed).toEqual([]);
    expect(jmap.state.subs.map((s) => s.id)).toContain("foreign");
  });

  it("recreates subscriptions with a null expiry", async () => {
    jmap.state.subs = [
      {
        id: "null-exp",
        deviceClientId: "expense-conn-conn1",
        expires: null,
        url: "old",
      },
    ];
    const result = await ensureConnectionPushSubscription(connection());
    expect(result.created).toBe(true);
    expect(jmap.state.destroyed).toEqual(["null-exp"]);
  });
});
