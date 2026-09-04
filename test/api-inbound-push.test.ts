import { createECDH, randomBytes } from "node:crypto";
import { encrypt } from "http_ece";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setVerificationCode: vi.fn(async () => {}),
  processUnprocessedReceipts: vi.fn(async () => ({
    processed: 1,
    failed: 0,
    destroyed: 1,
  })),
}));

// The route's network-facing collaborators are mocked; decryption itself is
// real (successful decryption is the route's auth). ~/lib/env is mocked
// with a throwaway keypair so the decrypt cases run everywhere (including CI
// without .env). The forge below encrypts to the same mock keys. The keys
// are generated lazily: vi.hoisted runs before node:crypto is initialized,
// but the getters below are only read once the route imports the env
// module, by which time the import has executed.
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
  };
});

vi.mock("~/lib/env", () => env);
vi.mock("~/lib/fastmail.server", () => ({
  setVerificationCode: mocks.setVerificationCode,
}));
vi.mock("~/lib/inbound-fastmail.server", () => ({
  processUnprocessedReceipts: mocks.processUnprocessedReceipts,
}));

import { action } from "~/routes/api.inbound-push";
import { PUSH_AUTH, PUSH_PRIVATE_KEY } from "~/lib/env";
import { p256dhFromPrivate } from "~/lib/fastmail-push.server";

function args(request: Request): Parameters<typeof action>[0] {
  return {
    request,
    url: new URL(request.url),
    params: {},
    pattern: "api/inbound-push",
    context: {} as never,
  };
}

function post(body: Uint8Array | string): Request {
  return new Request("https://expense.test/api/inbound-push", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: body as unknown as BodyInit,
  });
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
  });
}

describe("api.inbound-push", () => {
  beforeEach(() => {
    mocks.setVerificationCode.mockClear();
    mocks.processUnprocessedReceipts.mockClear();
  });

  it("rejects non-POST methods", async () => {
    const res = await action(
      args(new Request("https://expense.test/api/inbound-push")),
    );
    expect(res.status).toBe(405);
  });

  it("rejects an undecryptable body", async () => {
    const res = await action(args(post("not encrypted")));
    expect(res.status).toBe(400);
  });

  it("echoes a PushVerification code back to Fastmail", async () => {
    const res = await action(
      args(
        post(
          forge({
            "@type": "PushVerification",
            pushSubscriptionId: "sub-123",
            verificationCode: "code-456",
          }),
        ),
      ),
    );
    expect(res.status).toBe(200);
    expect(mocks.setVerificationCode).toHaveBeenCalledWith(
      "sub-123",
      "code-456",
    );
    expect(mocks.processUnprocessedReceipts).not.toHaveBeenCalled();
  });

  it("drains the Receipts folder on a StateChange", async () => {
    const res = await action(
      args(post(forge({ "@type": "StateChange", changed: {} }))),
    );
    expect(res.status).toBe(200);
    expect(mocks.processUnprocessedReceipts).toHaveBeenCalledTimes(1);
    expect(mocks.setVerificationCode).not.toHaveBeenCalled();
  });

  it("acknowledges an unknown payload type", async () => {
    const res = await action(args(post(forge({ "@type": "SomethingElse" }))));
    expect(res.status).toBe(200);
    expect(mocks.setVerificationCode).not.toHaveBeenCalled();
    expect(mocks.processUnprocessedReceipts).not.toHaveBeenCalled();
  });
});
