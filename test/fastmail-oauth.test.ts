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
import type { Route as ConnectRoute } from "+types/app/routes/+types/connect-fastmail";
import type { Route as OnboardingRoute } from "+types/app/routes/+types/onboarding";
import { action } from "~/routes/onboarding";
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  FM_OAUTH_SESSION_KEY,
  FM_PENDING_SESSION_KEY,
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
 * Fastmail OAuth: pure-crypto units (PKCE, authorize URL), the connection
 * token resolver (legacy passthrough, fresh skip, refresh rotation +
 * failure, concurrent dedup), the callback route (state check, consent
 * denial, signed-in and anonymous paths), the env-gated entry route, and
 * the onboarding flow's fmPending branch. True end-to-end consent needs a
 * registered Fastmail client id.
 */

vi.mock("~/lib/jmap.server", () => ({
  verifyJmapToken: vi.fn(),
}));

vi.mock("~/lib/fastmail-oauth.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/lib/fastmail-oauth.server")>();
  return {
    ...actual,
    exchangeAuthorizationCode: vi.fn(),
    // Per-test overrides for the env-gated entry route (the client id
    // const is baked in at env import; the accessors read it at call time).
    isFastmailOAuthConfigured: vi.fn(actual.isFastmailOAuthConfigured),
    fastmailOAuthClientId: vi.fn(actual.fastmailOAuthClientId),
  };
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

// The entry loader only reads the request.
function entryArgs(request: Request): ConnectRoute.LoaderArgs {
  return { request } as ConnectRoute.LoaderArgs;
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

function okConnection(
  created: Awaited<ReturnType<typeof createEmailConnection>>,
) {
  if (!created.ok) throw new Error(created.error);
  return created.connection;
}

function seedExpiredConnection(prefix: string) {
  return (async () => {
    const account = await createAccount(`${prefix} ${ulid()}`);
    return okConnection(
      await createEmailConnection({
        accountId: account.id,
        provider: "fastmail",
        emailAddress: `${prefix.toLowerCase()}.${ulid()}@example.com`,
        remoteAccountId: "jmap-1",
        tokenEnc: encryptSecret("at-expired"),
        refreshTokenEnc: encryptSecret("rt-expired"),
        tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ).id;
  })();
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

describe("isFastmailOAuthConfigured", () => {
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
    expect(off.isFastmailOAuthConfigured()).toBe(false);

    vi.stubEnv("FASTMAIL_OAUTH_CLIENT_ID", "test-client-id");
    vi.resetModules();
    const on = await vi.importActual<
      typeof import("~/lib/fastmail-oauth.server")
    >("~/lib/fastmail-oauth.server");
    expect(on.isFastmailOAuthConfigured()).toBe(true);
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
    const id = await seedExpiredConnection("Refresh");

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

  it("propagates refresh failure and leaves stored credentials untouched", async () => {
    const id = await seedExpiredConnection("Fail");
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const stored = await readEmailConnectionById(id);
    expect(stored).toBeDefined();
    await expect(connectionAccessToken(stored!)).rejects.toThrow(/HTTP 400/);
    // Evicted from the in-flight cache on failure: a retry re-attempts.
    await expect(connectionAccessToken(stored!)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const row = await readEmailConnectionById(id);
    expect(decryptSecret(row!.tokenEnc)).toBe("at-expired");
    expect(decryptSecret(row!.refreshTokenEnc!)).toBe("rt-expired");
  });

  it("dedupes concurrent refreshes into one endpoint call", async () => {
    const id = await seedExpiredConnection("Dedup");
    let release!: (res: Response) => void;
    const fetchMock = vi.fn(
      (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const stored = await readEmailConnectionById(id);
    expect(stored).toBeDefined();
    const both = Promise.all([
      connectionAccessToken(stored!),
      connectionAccessToken(stored!),
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    release(
      Response.json({
        access_token: "at-rotated",
        refresh_token: "rt-rotated",
        token_type: "bearer",
        expires_in: 3600,
      }),
    );
    expect(await both).toEqual(["at-rotated", "at-rotated"]);
  });
  it("rejects a malformed 200 token response loudly, storing nothing", async () => {
    const id = await seedExpiredConnection("Malformed");
    const fetchMock = vi.fn(async () =>
      Response.json({ token_type: "bearer" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const stored = await readEmailConnectionById(id);
    expect(stored).toBeDefined();
    await expect(connectionAccessToken(stored!)).rejects.toThrow(
      /unexpected shape/,
    );

    const row = await readEmailConnectionById(id);
    expect(decryptSecret(row!.tokenEnc)).toBe("at-expired");
    expect(decryptSecret(row!.refreshTokenEnc!)).toBe("rt-expired");
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
    expect(connection.remoteAccountId).toBe("jmap-9");
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
        remoteAccountId: "jmap-1",
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

describe("connect-fastmail entry", () => {
  it("redirects to Fastmail authorization and parks the flow on the session", async () => {
    const oauthMod = await import("~/lib/fastmail-oauth.server");
    vi.mocked(oauthMod.isFastmailOAuthConfigured).mockReturnValue(true);
    vi.mocked(oauthMod.fastmailOAuthClientId).mockReturnValue("test-client-id");
    const { loader } = await import("~/routes/connect-fastmail");
    // connect-fastmail throws the redirect; catch the thrown Response.
    const res = (await loader(
      entryArgs(
        new Request("https://expense.test/connect-fastmail?next=emails"),
      ),
    ).catch((thrown: unknown) => thrown)) as Response;

    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location")!);
    expect(url.origin + url.pathname).toBe(
      "https://api.fastmail.com/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://expense.test/fastmail-oauth-callback",
    );
    expect(url.searchParams.get("scope")).toBe(
      "urn:ietf:params:jmap:core urn:ietf:params:jmap:mail",
    );

    // The parked flow must carry the exact state sent to Fastmail and a
    // verifier matching the challenge in the URL.
    const cookie = res.headers.get("set-cookie")!;
    const session = await sessionStorage.getSession(cookie);
    const parked = session.get(FM_OAUTH_SESSION_KEY) as FmOAuthFlow;
    expect(parked.state).toBe(url.searchParams.get("state"));
    expect(parked.next).toBe("emails");
    expect(parked.verifier.length).toBeGreaterThanOrEqual(43);
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(parked.verifier).digest("base64url"),
    );
  });

  it("caps entry minting at the shared per-IP anonymous budget", async () => {
    // The guard skips empty-IP requests (every other test here), so this
    // pins the throttle actually engaging on the new route: 5 attempts
    // (AUTH_THRESHOLD) pass, the 6th trips guardLockout.
    const oauthMod = await import("~/lib/fastmail-oauth.server");
    vi.mocked(oauthMod.isFastmailOAuthConfigured).mockReturnValue(true);
    vi.mocked(oauthMod.fastmailOAuthClientId).mockReturnValue("test-client-id");
    const { loader } = await import("~/routes/connect-fastmail");
    const ip = "198.51.100.42";
    const entry = () =>
      loader(
        entryArgs(
          new Request("https://expense.test/connect-fastmail", {
            headers: { "x-forwarded-for": ip },
          }),
        ),
      ).catch((thrown: unknown) => thrown);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = (await entry()) as Response;
      expect(res.status).toBe(302);
    }
    // The entryArgs convention catches the thrown value: the tripped
    // guard surfaces as a TooManyAttemptsError, not a redirect Response.
    const sixth = (await entry()) as unknown;
    expect(sixth).toBeInstanceOf(Error);
    expect(sixth).not.toBeInstanceOf(Response);
    expect((sixth as Error).message).toMatch(/Too many failed attempts/);
  });
});

describe("onboarding via fmPending", () => {
  function pendingFor(username: string) {
    return {
      username,
      mailAccountId: "jmap-pending",
      tokenEnc: encryptSecret("oauth-at"),
      refreshTokenEnc: encryptSecret("oauth-rt"),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
  }

  function onboardForm(
    intent: string,
    email: string,
    cookie?: string,
  ): Request {
    const form = new FormData();
    form.set("intent", intent);
    form.set("email", email);
    form.set("password", PASSWORD);
    return new Request("https://expense.test/onboarding", {
      method: "POST",
      body: form,
      headers: cookie ? { cookie } : {},
    });
  }

  it("creates a verified account from the parked OAuth credentials", async () => {
    const address = `pending.${ulid().toLowerCase()}@example.com`;
    const cookie = await sessionCookieWith([
      FM_PENDING_SESSION_KEY,
      pendingFor(address),
    ]);
    // The action returns the redirect Response directly.
    const res = (await action({
      request: onboardForm("create", address, cookie),
    } as OnboardingRoute.ActionArgs)) as Response;

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(
      "/email-review?onboarding=1&connection=",
    );
    const user = await testPrisma.user.findUnique({
      where: { email: address },
    });
    expect(user?.emailVerifiedAt).not.toBeNull();
    const connection = await testPrisma.emailConnection.findUniqueOrThrow({
      where: { emailAddress: address },
    });
    expect(decryptSecret(String(connection.tokenEnc))).toBe("oauth-at");
    expect(decryptSecret(String(connection.refreshTokenEnc))).toBe("oauth-rt");
    expect(connection.tokenExpiresAt).not.toBeNull();
  });

  it("attaches the parked mailbox to the existing account on attach", async () => {
    const address = `attachp.${ulid().toLowerCase()}@example.com`;
    const account = await createAccount(`AttachP ${ulid()}`);
    await createUser({
      accountId: account.id,
      email: address,
      passwordHash: await hashPassword(PASSWORD),
      emailVerifiedAt: new Date().toISOString(),
    });
    const cookie = await sessionCookieWith([
      FM_PENDING_SESSION_KEY,
      pendingFor(address),
    ]);
    const res = (await action({
      request: onboardForm("attach", address, cookie),
    } as OnboardingRoute.ActionArgs)) as Response;

    expect(res.status).toBe(302);
    const connection = await testPrisma.emailConnection.findUniqueOrThrow({
      where: { emailAddress: address },
    });
    expect(connection.accountId).toBe(account.id);
  });

  it("errors without a form token and without parked credentials", async () => {
    // data() results arrive as { data, init } on a direct action call.
    const res = (await action({
      request: onboardForm("create", "orphan@example.com"),
    } as OnboardingRoute.ActionArgs)) as { data?: { error?: string } };
    expect(res.data?.error).toContain("expired");
  });

  it("oauth-restart clears the parked credentials", async () => {
    const address = `restart.${ulid().toLowerCase()}@example.com`;
    const cookie = await sessionCookieWith([
      FM_PENDING_SESSION_KEY,
      pendingFor(address),
    ]);
    const form = new FormData();
    form.set("intent", "oauth-restart");
    const request = new Request("https://expense.test/onboarding", {
      method: "POST",
      body: form,
      headers: { cookie },
    });
    // The restart branch throws its redirect.
    const res = (await action({ request } as OnboardingRoute.ActionArgs).catch(
      (thrown: unknown) => thrown,
    )) as Response;

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/onboarding");
    const cleared = await sessionStorage.getSession(
      res.headers.get("set-cookie") ?? "",
    );
    expect(cleared.get(FM_PENDING_SESSION_KEY)).toBeUndefined();
  });
});
