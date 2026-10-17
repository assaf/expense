import { createECDH, randomBytes } from "node:crypto";
import { encrypt } from "http_ece";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { JmapAuthError } from "~/lib/jmap.server";

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
  reportConnectionFailure: vi.fn(async () => {}),
  isDeadCredential: vi.fn(() => true),
  isActionableFailure: vi.fn(() => true),
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
    remoteAccountId: "jmap-1",
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

// The notice itself (who gets told, once per episode) has its own suite; the
// env here carries no database, so it is faked and asserted as a call. The
// predicates are stubbed rather than imported: loading the real module pulls in
// the DB, which this suite's env mock does not provide. The predicate's own
// behaviour is pinned in email-connection-notice.test.ts.
vi.mock("~/lib/email-connection-notice.server", () => ({
  reportConnectionFailure: mocks.reportConnectionFailure,
  isDeadCredential: mocks.isDeadCredential,
  isActionableFailure: mocks.isActionableFailure,
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
      mocks.reportConnectionFailure,
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

  it("echoes a PushVerification with the connection's credential", async () => {
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
      expect.objectContaining({ emailAddress: "mailbox@example.com" }),
      "sub-1",
      "code-123",
    );
    // Healthy connection, no status flip.
    expect(mocks.setEmailConnectionStatus).not.toHaveBeenCalled();
  });

  it("leaves the error flag alone after a verification echo", async () => {
    // A PushVerification is a webhook about the subscription, not evidence that
    // the mailbox reads. Clearing the flag here also re-armed the reconnect
    // notice and the transition guard, so a burst of re-verifications turned
    // one failed drain into one notice per verify — the owner got the same
    // notice three times in two seconds (EXPENSE-1K). Health is the drain's to
    // report; markConnectionDrained is where it does.
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
    expect(mocks.setConnectionVerificationCode).toHaveBeenCalled();
    expect(mocks.setEmailConnectionStatus).not.toHaveBeenCalled();
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
    const failure = new Error("token revoked");
    drainMock.drainEmailConnection.mockRejectedValueOnce(failure);
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
    // The account is told the mailbox stopped importing (the notifier decides
    // whether this failure is the user's to fix).
    expect(mocks.reportConnectionFailure).toHaveBeenCalledWith({
      connection: expect.objectContaining({ id: "conn1" }),
      error: failure,
    });
  });

  it("logs rather than pages a session the connection can re-exchange", async () => {
    // EXPENSE-1K: the session endpoint refused the token while the grant was
    // alive, so the next exchange minted a new one and the mailbox kept reading
    // mail. That is not the account's to fix, and the transition guard re-fires
    // it on every flap, so it is logged rather than paged.
    mocks.readEmailConnectionById.mockImplementation(async () =>
      connection({ refreshTokenEnc: "enc-refresh" }),
    );
    mocks.isActionableFailure.mockReturnValueOnce(false);
    drainMock.drainEmailConnection.mockRejectedValueOnce(
      new JmapAuthError("session endpoint refused the credential"),
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
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
      expect(warn).toHaveBeenCalledWith(
        "[email-connections-push] drain failed (recoverable, not paged):",
        expect.objectContaining({ connectionId: "conn1" }),
      );
      // Still flagged for the Settings badge, and the notifier still decides
      // whether to mail.
      expect(mocks.setEmailConnectionStatus).toHaveBeenCalledWith(
        "conn1",
        "error",
      );
      expect(mocks.reportConnectionFailure).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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
