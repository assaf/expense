import { createECDH } from "node:crypto";
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
// real (successful decryption is the route's auth), using the app's own keys
// from the environment. When the keys are absent (CI without .env) the
// decryption-dependent cases skip and only the unconfigured paths run.
vi.mock("~/lib/fastmail.server", () => ({
  setVerificationCode: mocks.setVerificationCode,
}));
vi.mock("~/lib/inbound-fastmail.server", () => ({
  processUnprocessedReceipts: mocks.processUnprocessedReceipts,
}));

import { action } from "~/routes/api.inbound-push";
import { FASTMAIL_TOKEN, PUSH_AUTH, PUSH_PRIVATE_KEY } from "~/lib/env";
import { p256dhFromPrivate } from "~/lib/fastmail-push.server";

const configured = Boolean(FASTMAIL_TOKEN && PUSH_PRIVATE_KEY && PUSH_AUTH);

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

/** Encrypt a payload to the app's own push key (the sender-side forge). */
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

  describe.skipIf(configured)("unconfigured deployment", () => {
    it("returns 503", async () => {
      const res = await action(args(post("anything")));
      expect(res.status).toBe(503);
    });
  });

  describe.skipIf(!configured)("configured deployment", () => {
    it("rejects an undecryptable body", async () => {
      const res = await action(args(post("not encrypted")));
      expect(res.status).toBe(400);
    });

    it("echoes a PushVerification code back to FastMail", async () => {
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
});
