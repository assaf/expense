import { afterEach, describe, expect, it, vi } from "vitest";
import { destroyEmail } from "~/lib/fastmail.server";

/**
 * destroyEmail against the real JMAP client with a stubbed transport:
 * a destroy of an already-removed email comes back as
 * `notDestroyed: { <id>: { type: "notFound" } }` (a concurrent drain
 * deleted it first). That must be treated as success, not surfaced to
 * Sentry as EXPENSE-J. Any other notDestroyed reason still throws.
 */

const SESSION = {
  apiUrl: "https://api.example.test/jmap",
  uploadUrl: "https://upload.example.test",
  downloadUrl: "https://download.example.test",
  username: "test@example.test",
  primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-1" },
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Stub fetch: the session URL is answered once (the client caches it);
 * every API call consumes the next queued response. */
function stubFetch(apiResponses: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/jmap/session")) return json(SESSION);
      const body = apiResponses.shift();
      return json(body ?? { methodResponses: [] });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("destroyEmail", () => {
  it("treats an already-deleted email (notFound) as success", async () => {
    stubFetch([
      {
        methodResponses: [
          [
            "Email/set",
            { notDestroyed: { "email-1": { type: "notFound" } } },
            "m0",
          ],
        ],
      },
    ]);
    await expect(destroyEmail("email-1")).resolves.toBeUndefined();
  });

  it("still throws when notDestroyed carries a non-notFound reason", async () => {
    stubFetch([
      {
        methodResponses: [
          [
            "Email/set",
            { notDestroyed: { "email-1": { type: "forbidden" } } },
            "m0",
          ],
        ],
      },
    ]);
    await expect(destroyEmail("email-1")).rejects.toThrow(
      "JMAP Email/set notDestroyed",
    );
  });

  it("throws on a mixed notDestroyed with at least one hard failure", async () => {
    stubFetch([
      {
        methodResponses: [
          [
            "Email/set",
            {
              notDestroyed: {
                "email-1": { type: "notFound" },
                "email-2": { type: "unknownMethod" },
              },
            },
            "m0",
          ],
        ],
      },
    ]);
    await expect(destroyEmail("email-1")).rejects.toThrow(
      "JMAP Email/set notDestroyed",
    );
  });
});
