import { afterEach, describe, expect, it, vi } from "vitest";
import { getEmailMetadata } from "~/lib/jmap.server";

/**
 * The Email/get wire boundary (app/lib/jmap.server.ts). FastMail's real
 * response shape enters the app here, zod-validated: junk shapes must
 * throw LOUDLY (the next wire surprise should be loud, not a swallowed
 * warning) and RFC 8621's String[] messageId must pass through. The
 * fetch layer is stubbed; the schema, the error contract, and the
 * missing-id path are real.
 */

const SESSION = {
  apiUrl: "https://api.test/jmap/",
  uploadUrl: "https://api.test/upload/",
  downloadUrl: "https://api.test/download/",
  username: "Test User",
  primaryAccounts: { "urn:ietf:params:jmap:mail": "mailAcc1" },
};

/** Two-request fetch stub: GET (session doc) then POST (Email/get). Each
 * test queues the Email/get response body; the token is unique per test
 * so the module's per-token session cache never collides. */
function stubEmailGet(body: unknown): void {
  const fetchMock = vi.fn(
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({ methodResponses: [["Email/get", body, "m0"]] }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(SESSION), {
        headers: { "content-type": "application/json" },
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
}

function getMetadata(id: string): Promise<unknown> {
  return getEmailMetadata({
    token: `tok-${id}`,
    accountId: "mailAcc1",
    id,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Email/get wire boundary", () => {
  it("accepts the RFC 8621 shape with String[] messageId (EXPENSE-S)", async () => {
    stubEmailGet({
      list: [
        {
          id: "Md1",
          blobId: "Gb1",
          receivedAt: "2026-08-28T12:00:00Z",
          subject: "Receipt",
          from: [{ name: "Store", email: "store@example.com" }],
          to: [{ email: "me@example.com" }],
          messageId: ["<m1@example.com>"],
        },
      ],
    });
    const meta = (await getMetadata("Md1")) as {
      messageId: string[];
      subject: string;
    };
    expect(meta.subject).toBe("Receipt");
    expect(meta.messageId).toEqual(["<m1@example.com>"]);
  });

  it("tolerates a bare-string messageId (smaller JMAP servers ship both)", async () => {
    stubEmailGet({ list: [{ id: "Md2", messageId: "<m2@example.com>" }] });
    const meta = (await getMetadata("Md2")) as { messageId: string };
    expect(meta.messageId).toBe("<m2@example.com>");
  });

  it("strips unknown properties the schema does not name", async () => {
    stubEmailGet({
      list: [{ id: "Md3", keywords: { $seen: true }, messageId: null }],
    });
    const meta = (await getMetadata("Md3")) as Record<string, unknown>;
    expect(meta).not.toHaveProperty("keywords");
    expect(meta.messageId).toBeNull();
  });

  it("returns undefined for a missing id (empty list)", async () => {
    stubEmailGet({ list: [] });
    await expect(getMetadata("Md4")).resolves.toBeUndefined();
  });

  it("throws loudly when a header has the wrong JSON type", async () => {
    // from as a bare object/string instead of a Participant array: the
    // exact class of surprise EXPENSE-S came from.
    stubEmailGet({ list: [{ id: "Md5", from: "Store <store@example.com>" }] });
    await expect(getMetadata("Md5")).rejects.toThrow(
      /Email\/get response shape mismatch/,
    );
  });

  it("throws loudly when the response is not an Email/get shape at all", async () => {
    stubEmailGet({ state: "whatever" });
    await expect(getMetadata("Md6")).rejects.toThrow(
      /Email\/get response shape mismatch/,
    );
  });
});
