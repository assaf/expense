import { afterEach, describe, expect, it, vi } from "vitest";
import { rawEmail } from "~/lib/fastmail.server";

/**
 * rawEmail (the RFC 5322 blob download) must reject mail over MAX_EMAIL_BYTES
 * because the inbound pipeline otherwise buffers an unbounded message into a
 * serverless function (memory-exhaustion DoS reachable by any sender whose
 * mail gets processed). The cap is enforced DURING the stream read.
 */

const SESSION = {
  apiUrl: "https://api.example.test/jmap",
  uploadUrl: "https://upload.example.test",
  downloadUrl: "https://download.example.test",
  username: "test@example.test",
  primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-1" },
};

const EMAIL_GET = {
  methodResponses: [
    [
      "Email/get",
      {
        list: [
          {
            id: "email-1",
            blobId: "blob-1",
            receivedAt: "2026-06-01T00:00:00Z",
            subject: "Receipt",
            from: [{ name: "Store", email: "store@example.net" }],
            to: [],
            messageId: "<m1@example.net>",
          },
        ],
      },
      "m0",
    ],
  ],
};
/** RFC 8621 types Email/get's messageId as String[]; Fastmail sends the
 * array form, which must never reach the reply envelope as a non-string
 * (EXPENSE-S: "value.replace is not a function" on every confirmation). */
const EMAIL_GET_ARRAY_MESSAGE_ID = {
  methodResponses: [
    [
      "Email/get",
      {
        list: [
          {
            id: "email-1",
            blobId: "blob-1",
            receivedAt: "2026-06-01T00:00:00Z",
            subject: "Receipt",
            from: [{ name: "Store", email: "store@example.net" }],
            to: [],
            messageId: ["<m1@example.net>", "<dup@example.net>"],
          },
        ],
      },
      "m0",
    ],
  ],
};

/** Stub fetch: session answered once; every other URL consumes the queue.
 * Response instances pass through untouched (needed for streamed bodies). */
function stubFetch(queue: Array<{} | Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/jmap/session")) {
        return new Response(JSON.stringify(SESSION), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const next = queue.shift();
      if (next instanceof Response) return next;
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

/** A body stream that delivers `mb` megabytes of zeros (chunked, so the
 * size is not visible to a Content-Length check). */
function dripStream(mb: number): ReadableStream<Uint8Array> {
  const CHUNK = 1024 * 1024;
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      while (sent < mb) {
        controller.enqueue(new Uint8Array(CHUNK));
        sent += 1;
      }
      controller.close();
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rawEmail", () => {
  it("rejects mail over MAX_EMAIL_BYTES with a clear error", async () => {
    stubFetch([EMAIL_GET, new Response(dripStream(16), { status: 200 })]);
    await expect(rawEmail("email-1")).rejects.toThrow(
      /email too large to process/,
    );
  });

  it("passes a normal-size blob through unchanged", async () => {
    const small = "From: store@example.net\r\n\r\nreceipt body";
    stubFetch([EMAIL_GET, new Response(small, { status: 200 })]);
    const email = await rawEmail("email-1");
    expect(email.raw.toString("utf8")).toBe(small);
  });

  it("normalizes the JMAP String[] messageId to a single string", async () => {
    const small = "From: store@example.net\r\n\r\nreceipt body";
    stubFetch([
      EMAIL_GET_ARRAY_MESSAGE_ID,
      new Response(small, { status: 200 }),
    ]);

    const email = await rawEmail("email-1");
    expect(email.messageId).toBe("<m1@example.net>");
  });
  it("throws a loud error when Email/get returns an unexpected shape", async () => {
    stubFetch([
      {
        methodResponses: [["Email/get", { list: [{ messageId: 42 }] }, "m0"]],
      },
    ]);
    await expect(rawEmail("email-1")).rejects.toThrow(
      /Email\/get response shape mismatch/,
    );
  });
});
