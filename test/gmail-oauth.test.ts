import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { createAccount, createUser } from "~/lib/db/accounts";
import {
  createEmailConnection,
  readEmailConnectionById,
} from "~/lib/db/email-connections";
import { sessionStorage, SESSION_USER_KEY } from "~/lib/auth.server";
import { loader as callbackLoader } from "~/routes/gmail-oauth-callback";
import { loader as connectLoader } from "~/routes/connect-gmail";
import type { Route } from "+types/app/routes/+types/gmail-oauth-callback";
import type { Route as ConnectRoute } from "+types/app/routes/+types/connect-gmail";
import {
  GOOGLE_OAUTH_SESSION_KEY,
  GOOGLE_PENDING_SESSION_KEY,
  decodeGoogleIdToken,
  type GoogleOAuthFlow,
} from "~/lib/google-oauth.server";
import { hashPassword } from "~/lib/passwords";
import { testPrisma } from "./helpers/seedTestData";
import { decryptSecret, encryptSecret } from "~/lib/token-crypto.server";

/**
 * Gmail OAuth: authorize-URL params, env gating, the connection token
 * resolver (fresh skip, refresh rotation that keeps Google's unrotated
 * refresh token, concurrent dedup, failure keeps stored creds), the
 * callback route (state check, consent denial, signed-in and anonymous
 * paths), and the env-gated entry route's PKCE handshake. True end-to-end
 * consent needs the GCP client; see docs/email-connections.md → Gmail /
 * Google Workspace.
 */

vi.mock("~/lib/gmail.server", () => ({
  gmailProfileEmail: vi.fn(),
}));

vi.mock("~/lib/google-oauth.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/lib/google-oauth.server")>();
  return {
    ...actual,
    exchangeGmailAuthorizationCode: vi.fn(),
    // Per-test overrides for the env-gated routes.
    isGmailOAuthConfigured: vi.fn(actual.isGmailOAuthConfigured),
  };
});

import {
  exchangeGmailAuthorizationCode,
  isGmailOAuthConfigured,
  gmailAccessToken,
} from "~/lib/google-oauth.server";
import { gmailProfileEmail } from "~/lib/gmail.server";

const mockedExchange = vi.mocked(exchangeGmailAuthorizationCode);
const mockedConfigured = vi.mocked(isGmailOAuthConfigured);
const mockedProfile = vi.mocked(gmailProfileEmail);

function idTokenFor(sub: string): string {
  const payload = Buffer.from(
    JSON.stringify({ sub, email: "ignored" }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function gmailTokenSet(
  overrides: Partial<{
    accessToken: string;
    refreshToken: string | null;
    expiresAt: number;
    idToken: string | null;
  }> = {},
) {
  return {
    accessToken: "gmail-at",
    refreshToken: "gmail-rt",
    expiresAt: Date.now() + 3600_000,
    idToken: idTokenFor("google-sub-1"),
    ...overrides,
  };
}

function flow(overrides: Partial<GoogleOAuthFlow> = {}): GoogleOAuthFlow {
  return {
    state: "flow-state",
    verifier: "verifier",
    next: "emails",
    ts: Date.now(),
    ...overrides,
  };
}

// The route loaders only read the request.
function args(request: Request): Route.LoaderArgs {
  return { request } as Route.LoaderArgs;
}

function connectArgs(request: Request): ConnectRoute.LoaderArgs {
  return { request } as ConnectRoute.LoaderArgs;
}

function callbackRequest(query: string, cookie: string): Request {
  return new Request(`https://expense.test/gmail-oauth-callback?${query}`, {
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

const PASSWORD = "correct horse battery staple";

async function seedUser() {
  const account = await createAccount(`Gmail ${ulid()}`);
  const user = await createUser({
    accountId: account.id,
    email: `gmail.${ulid()}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
    emailVerifiedAt: new Date().toISOString(),
  });
  return { account, user };
}

// --- Pure units -----------------------------------------------------------------

describe("decodeGoogleIdToken", () => {
  it("extracts sub from the payload without verifying the signature", () => {
    expect(decodeGoogleIdToken(idTokenFor("sub-42")).sub).toBe("sub-42");
  });
  it("returns an empty object for garbage", () => {
    expect(decodeGoogleIdToken("not.a.token")).toEqual({});
  });
});

async function seedGmailConnection(overrides: {
  tokenEnc?: string;
  refreshTokenEnc?: string | null;
  tokenExpiresAt?: string;
}) {
  const account = await createAccount(`Gmail conn ${ulid()}`);
  const created = await createEmailConnection({
    accountId: account.id,
    provider: "gmail",
    emailAddress: `conn.${ulid()}@example.com`,
    remoteAccountId: "google-sub-x",
    tokenEnc: encryptSecret(overrides.tokenEnc ?? "at"),
    refreshTokenEnc:
      overrides.refreshTokenEnc === null
        ? undefined
        : encryptSecret(overrides.refreshTokenEnc ?? "rt"),
    tokenExpiresAt: overrides.tokenExpiresAt,
  });
  if (!created.ok) throw new Error(created.error);
  return created.connection.id;
}
describe("buildGmailAuthorizeUrl", () => {
  it("requests gmail.modify offline with consent and an S256 challenge", async () => {
    const { buildGmailAuthorizeUrl } =
      await import("~/lib/google-oauth.server");
    const verifier = "a".repeat(43);
    const url = new URL(
      buildGmailAuthorizeUrl({
        state: "s1",
        verifier,
        redirectUri: "https://x/cb",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("client_id")).toBe("test-gmail-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://x/cb");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/gmail.modify openid email",
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // challenge = BASE64URL(SHA256(verifier))
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
  });
});

// --- Entry route -----------------------------------------------------------------

describe("connect-gmail entry", () => {
  it("redirects to Google authorization and parks the flow on the session", async () => {
    mockedConfigured.mockReturnValue(true);
    const res = await connectLoader(
      connectArgs(
        new Request("https://expense.test/connect-gmail?next=emails"),
      ),
    ).catch((thrown: unknown) => thrown);

    const redirect = res as Response;
    expect(redirect.status).toBe(302);
    const location = new URL(redirect.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    const cookie = redirect.headers.get("set-cookie")!;
    const session = await sessionStorage.getSession(cookie);
    const parked = session.get(GOOGLE_OAUTH_SESSION_KEY) as GoogleOAuthFlow;
    expect(parked.next).toBe("emails");
    // The URL's challenge must hash from the parked verifier (RFC 7636).
    expect(location.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(parked.verifier).digest("base64url"),
    );
  });

  it("bounces back with gmailOauthError=unconfigured when gated off", async () => {
    mockedConfigured.mockReturnValue(false);
    const res = await connectLoader(
      connectArgs(
        new Request("https://expense.test/connect-gmail?next=emails"),
      ),
    ).catch((thrown: unknown) => thrown);
    expect((res as Response).headers.get("location")).toBe(
      "/emails?gmailOauthError=unconfigured",
    );
  });
});

// --- Callback route ----------------------------------------------------------------

describe("gmail-oauth-callback", () => {
  beforeEach(() => {
    mockedExchange.mockReset();
    mockedProfile.mockReset();
    mockedProfile.mockResolvedValue("user@gmail.com");
  });

  it("rejects a state mismatch", async () => {
    const cookie = await sessionCookieWith([GOOGLE_OAUTH_SESSION_KEY, flow()]);
    const res = await callbackLoader(
      args(callbackRequest("code=c&state=WRONG", cookie)),
    );
    expect(res.headers.get("location")).toBe("/emails?gmailOauthError=state");
  });

  it("maps consent denial to gmailOauthError=denied", async () => {
    const cookie = await sessionCookieWith([GOOGLE_OAUTH_SESSION_KEY, flow()]);
    const res = await callbackLoader(
      args(callbackRequest("error=access_denied&state=flow-state", cookie)),
    );
    expect(res.headers.get("location")).toBe("/emails?gmailOauthError=denied");
  });

  it("maps an exchange failure to gmailOauthError=exchange", async () => {
    mockedExchange.mockRejectedValue(new Error("boom"));
    const cookie = await sessionCookieWith([GOOGLE_OAUTH_SESSION_KEY, flow()]);
    const res = await callbackLoader(
      args(callbackRequest("code=c&state=flow-state", cookie)),
    );
    expect(res.headers.get("location")).toBe(
      "/emails?gmailOauthError=exchange",
    );
  });

  it("maps a profile failure to gmailOauthError=verify", async () => {
    mockedExchange.mockResolvedValue(gmailTokenSet());
    mockedProfile.mockRejectedValue(new Error("profile down"));
    const cookie = await sessionCookieWith([GOOGLE_OAUTH_SESSION_KEY, flow()]);
    const res = await callbackLoader(
      args(callbackRequest("code=c&state=flow-state", cookie)),
    );
    expect(res.headers.get("location")).toBe("/emails?gmailOauthError=verify");
  });

  it("connects the mailbox for a signed-in user and redirects to /emails", async () => {
    mockedExchange.mockResolvedValue(gmailTokenSet());
    const { user } = await seedUser();
    const cookie = await sessionCookieWith(
      [GOOGLE_OAUTH_SESSION_KEY, flow()],
      [SESSION_USER_KEY, user.id],
    );
    const res = await callbackLoader(
      args(callbackRequest("code=c&state=flow-state", cookie)),
    );

    expect(res.headers.get("location")).toContain("/emails?connected=1");
    const row = await testPrisma.emailConnection.findFirstOrThrow({
      where: { provider: "gmail", emailAddress: "user@gmail.com" },
    });
    expect(decryptSecret(String(row.tokenEnc))).toBe("gmail-at");
    expect(decryptSecret(String(row.refreshTokenEnc))).toBe("gmail-rt");
    expect(row.tokenExpiresAt).not.toBeNull();
  });

  it("lands an anonymous callback on the onboarding flow via googlePending", async () => {
    mockedExchange.mockResolvedValue(gmailTokenSet());
    const cookie = await sessionCookieWith([
      GOOGLE_OAUTH_SESSION_KEY,
      flow({ next: "onboarding" }),
    ]);
    const res = await callbackLoader(
      args(callbackRequest("code=c&state=flow-state", cookie)),
    );

    expect(res.headers.get("location")).toBe("/onboarding?connected=1");
    // The parked credentials are ciphertext on the session cookie.
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("expense_session");
    expect(setCookie).not.toContain("gmail-at");
    const session = await sessionStorage.getSession(setCookie);
    const pending = session.get(GOOGLE_PENDING_SESSION_KEY) as {
      emailAddress: string;
      remoteAccountId: string;
      tokenEnc: string;
    };
    expect(pending.emailAddress).toBe("user@gmail.com");
    expect(pending.remoteAccountId).toBe("google-sub-1");
    expect(decryptSecret(pending.tokenEnc)).toBe("gmail-at");
  });
  it("lands on gmailOauthError=verify when the id_token carries no sub", async () => {
    // openid always accompanies gmail.modify, so a missing sub means
    // Google changed shape: fail closed on the verify bucket rather than
    // storing an empty remoteAccountId.
    mockedExchange.mockResolvedValue(gmailTokenSet({ idToken: null }));
    const cookie = await sessionCookieWith([
      GOOGLE_OAUTH_SESSION_KEY,
      flow({ next: "onboarding" }),
    ]);
    const res = await callbackLoader(
      args(callbackRequest("code=c&state=flow-state", cookie)),
    );
    expect(res.headers.get("location")).toBe(
      "/onboarding?gmailOauthError=verify",
    );
    const session = await sessionStorage.getSession(
      res.headers.get("set-cookie") ?? "",
    );
    expect(session.get(GOOGLE_PENDING_SESSION_KEY)).toBeUndefined();
  });
});

// --- Token resolver ------------------------------------------------------------------

describe("gmailAccessToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(overrides: Record<string, unknown> = {}) {
    let capturedBody = "";
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = init?.body;
      capturedBody = typeof body === "string" ? body : "";
      return new Response(
        JSON.stringify({
          access_token: "rotated-at",
          expires_in: 3600,
          ...overrides,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    return {
      fetchMock,
      body: () => new URLSearchParams(capturedBody),
    };
  }

  it("returns the stored token while it is still fresh", async () => {
    const id = await seedGmailConnection({
      tokenEnc: "fresh-at",
      refreshTokenEnc: "rt",
      tokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const { fetchMock } = stubFetch();
    const connection = await readEmailConnectionById(id);
    const token = await gmailAccessToken(connection!);
    expect(token).toBe("fresh-at");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired token, keeps the unrotated refresh token, and persists", async () => {
    const id = await seedGmailConnection({
      tokenEnc: "at-expired",
      refreshTokenEnc: "rt-expired",
      tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const { fetchMock, body } = stubFetch({ refresh_token: undefined });
    const connection = await readEmailConnectionById(id);
    const token = await gmailAccessToken(connection!);
    expect(token).toBe("rotated-at");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body().get("grant_type")).toBe("refresh_token");
    expect(body().get("refresh_token")).toBe("rt-expired");
    expect(body().get("client_id")).toBe("test-gmail-client-id");
    expect(body().get("client_secret")).toBe("test-gmail-client-secret");

    const row = await readEmailConnectionById(id);
    expect(decryptSecret(row!.tokenEnc)).toBe("rotated-at");
    // Google never rotates refresh tokens: an omitted refresh_token keeps
    // the stored one (null would clear it).
    expect(decryptSecret(row!.refreshTokenEnc!)).toBe("rt-expired");
    expect(Date.parse(row!.tokenExpiresAt!)).toBeGreaterThan(Date.now());
  });

  it("stores a new refresh token when Google issues one", async () => {
    const id = await seedGmailConnection({
      tokenEnc: "at-expired",
      refreshTokenEnc: "rt-old",
      tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    stubFetch({ refresh_token: "rt-new" });
    await gmailAccessToken((await readEmailConnectionById(id))!);
    const row = await readEmailConnectionById(id);
    expect(decryptSecret(row!.refreshTokenEnc!)).toBe("rt-new");
  });

  it("dedupes concurrent refreshes into one endpoint call", async () => {
    const id = await seedGmailConnection({
      tokenEnc: "at-expired",
      refreshTokenEnc: "rt",
      tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    // Resolve on the next tick so both callers queue before the first settles.
    const { fetchMock } = stubFetch();
    const connection = await readEmailConnectionById(id);
    const [a, b] = await Promise.all([
      gmailAccessToken(connection!),
      gmailAccessToken(connection!),
    ]);
    expect(a).toBe("rotated-at");
    expect(b).toBe("rotated-at");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves the stored credentials in place on refresh failure", async () => {
    const id = await seedGmailConnection({
      tokenEnc: "at-expired",
      refreshTokenEnc: "rt-expired",
      tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad refresh", { status: 400 })),
    );
    await expect(
      gmailAccessToken((await readEmailConnectionById(id))!),
    ).rejects.toThrow();
    const row = await readEmailConnectionById(id);
    expect(decryptSecret(row!.tokenEnc)).toBe("at-expired");
    expect(decryptSecret(row!.refreshTokenEnc!)).toBe("rt-expired");
  });
});
