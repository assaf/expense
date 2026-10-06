import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ulid } from "ulid";
import { createAccount } from "~/lib/db/accounts";
import {
  createEmailConnection,
  readEmailConnectionById,
  updateEmailConnectionTokens,
  type EmailConnectionWithSecret,
} from "~/lib/db/email-connections";
import {
  isOAuthRefreshError,
  requestTokenSet,
  resolveConnectionAccessToken,
} from "~/lib/oauth-token-refresh.server";
import { encryptSecret } from "~/lib/token-crypto.server";

/**
 * The credential resolver's staleness rule: an exchange must spend the row's
 * current refresh token, never the caller's copy of it. A cron tick resolves
 * one connection twice (the push renewal, then the catch-up drain) from a
 * single row read at the top, and Fastmail revokes each refresh token as it
 * hands out the next, so replaying the first resolution's pair is what turned
 * a healthy connection into a daily "drain failed" warning (EXPENSE-13).
 */

const expired = () => new Date(Date.now() - 60_000).toISOString();
const live = () => new Date(Date.now() + 3_600_000).toISOString();

/** A Fastmail connection whose access token expired an hour ago. */
async function seed(): Promise<EmailConnectionWithSecret> {
  const account = await createAccount(`Refresh ${ulid()}`);
  const created = await createEmailConnection({
    accountId: account.id,
    provider: "fastmail",
    emailAddress: `refresh.${ulid().toLowerCase()}@example.com`,
    remoteAccountId: "remote-1",
    tokenEnc: encryptSecret("access-1"),
    refreshTokenEnc: encryptSecret("refresh-1"),
    tokenExpiresAt: expired(),
  });
  if (!created.ok) throw new Error(created.error);
  const row = await readEmailConnectionById(created.connection.id);
  if (!row) throw new Error("connection vanished");
  return row;
}

describe("resolveConnectionAccessToken", () => {
  it("reuses the pair the first resolution rotated instead of replaying the caller's copy", async () => {
    const row = await seed();
    const spent: string[] = [];
    const refresh = async (refreshToken: string) => {
      spent.push(refreshToken);
      return { accessToken: "access-2", expiresAt: live() };
    };
    const persistRefreshToken = (_refreshed: {
      accessToken: string;
      expiresAt: string;
    }) => "refresh-2";

    // The renewal: an expired row, so one exchange.
    const first = await resolveConnectionAccessToken({
      connection: row,
      refresh,
      persistRefreshToken,
    });
    expect(first).toBe("access-2");
    expect(spent).toEqual(["refresh-1"]);

    // The drain, later in the same tick, from the row as it was read at the
    // top: the exchange above already rotated the credentials, so there is
    // nothing left to spend and the fresh token is the answer.
    const second = await resolveConnectionAccessToken({
      connection: row,
      refresh,
      persistRefreshToken,
    });
    expect(second).toBe("access-2");
    expect(spent).toEqual(["refresh-1"]);
  });

  it("spends the row's refresh token when it rotated under the caller", async () => {
    const row = await seed();
    // Another lambda refreshed and rotated the pair; its access token has
    // since expired again, so an exchange is still needed.
    await updateEmailConnectionTokens({
      id: row.id,
      tokenEnc: encryptSecret("access-9"),
      refreshTokenEnc: encryptSecret("refresh-9"),
      tokenExpiresAt: expired(),
    });
    const spent: string[] = [];
    const refresh = async (refreshToken: string) => {
      spent.push(refreshToken);
      return { accessToken: "access-10", expiresAt: live() };
    };

    const token = await resolveConnectionAccessToken({
      connection: row,
      refresh,
      persistRefreshToken: () => "refresh-10",
    });
    expect(spent).toEqual(["refresh-9"]);
    expect(token).toBe("access-10");
  });

  it("collapses concurrent resolutions into one exchange", async () => {
    const row = await seed();
    let exchanges = 0;
    const refresh = async () => {
      exchanges += 1;
      return { accessToken: "access-2", expiresAt: live() };
    };
    const resolve = () =>
      resolveConnectionAccessToken({
        connection: row,
        refresh,
        persistRefreshToken: () => "refresh-2",
      });

    expect(await Promise.all([resolve(), resolve()])).toEqual([
      "access-2",
      "access-2",
    ]);
    expect(exchanges).toBe(1);
  });
});

describe("requestTokenSet", () => {
  const url = "https://auth.example.com/token";

  const stub = (body: string, status: number) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status })),
    );
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a credential the provider echoed out of the error message", async () => {
    // The endpoint error is quoted into a message that reaches stdout, Sentry
    // and a reconnect email. A provider that answers with the token it was
    // sent would otherwise print that token three times over.
    stub(
      '{"error":"invalid_grant","echo":"refresh_token=rMrT-abc123XYZ"}',
      400,
    );
    const error = await requestTokenSet(url, {}, "Fastmail").catch(
      (e: unknown) => e,
    );
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("Fastmail token endpoint returned HTTP 400");
    expect(message).toContain("[redacted]");
    expect(message).not.toContain("rMrT-abc123XYZ");
  });

  it("still classifies a rejected grant so the notice path can mail it", async () => {
    stub('{"error":"invalid_grant"}', 400);
    const error = await requestTokenSet(url, {}, "Fastmail").catch(
      (e: unknown) => e,
    );
    expect(isOAuthRefreshError(error)).toBe(true);
  });

  it("does not classify a transient failure", async () => {
    stub("upstream unavailable", 503);
    const error = await requestTokenSet(url, {}, "Fastmail").catch(
      (e: unknown) => e,
    );
    expect(isOAuthRefreshError(error)).toBe(false);
  });
});
