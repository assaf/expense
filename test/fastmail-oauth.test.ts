import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { createAccount, createUser } from "~/lib/db/accounts";
import {
  createEmailConnection,
  readEmailConnectionById,
  updateEmailConnectionTokens,
} from "~/lib/db/email-connections";
import { sessionStorage, SESSION_USER_KEY } from "~/lib/auth.server";
import { loader } from "~/routes/fastmail-oauth-callback";
import type { Route } from "+types/app/routes/+types/fastmail-oauth-callback";
import {
  exchangeAuthorizationCode,
  FM_OAUTH_SESSION_KEY,
  buildAuthorizeUrl,
  generatePkcePair,
  connectionAccessToken,
  type FmOAuthFlow,
  type OAuthTokenSet,
} from "~/lib/fastmail-oauth.server";
import { verifyJmapToken } from "~/lib/jmap.server";
import { hashPassword } from "~/lib/passwords";
import { testPrisma } from "./helpers/seedTestData";
import { decryptSecret, encryptSecret } from "~/lib/token-crypto.server";

/**
 * FastMail OAuth: pure-crypto units (PKCE), the connection token resolver
 * (legacy passthrough + refresh rotation against a stubbed token endpoint),
 * and the callback route (state check + signed-in happy path). The real
 * connect path is covered by the onboarding/email-connections suites; true
 * end-to-end consent needs a registered FastMail client id.
 */

vi.mock("~/lib/jmap.server", () => ({
  verifyJmapToken: vi.fn(),
}));

vi.mock("~/lib/fastmail-oauth.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/lib/fastmail-oauth.server")>();
  return { ...actual, exchangeAuthorizationCode: vi.fn() };
});

const mockedVerify = vi.mocked(verifyJmapToken);
const mockedExchange = vi.mocked(exchangeAuthorizationCode);

const PASSWORD = "correct horse battery staple";

function flow(overrides: Partial<FmOAuthFlow> = {}): FmOAuthFlow {
  return {
    state: "flow-state",
    verifier: "verifier",
    next: "emails",
    ts: Date.now(),
    ...overrides,
  };
}

function tokenSet(overrides: Partial<OAuthTokenSet> = {}): OAuthTokenSet {
  return {
    accessToken: "oauth-at",
    refreshToken: "oauth-rt",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

// The callback loader only reads the request.
function loaderArgs(request: Request): Route.LoaderArgs {
  return { request } as Route.LoaderArgs;
}

function callbackRequest(query: string, cookie: string): Request {
  return new Request(`https://expense.test/fastmail-oauth-callback?${query}`, {
    headers: { cookie },
  });
}

async function sessionCookieWith(
  ...entries: [key: string, value: unknown][]
): Promise<string> {
  const session = await sessionStorage.getSession();
  for (const [key, value] of entries) session.set(key, value);
  return sessionStorage.commitSession(session);
}

async function seedUser() {
  const account = await createAccount(`OAuth ${ulid()}`);
  const user = await createUser({
    accountId: account.id,
    email: `oauth.${ulid()}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
    emailVerifiedAt: new Date().toISOString(),
  });
  return { account, user };
}

describe("buildAuthorizeUrl", () => {
  it("encodes the authorization request", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "client&1",
        redirectUri: "https://expense.test/fastmail-oauth-callback",
        state: "st/ate",
        challenge: "chal",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://api.fastmail.com/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("client&1");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st/ate");
    expect(url.searchParams.get("scope")).toBe(
      "urn:ietf:params:jmap:core urn:ietf:params:jmap:mail",
    );
  });
});

function okConnection(
  created: Awaited<ReturnType<typeof createEmailConnection>>,
) {
  if (!created.ok) throw new Error(created.error);
  return created.connection;
}

describe("PKCE pair", () => {
  it("produces an S256 challenge over the verifier", () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
  });

  it("is unique per call", () => {
    expect(generatePkcePair().verifier).not.toBe(generatePkcePair().verifier);
  });
});

describe("isFastMailOAuthConfigured", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("is env-gated", async () => {
    vi.stubEnv("FASTMAIL_OAUTH_CLIENT_ID", "");
    vi.resetModules();
    const off = await vi.importActual<
      typeof import("~/lib/fastmail-oauth.server")
    >("~/lib/fastmail-oauth.server");
    expect(off.isFastMailOAuthConfigured()).toBe(false);

    vi.stubEnv("FASTMAIL_OAUTH_CLIENT_ID", "test-client-id");
    vi.resetModules();
    const on = await vi.importActual<
      typeof import("~/lib/fastmail-oauth.server")
    >("~/lib/fastmail-oauth.server");
    expect(on.isFastMailOAuthConfigured()).toBe(true);
  });
});

describe("connectionAccessToken", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("unexpected live fetch");
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the decrypted API token for legacy rows with no network", async () => {
    const connection = {
      id: "legacy",
      tokenEnc: encryptSecret("legacy-token"),
      refreshTokenEnc: null,
      tokenExpiresAt: null,
    };
    expect(await connectionAccessToken(connection)).toBe("legacy-token");
  });

  it("returns the cached access token while it is still fresh", async () => {
    const connection = {
      id: "fresh",
      tokenEnc: encryptSecret("at-live"),
      refreshTokenEnc: encryptSecret("rt-live"),
      tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    expect(await connectionAccessToken(connection)).toBe("at-live");
  });

  it("refreshes an expired token and persists the rotated set", async () => {
    const account = await createAccount(`Refresh ${ulid()}`);
    const id = okConnection(
      await createEmailConnection({
        accountId: account.id,
        provider: "fastmail",
        emailAddress: `refresh.${ulid()}@example.com`,
        jmapAccountId: "jmap-1",
        tokenEnc: encryptSecret("at-expired"),
        refreshTokenEnc: encryptSecret("rt-expired"),
        tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ).id;

    let capturedBody = "";
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = typeof init?.body === "string" ? init.body : "";
        return Response.json({
          access_token: "at-rotated",
          refresh_token: "rt-rotated",
          token_type: "bearer",
          expires_in: 3600,
          scope: "urn:ietf:params:jmap:core urn:ietf:params:jmap:mail",
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    // Read through the db mapper: the resolver's contract is an ISO
    // tokenExpiresAt, which rowWithSecret produces (raw wire text parses
    // as local time and lies).
    const stored = await readEmailConnectionById(id);
    expect(stored).toBeDefined();
    const token = await connectionAccessToken(stored!);

    expect(token).toBe("at-rotated");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(capturedBody).toContain("grant_type=refresh_token");
    expect(capturedBody).toContain(
      `refresh_token=${encodeURIComponent("rt-expired")}`,
    );

    const rotated = await readEmailConnectionById(id);
    expect(rotated).toBeDefined();
    expect(decryptSecret(rotated!.tokenEnc)).toBe("at-rotated");
    expect(decryptSecret(rotated!.refreshTokenEnc!)).toBe("rt-rotated");
    // expiresAt lands roughly an hour out (60s refresh skew respects it).
    expect(Date.parse(rotated!.tokenExpiresAt!)).toBeGreaterThan(Date.now());
  });
});

describe("fastmail-oauth-callback", () => {
  beforeEach(() => {
    mockedVerify.mockReset();
    mockedExchange.mockReset();
  });

  it("rejects a state mismatch without touching the token endpoint", async () => {
    const cookie = await sessionCookieWith([FM_OAUTH_SESSION_KEY, flow()]);
    const res = await loader(
      loaderArgs(callbackRequest("code=c&state=WRONG", cookie)),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/emails?oauthError=state");
    expect(mockedExchange).not.toHaveBeenCalled();
  });

  it("redirects consent denial back to the resume page", async () => {
    const cookie = await sessionCookieWith([FM_OAUTH_SESSION_KEY, flow()]);
    const res = await loader(
      loaderArgs(
        callbackRequest("error=access_denied&state=flow-state", cookie),
      ),
    );
    expect(res.headers.get("location")).toBe("/emails?oauthError=denied");
  });

  it("connects the mailbox for a signed-in user and redirects to /emails", async () => {
    const { user } = await seedUser();
    // createEmailConnection lowercases addresses; the redirect echoes the
    // stored form.
    const address = `connect.${ulid().toLowerCase()}@example.com`;
    mockedExchange.mockResolvedValue(tokenSet());
    mockedVerify.mockResolvedValue({
      ok: true,
      info: {
        username: address,
        mailAccountId: "jmap-9",
        apiUrl: "https://api.fastmail.com/jmap/",
        uploadUrl: "https://api.fastmail.com/upload/",
        downloadUrl: "https://api.fastmail.com/download/",
      },
    });

    const cookie = await sessionCookieWith(
      [SESSION_USER_KEY, user.id],
      [
        FM_OAUTH_SESSION_KEY,
        flow({ state: "happy-state", verifier: "pkce-v" }),
      ],
    );
    const res = await loader(
      loaderArgs(callbackRequest("code=one-time&state=happy-state", cookie)),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `/emails?connected=1&address=${encodeURIComponent(address)}`,
    );
    expect(mockedExchange).toHaveBeenCalledWith(
      expect.objectContaining({ code: "one-time", verifier: "pkce-v" }),
    );

    const connection = await testPrisma.emailConnection.findUniqueOrThrow({
      where: { emailAddress: address },
    });
    expect(connection.accountId).toBe(user.accountId);
    expect(connection.jmapAccountId).toBe("jmap-9");
    expect(decryptSecret(String(connection.tokenEnc))).toBe("oauth-at");
    expect(decryptSecret(String(connection.refreshTokenEnc))).toBe("oauth-rt");
  });

  it("lands an anonymous callback on the onboarding flow via fmPending", async () => {
    mockedExchange.mockResolvedValue(tokenSet());
    mockedVerify.mockResolvedValue({
      ok: true,
      info: {
        username: `anon.${ulid().toLowerCase()}@example.com`,
        mailAccountId: "jmap-8",
        apiUrl: "https://api.fastmail.com/jmap/",
        uploadUrl: "https://api.fastmail.com/upload/",
        downloadUrl: "https://api.fastmail.com/download/",
      },
    });

    const cookie = await sessionCookieWith([
      FM_OAUTH_SESSION_KEY,
      flow({ next: "onboarding" }),
    ]);
    const res = await loader(
      loaderArgs(callbackRequest("code=one-time&state=flow-state", cookie)),
    );

    expect(res.headers.get("location")).toBe("/onboarding?connected=1");
    // The parked credentials are ciphertext on the session cookie.
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("expense_session");
    expect(setCookie).not.toContain("oauth-at");
  });
});

describe("updateEmailConnectionTokens", () => {
  it("clears the refresh fields with null", async () => {
    const account = await createAccount(`Clear ${ulid()}`);
    const id = okConnection(
      await createEmailConnection({
        accountId: account.id,
        provider: "fastmail",
        emailAddress: `clear.${ulid()}@example.com`,
        jmapAccountId: "jmap-1",
        tokenEnc: encryptSecret("at"),
        refreshTokenEnc: encryptSecret("rt"),
      }),
    ).id;
    await updateEmailConnectionTokens({
      id,
      tokenEnc: encryptSecret("at-2"),
      refreshTokenEnc: null,
      tokenExpiresAt: null,
    });
    const row = await readEmailConnectionById(id);
    expect(row).toBeDefined();
    expect(decryptSecret(row!.tokenEnc)).toBe("at-2");
    expect(row!.refreshTokenEnc).toBeNull();
    expect(row!.tokenExpiresAt).toBeNull();
  });
});
