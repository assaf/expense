import { describe, expect, it, vi, afterAll } from "vitest";
import type { JmapTokenInfo } from "~/lib/jmap.server";

/**
 * Token-crypto + JMAP token verification. EMAIL_TOKEN_ENCRYPTION_KEY is set before the
 * module graph loads (env.ts snapshots it at import time), so the module is
 * imported dynamically after vi.resetModules().
 */

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

async function loadCrypto() {
  vi.resetModules();
  process.env.EMAIL_TOKEN_ENCRYPTION_KEY = TEST_KEY;
  return import("~/lib/token-crypto.server");
}

describe("token crypto", () => {
  it("round-trips a secret", async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();
    expect(decryptSecret(encryptSecret("fmu1-test-token"))).toBe(
      "fmu1-test-token",
    );
  });

  it("produces a fresh ciphertext per call (random IV)", async () => {
    const { encryptSecret } = await loadCrypto();
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("never stores the plaintext", async () => {
    const { encryptSecret } = await loadCrypto();
    const packed = encryptSecret("fmu1-plaintext-secret");
    expect(packed).not.toContain("fmu1-plaintext-secret");
  });

  it("rejects tampered ciphertext (GCM tag)", async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();
    const packed = encryptSecret("fmu1-test-token");
    const [iv, tag, ct] = packed.split(".");
    const flipped = Buffer.from(ct!, "base64");
    flipped[0]! ^= 0xff;
    expect(() =>
      decryptSecret([iv, tag, flipped.toString("base64")].join(".")),
    ).toThrow();
  });

  it("reports unconfigured when EMAIL_TOKEN_ENCRYPTION_KEY is unset", async () => {
    vi.resetModules();
    delete process.env.EMAIL_TOKEN_ENCRYPTION_KEY;
    const { isTokenCryptoConfigured } =
      await import("~/lib/token-crypto.server");
    expect(isTokenCryptoConfigured()).toBe(false);
  });

  it("throws on a wrong-length key instead of encrypting weakly", async () => {
    vi.resetModules();
    process.env.EMAIL_TOKEN_ENCRYPTION_KEY =
      Buffer.alloc(16).toString("base64");
    const { encryptSecret } = await import("~/lib/token-crypto.server");
    expect(() => encryptSecret("x")).toThrow(/EMAIL_TOKEN_ENCRYPTION_KEY/);
  });
});

describe("verifyJmapToken", () => {
  const SESSION = {
    apiUrl: "https://api.fastmail.com/jmap/",
    uploadUrl: "https://www.fastmail.com/upload/",
    downloadUrl: "https://www.fastmail.com/download/",
    username: "You@Example.com",
    primaryAccounts: { "urn:ietf:params:jmap:mail": "mail-acct-1" },
  };

  function okSession(): Response {
    return new Response(JSON.stringify(SESSION), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  async function loadJmap() {
    vi.resetModules();
    return import("~/lib/jmap.server");
  }

  it("resolves username (lowercased) and the mail account id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okSession()),
    );
    const { verifyJmapToken } = await loadJmap();
    const result = await verifyJmapToken("fmu1-good");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info.username).toBe("you@example.com");
      expect(result.info.mailAccountId).toBe("mail-acct-1");
      expect(result.info.apiUrl).toBe(SESSION.apiUrl);
    }
    vi.unstubAllGlobals();
  });

  it("reports invalid-token on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 401 })),
    );
    const { verifyJmapToken } = await loadJmap();
    const result = await verifyJmapToken("fmu1-bad");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-token");
    vi.unstubAllGlobals();
  });

  it("reports no-mail-account when the token has no mail scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ...SESSION, primaryAccounts: {} }), {
            status: 200,
          }),
      ),
    );
    const { verifyJmapToken } = await loadJmap();
    const result = await verifyJmapToken("fmu1-nomail");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-mail-account");
    vi.unstubAllGlobals();
  });

  it("reports network when FastMail is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Blocked live network call in tests");
      }),
    );
    const { verifyJmapToken } = await loadJmap();
    const result = await verifyJmapToken("fmu1-any");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("network");
    vi.unstubAllGlobals();
  });

  it("sends the token as a bearer header", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => okSession());
    vi.stubGlobal("fetch", fetchMock);
    const { verifyJmapToken } = await loadJmap();
    await verifyJmapToken("fmu1-header");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: "Bearer fmu1-header" });
    vi.unstubAllGlobals();
  });

  it("JmapTokenInfo stays a flat, serializable shape", async () => {
    const info: JmapTokenInfo = {
      username: "a@b.c",
      mailAccountId: "m1",
      apiUrl: "u",
      uploadUrl: "u",
      downloadUrl: "u",
    };
    expect(JSON.parse(JSON.stringify(info))).toEqual(info);
  });
});

afterAll(() => {
  delete process.env.EMAIL_TOKEN_ENCRYPTION_KEY;
});
