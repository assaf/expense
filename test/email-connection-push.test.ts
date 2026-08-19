import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ensureConnectionPushSubscription — the per-connection renewal logic.
 * The JMAP transport (jmapCall) and the DB write are mocked; the token
 * decryption is real (EMAIL_TOKEN_ENCRYPTION_KEY from the vitest env).
 */

vi.mock("~/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/env")>()),
  PUBLIC_URL: "https://expense.test",
}));

const mocks = vi.hoisted(() => ({
  save: vi.fn(async () => {}),
}));

vi.mock("~/lib/db/email-connections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/db/email-connections")>()),
  saveEmailConnectionSubscription: mocks.save,
}));

// A scriptable JMAP endpoint: PushSubscription/get returns `list`,
// PushSubscription/set create/destroy records the calls.
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
    calls: [] as unknown[][],
    jmapCall: vi.fn(async (_token: string, methodCalls: unknown[][]) => {
      jmap.calls.push(methodCalls);
      const [name, args] = methodCalls[0] as [string, Record<string, unknown>];
      if (name === "PushSubscription/get") {
        return [["PushSubscription/get", { list: state.subs }, "m0"]];
      }
      if (name === "PushSubscription/set") {
        if (args.destroy) {
          state.destroyed.push(...(args.destroy as string[]));
          state.subs = state.subs.filter(
            (s) => !state.destroyed.includes(s.id),
          );
          return [["PushSubscription/set", { destroyed: args.destroy }, "m0"]];
        }
        if (args.create) {
          const id = `sub-${state.subs.length + 1}`;
          const created = (
            args.create as Record<string, Record<string, unknown>>
          ).sub1!;
          state.subs.push({
            id,
            deviceClientId: created.deviceClientId as string,
            expires: created.expires as string,
            url: created.url as string,
          });
          return [
            ["PushSubscription/set", { created: { sub1: { id } } }, "m0"],
          ];
        }
        return [["PushSubscription/set", {}, "m0"]];
      }
      throw new Error(`unexpected JMAP call ${name}`);
    }),
  };
});

vi.mock("~/lib/jmap.server", () => ({
  jmapCall: jmap.jmapCall,
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
    jmap.calls = [];
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
