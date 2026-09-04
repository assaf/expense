import { createSign, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/email-connections-gmail-push: the Pub/Sub push webhook. A signed
 * RS256 JWT against Google's JWKS IS the auth; the body carries the
 * mailbox address. The drain itself is mocked (the pipeline has its own
 * tests); these tests pin the auth gates, the retry contract (unknown or
 * non-Gmail mailboxes answer 200 so Pub/Sub never retries them), and the
 * error-flag semantics.
 */

const mocks = vi.hoisted(() => ({
  findEmailConnectionByAddress: vi.fn(),
  readEmailConnectionByAddressSecret: vi.fn(),
  touchEmailConnectionPush: vi.fn(async () => {}),
  setEmailConnectionStatus: vi.fn(async () => {}),
}));

vi.mock("~/lib/db/email-connections", () => ({
  findEmailConnectionByAddress: mocks.findEmailConnectionByAddress,
  readEmailConnectionByAddressSecret: mocks.readEmailConnectionByAddressSecret,
  touchEmailConnectionPush: mocks.touchEmailConnectionPush,
  setEmailConnectionStatus: mocks.setEmailConnectionStatus,
}));

const drainMock = vi.hoisted(() => ({ drainEmailConnection: vi.fn() }));
vi.mock("~/lib/email-connection-process.server", () => ({
  drainEmailConnection: drainMock.drainEmailConnection,
}));

import { action } from "~/routes/api.email-connections-gmail-push";

// Throwaway RS256 pair; the mocked JWKS endpoint serves the public half.
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const publicJwk = publicKey.export({ format: "jwk" }) as Record<
  string,
  unknown
>;
const KID = "test-kid";

vi.stubGlobal(
  "fetch",
  vi.fn(
    async () =>
      new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: KID }] }), {
        status: 200,
      }),
  ),
);

const AUDIENCE =
  "https://expense.labnotes.org/api/email-connections-gmail-push";

function signJwt(claims: Record<string, unknown>): string {
  const header = b64url({ alg: "RS256", kid: KID });
  const payload = b64url(claims);
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(privateKey))}`;
}

function validClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: "accounts.google.com",
    aud: AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 600,
    email: "pubsub-push@test-project.iam.gserviceaccount.com",
    ...overrides,
  };
}

function envelope(emailAddress: string): string {
  return JSON.stringify({
    message: {
      data: b64url(Buffer.from(JSON.stringify({ emailAddress, historyId: 7 }))),
    },
  });
}

function b64url(input: object | Buffer | string): string {
  const value =
    input instanceof Buffer || typeof input === "string"
      ? input
      : JSON.stringify(input);
  return Buffer.from(value).toString("base64url");
}
function request(
  body: string,
  token = signJwt(validClaims()),
  method = "POST",
): Request {
  return new Request("https://x.test/api/email-connections-gmail-push", {
    method,
    headers: { Authorization: `Bearer ${token}` },
    ...(method === "POST" ? { body } : {}),
  });
}

function args(req: Request): Parameters<typeof action>[0] {
  return { request: req } as Parameters<typeof action>[0];
}

const gmailConnection = {
  id: "conn-1",
  provider: "gmail",
  emailAddress: "user@gmail.com",
  status: "active",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findEmailConnectionByAddress.mockResolvedValue({
    accountId: "acc-1",
  });
  mocks.readEmailConnectionByAddressSecret.mockResolvedValue(gmailConnection);
  drainMock.drainEmailConnection.mockResolvedValue({
    evaluated: 1,
    created: 1,
  });
});

describe("api.email-connections-gmail-push", () => {
  it("drains a valid push for a known gmail connection", async () => {
    const res = await action(args(request(envelope("user@gmail.com"))));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, drained: true });
    expect(mocks.touchEmailConnectionPush).toHaveBeenCalledWith("conn-1");
    expect(drainMock.drainEmailConnection).toHaveBeenCalledWith(
      gmailConnection,
    );
  });

  it("accepts the https issuer variant", async () => {
    const res = await action(
      args(
        request(
          envelope("user@gmail.com"),
          signJwt(validClaims({ iss: "https://accounts.google.com" })),
        ),
      ),
    );
    expect(res.status).toBe(200);
  });

  it("rejects a bad signature with 401", async () => {
    const parts = signJwt(validClaims()).split(".");
    const forged = `${parts[0]}.${parts[1]}.${b64url(Buffer.from("junk"))}`;
    const res = await action(args(request(envelope("user@gmail.com"), forged)));
    expect(res.status).toBe(401);
    expect(drainMock.drainEmailConnection).not.toHaveBeenCalled();
  });

  it("rejects a wrong audience with 401", async () => {
    const res = await action(
      args(
        request(
          envelope("user@gmail.com"),
          signJwt(validClaims({ aud: "https://evil.test/push" })),
        ),
      ),
    );
    expect(res.status).toBe(401);
  });

  it("rejects an expired token with 401", async () => {
    const res = await action(
      args(
        request(
          envelope("user@gmail.com"),
          signJwt(validClaims({ exp: Math.floor(Date.now() / 1000) - 10 })),
        ),
      ),
    );
    expect(res.status).toBe(401);
  });

  it("answers 200 undrained for an unknown mailbox", async () => {
    mocks.findEmailConnectionByAddress.mockResolvedValue(undefined);
    const res = await action(args(request(envelope("stranger@gmail.com"))));
    await expect(res.json()).resolves.toEqual({ ok: true, drained: false });
    expect(drainMock.drainEmailConnection).not.toHaveBeenCalled();
  });

  it("answers 200 undrained for a fastmail-provider address", async () => {
    mocks.readEmailConnectionByAddressSecret.mockResolvedValue({
      ...gmailConnection,
      provider: "fastmail",
    });
    const res = await action(args(request(envelope("user@gmail.com"))));
    await expect(res.json()).resolves.toEqual({ ok: true, drained: false });
    expect(drainMock.drainEmailConnection).not.toHaveBeenCalled();
  });

  it("rejects a malformed body with 400", async () => {
    const res = await action(args(request("not-json")));
    expect(res.status).toBe(400);
  });

  it("flags the connection error on drain failure but still answers 200", async () => {
    drainMock.drainEmailConnection.mockRejectedValue(new Error("token dead"));
    const res = await action(args(request(envelope("user@gmail.com"))));
    expect(res.status).toBe(200);
    expect(mocks.setEmailConnectionStatus).toHaveBeenCalledWith(
      "conn-1",
      "error",
    );
  });

  it("rejects non-POST with 405", async () => {
    const res = await action(
      args(
        new Request("https://x.test/api/email-connections-gmail-push", {
          method: "GET",
          headers: { Authorization: `Bearer ${signJwt(validClaims())}` },
        }),
      ),
    );
    expect(res.status).toBe(405);
  });

  it("refetches the JWKS once on an unknown kid (Google key rotation)", async () => {
    // Fresh module = cold JWKS cache, modeling the pre-rotation state:
    // the first lookup misses the rotated kid and forces exactly ONE
    // refetch, which must serve the new key and verify the token.
    vi.resetModules();
    const { publicKey: newKey, privateKey: newPriv } = generateKeyPairSync(
      "rsa",
      { modulusLength: 2048 },
    );
    const newJwk = newKey.export({ format: "jwk" }) as Record<string, unknown>;
    const NEW_KID = "rotated-kid";
    let fetchCalls = 0;
    const { action: freshAction } =
      await import("~/routes/api.email-connections-gmail-push");
    // env.ts installs its test network guard over global fetch at import;
    // the stub must be (re)installed AFTER the fresh module graph loads.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCalls++;
        const keys =
          fetchCalls === 1
            ? [{ ...publicJwk, kid: KID }]
            : [
                { ...publicJwk, kid: KID },
                { ...newJwk, kid: NEW_KID },
              ];
        return new Response(JSON.stringify({ keys }), { status: 200 });
      }),
    );

    const header = b64url({ alg: "RS256", kid: NEW_KID });
    const payload = b64url(validClaims());
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    const rotated = `${header}.${payload}.${b64url(signer.sign(newPriv))}`;
    const res = await freshAction(
      args(request(envelope("user@gmail.com"), rotated)),
    );
    expect(res.status).toBe(200);
    // Cold-cache lookup + exactly one forced refetch.
    expect(fetchCalls).toBe(2);
  });

  it("rejects tokens from a foreign service account (SA pin)", async () => {
    // Any GCP project can aim a push subscription at this URL; Google
    // signs those tokens with the same iss/aud shape. The email claim is
    // the only thing binding a push to OUR subscription.
    const res = await action(
      args(
        request(
          envelope("user@gmail.com"),
          signJwt(
            validClaims({
              email: "attacker@evil-project.iam.gserviceaccount.com",
            }),
          ),
        ),
      ),
    );
    expect(res.status).toBe(401);
    expect(drainMock.drainEmailConnection).not.toHaveBeenCalled();
  });

  it("503s when the push service account is not configured", async () => {
    vi.resetModules();
    vi.stubEnv("GOOGLE_PUSH_SERVICE_ACCOUNT", "");
    try {
      const { action: unconfigured } =
        await import("~/routes/api.email-connections-gmail-push");
      const res = await unconfigured(args(request(envelope("user@gmail.com"))));
      expect(res.status).toBe(503);
      expect(drainMock.drainEmailConnection).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("answers 503 (retryable) when the JWKS endpoint fails", async () => {
    // A Google-side outage is infrastructure, not auth: the route must
    // return a retryable 503, not throw an unhandled exception per push.
    vi.resetModules();
    const jwks = vi.fn(async () => new Response("boom", { status: 500 }));
    const { action: freshAction } =
      await import("~/routes/api.email-connections-gmail-push");
    vi.stubGlobal("fetch", jwks);
    const res = await freshAction(args(request(envelope("user@gmail.com"))));
    expect(res.status).toBe(503);
    expect(drainMock.drainEmailConnection).not.toHaveBeenCalled();
  });

  it("floors repeated unknown-kid refetches (junk flood)", async () => {
    // The cache is warm (KID, from the earlier tests). Each junk-kid
    // request may force at most one refetch within the 30s floor: the
    // SECOND unknown kid must 401 without any further fetch.
    const jwks = vi.fn(async () => {
      // The forced refetch still only knows the pre-rotation key: an
      // unknown kid stays unknown (401), it just must not re-fetch.
      return new Response(
        JSON.stringify({ keys: [{ ...publicJwk, kid: KID }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", jwks);
    const junkKid = (kid: string) => {
      const header = b64url({ alg: "RS256", kid });
      const payload = b64url(validClaims());
      // Signature is garbage — the kid miss short-circuits before verify.
      return `${header}.${payload}.AAAA`;
    };
    const first = await action(
      args(request(envelope("user@gmail.com"), junkKid("flood-1"))),
    );
    expect(first.status).toBe(401);
    const callsAfterFirst = jwks.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    const second = await action(
      args(request(envelope("user@gmail.com"), junkKid("flood-2"))),
    );
    expect(second.status).toBe(401);
    expect(jwks.mock.calls.length).toBe(callsAfterFirst);
  });
});
