import { describe, expect, it } from "vitest";
import {
  resolveJmapSessionUrl,
  verifyJmapServer,
  type SessionFetch,
} from "~/lib/jmap.server";

/**
 * Per-server JMAP session loading. The fetch is injected, so the loopback
 * mock stays reachable: the production default routes a user-supplied URL
 * through the SSRF guard, which blocks loopback by design.
 */

const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";

function session(overrides: Record<string, unknown> = {}) {
  return {
    apiUrl: "https://example.com/jmap/api",
    uploadUrl: "https://example.com/jmap/upload/{accountId}",
    downloadUrl:
      "https://example.com/jmap/download/{accountId}/{blobId}/{name}?type={type}",
    username: "You@Example.com",
    primaryAccounts: { [MAIL_CAPABILITY]: "acct-primary" },
    ...overrides,
  };
}

interface Recorded {
  url: string;
  authorization: string | undefined;
}

/** An injected fetch that answers every call with the same JSON body and
 * records the URL + Authorization header it was given. */
function jsonFetch(
  body: unknown,
  status = 200,
): { fetch: SessionFetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: SessionFetch = async (url, init) => {
    calls.push({ url, authorization: headerValue(init.headers) });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

function headerValue(headers: RequestInit["headers"]): string | undefined {
  if (!headers || headers instanceof Headers || Array.isArray(headers)) {
    return undefined;
  }
  return headers.Authorization;
}

const server = (sessionUrl: string) => ({
  sessionUrl,
  authorization: "Bearer tok-1",
});

describe("resolveJmapSessionUrl", () => {
  it("uses the RFC 8620 well-known path for a bare host or root path", () => {
    expect(resolveJmapSessionUrl("https://example.com")).toBe(
      "https://example.com/.well-known/jmap",
    );
    expect(resolveJmapSessionUrl("https://example.com/")).toBe(
      "https://example.com/.well-known/jmap",
    );
  });

  it("keeps an explicit path verbatim and strips a trailing slash", () => {
    expect(resolveJmapSessionUrl("https://example.com/jmap/session")).toBe(
      "https://example.com/jmap/session",
    );
    expect(resolveJmapSessionUrl("https://example.com/jmap/session/")).toBe(
      "https://example.com/jmap/session",
    );
  });

  it("rejects an unparseable URL", () => {
    expect(() => resolveJmapSessionUrl("not a url")).toThrow();
  });
});

describe("verifyJmapServer", () => {
  it("fetches the well-known session path with the credential", async () => {
    const { fetch: fetchImpl, calls } = jsonFetch(session());
    const result = await verifyJmapServer(
      server("https://example.com"),
      fetchImpl,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info.mailAccountId).toBe("acct-primary");
      expect(result.info.username).toBe("you@example.com");
      expect(result.info.apiUrl).toBe("https://example.com/jmap/api");
    }
    expect(calls).toEqual([
      {
        url: "https://example.com/.well-known/jmap",
        authorization: "Bearer tok-1",
      },
    ]);
  });

  it("keeps an explicit session path verbatim", async () => {
    const { fetch: fetchImpl, calls } = jsonFetch(session());
    await verifyJmapServer(
      server("https://example.com/jmap/session"),
      fetchImpl,
    );
    expect(calls[0]!.url).toBe("https://example.com/jmap/session");
  });

  it("selects a writable mail account when primaryAccounts is empty", async () => {
    const { fetch: fetchImpl } = jsonFetch(
      session({
        primaryAccounts: {},
        accounts: {
          a1: {
            accountCapabilities: { [MAIL_CAPABILITY]: {} },
            isReadOnly: true,
          },
          a2: {
            accountCapabilities: { [MAIL_CAPABILITY]: {} },
            isReadOnly: false,
          },
          a3: { accountCapabilities: {}, isReadOnly: false },
        },
      }),
    );
    const result = await verifyJmapServer(
      server("https://example.com"),
      fetchImpl,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.info.mailAccountId).toBe("a2");
  });

  it("reports no-mail-account when only read-only accounts have mail", async () => {
    const { fetch: fetchImpl } = jsonFetch(
      session({
        primaryAccounts: {},
        accounts: {
          a1: {
            accountCapabilities: { [MAIL_CAPABILITY]: {} },
            isReadOnly: true,
          },
        },
      }),
    );
    const result = await verifyJmapServer(
      server("https://example.com"),
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no-mail-account");
      expect(result.message).toBe(
        "This account has no mail access on that server.",
      );
    }
  });

  it("reports network with the server-specific message for a bad session shape", async () => {
    const { fetch: fetchImpl } = jsonFetch({ apiUrl: 42 });
    const result = await verifyJmapServer(
      server("https://example.com"),
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("network");
      expect(result.message).toBe(
        "That URL is not a JMAP session; check the server address.",
      );
    }
  });

  it("reports invalid-token on 401", async () => {
    const { fetch: fetchImpl } = jsonFetch({}, 401);
    const result = await verifyJmapServer(
      server("https://example.com"),
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-token");
      expect(result.message).toBe("The server rejected that credential.");
    }
  });

  it("reports network with the HTTP status on other non-2xx", async () => {
    const { fetch: fetchImpl } = jsonFetch({}, 503);
    const result = await verifyJmapServer(
      server("https://example.com"),
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.message).toBe("That server answered HTTP 503.");
  });
});
