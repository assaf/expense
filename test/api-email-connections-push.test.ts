import { createECDH, randomBytes } from "node:crypto";
import { encrypt } from "http_ece";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/email-connections-push: the per-connection webhook. Decryption is
 * real (successful decryption is the route's auth); the env is mocked with
 * a throwaway keypair and the network-facing collaborators (JMAP
 * verification echo, DB) are mocked.
 */

const mocks = vi.hoisted(() => ({
  setConnectionVerificationCode: vi.fn(async () => {}),
  readEmailConnectionById: vi.fn(),
  touchEmailConnectionPush: vi.fn(async () => {}),
  setEmailConnectionStatus: vi.fn(async () => {}),
}));

/** The connected-mailbox row the push tests decrypt; tokenEnc is forged per
 * test (the default active row, or the error-flag row). */
function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn1",
    provider: "fastmail",
    emailAddress: "mailbox@example.com",
    status: "active",
    receivedCount: 0,
    processedCount: 0,
    lastPushAt: null,
    pushSubscriptionId: "sub-1",
    pushExpiresAt: null,
    createdAt: "2026-08-19T00:00:00.000Z",
    tokenEnc: "enc",
    jmapAccountId: "jmap-1",
    ...overrides,
  };
}

const env = vi.hoisted(() => {
  let keys: { privateKey: string; auth: string } | undefined;
  function generate(): { privateKey: string; auth: string } {
    const push = createECDH("prime256v1");
    push.generateKeys();
    return {
      privateKey: push.getPrivateKey("base64url"),
      auth: randomBytes(16).toString("base64url"),
    };
  }
  return {
    FASTMAIL_TOKEN: "test-token",
    get PUSH_PRIVATE_KEY() {
      return (keys ??= generate()).privateKey;
    },
    get PUSH_AUTH() {
      return (keys ??= generate()).auth;
    },
    DEVICE_CLIENT_ID: "test-device",
    PUBLIC_URL: "https://expense.test",
    EMAIL_TOKEN_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  };
});

vi.mock("~/lib/env", () => env);
vi.mock("~/lib/email-connection-push.server", () => ({
  setConnectionVerificationCode: mocks.setConnectionVerificationCode,
}));
const drainMock = vi.hoisted(() => ({
  drainEmailConnection: vi.fn(async () => ({
    evaluated: 0,
    created: 0,
    partial: 0,
    ignored: 0,
    failed: 0,
  })),
}));

vi.mock("~/lib/email-connection-process.server", () => ({
  drainEmailConnection: drainMock.drainEmailConnection,
}));

vi.mock("~/lib/db/email-connections", () => ({
  readEmailConnectionById: mocks.readEmailConnectionById,
  touchEmailConnectionPush: mocks.touchEmailConnectionPush,
  setEmailConnectionStatus: mocks.setEmailConnectionStatus,
}));

import { action } from "~/routes/api.email-connections-push";
import { PUSH_AUTH, PUSH_PRIVATE_KEY } from "~/lib/env";
import { p256dhFromPrivate } from "~/lib/fastmail-push.server";
import { encryptSecret } from "~/lib/token-crypto.server";

function args(request: Request): Parameters<typeof action>[0] {
  return {
    request,
    url: new URL(request.url),
    params: {},
    pattern: "api/email-connections-push",
    context: {} as never,
  };
}

function post(body: Uint8Array | string, connectionId = "conn1"): Request {
  return new Request(
    `https://expense.test/api/email-connections-push?c=${connectionId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: body as unknown as BodyInit,
    },
  );
}

/** Encrypt a payload to the app's push key (the sender-side forge). */
function forge(payload: unknown): Buffer {
  const sender = createECDH("prime256v1");
  sender.generateKeys();
  return encrypt(Buffer.from(JSON.stringify(payload), "utf8"), {
    version: "aes128gcm",
    dh: p256dhFromPrivate(PUSH_PRIVATE_KEY),
    privateKey: sender,
    authSecret: PUSH_AUTH,
  }) as unknown as Buffer;
}

describe("api.email-connections-push", () => {
  beforeEach(() => {
    for (const m of [
      mocks.setConnectionVerificationCode,
      mocks.touchEmailConnectionPush,
      mocks.setEmailConnectionStatus,
    ])
      m.mockClear();
    drainMock.drainEmailConnection.mockClear();
    drainMock.drainEmailConnection.mockResolvedValue({
      evaluated: 0,
      created: 0,
      partial: 0,
      ignored: 0,
      failed: 0,
    });
    mocks.readEmailConnectionById.mockClear();
    // Reset the default connection (tests may override per case).
    mocks.readEmailConnectionById.mockImplementation(async () =>
      connection({ tokenEnc: encryptSecret("fmu1-conn-tok") }),
    );
  });

  it("echoes a PushVerification with the connection's decrypted token", async () => {
    const res = await action(
      args(
        post(
          forge({
            "@type": "PushVerification",
            pushSubscriptionId: "sub-1",
            verificationCode: "code-123",
          }),
        ),
      ),
    );
    expect(res.status).toBe(200);
    expect(mocks.setConnectionVerificationCode).toHaveBeenCalledWith(
      "fmu1-conn-tok",
      "sub-1",
      "code-123",
    );
    // Healthy connection, no status flip.
    expect(mocks.setEmailConnectionStatus).not.toHaveBeenCalled();
  });

  it("clears the error flag after a successful verification echo", async () => {
    mocks.readEmailConnectionById.mockImplementation(async () =>
      connection({ status: "error", tokenEnc: encryptSecret("fmu1-conn-tok") }),
    );
    const res = await action(
      args(
        post(
          forge({
            "@type": "PushVerification",
            pushSubscriptionId: "sub-1",
            verificationCode: "code-123",
          }),
        ),
      ),
    );
    expect(res.status).toBe(200);
    expect(mocks.setEmailConnectionStatus).toHaveBeenCalledWith(
      "conn1",
      "active",
    );
  });

  it("stamps lastPushAt on StateChange and drains the connection", async () => {
    const res = await action(
      args(
        post(
          forge({
            "@type": "StateChange",
            changed: { "jmap-1": ["Email"] },
          }),
        ),
      ),
    );
    expect(res.status).toBe(200);
    expect(mocks.touchEmailConnectionPush).toHaveBeenCalledWith("conn1");
    expect(drainMock.drainEmailConnection).toHaveBeenCalledTimes(1);
  });

  it("flags the connection when a drain fails", async () => {
    drainMock.drainEmailConnection.mockRejectedValueOnce(
      new Error("token revoked"),
    );
    const res = await action(
      args(
        post(
          forge({
            "@type": "StateChange",
            changed: { "jmap-1": ["Email"] },
          }),
        ),
      ),
    );
    expect(res.status).toBe(200);
    expect(mocks.setEmailConnectionStatus).toHaveBeenCalledWith(
      "conn1",
      "error",
    );
  });

  it("404s pushes for an unknown connection", async () => {
    mocks.readEmailConnectionById.mockImplementation(async () => undefined);
    const res = await action(
      args(post(forge({ "@type": "StateChange", changed: {} }), "gone")),
    );
    expect(res.status).toBe(404);
    expect(mocks.touchEmailConnectionPush).not.toHaveBeenCalled();
  });

  it("rejects garbage bodies (decrypt failure is the auth)", async () => {
    const res = await action(args(post(Buffer.from("not encrypted"))));
    expect(res.status).toBe(400);
    expect(mocks.touchEmailConnectionPush).not.toHaveBeenCalled();
  });

  it("rejects a missing connection id", async () => {
    const res = await action(
      args(
        new Request("https://expense.test/api/email-connections-push", {
          method: "POST",
          body: Buffer.alloc(0),
        }),
      ),
    );
    expect(res.status).toBe(400);
  });

  it("rejects non-POST methods", async () => {
    const res = await action(
      args(
        new Request("https://expense.test/api/email-connections-push?c=conn1"),
      ),
    );
    expect(res.status).toBe(405);
  });
});
