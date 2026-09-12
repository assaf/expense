import { describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { db } from "~/lib/prisma.server";
import { registerOAuthClient } from "~/lib/db/oauth";
import {
  issueTokenPair,
  rotateRefreshToken,
  verifyAccessToken,
} from "~/lib/oauth.server";
import { hashToken } from "~/lib/passwords";
import { TEST_EMAIL } from "./helpers/seedTestData";

/**
 * Refresh rotation families, driven through the functions the token
 * endpoint calls: a replay of a rotated (or legacy) refresh token takes the
 * whole family down, so a stolen token cannot keep renewing itself while
 * the real client keeps working.
 */

async function client() {
  return registerOAuthClient({
    id: `family_${ulid()}`,
    secretHash: null,
    name: "family test",
    redirectUris: ["https://test.invalid/callback"],
    authMethod: "none",
  });
}

async function userId(): Promise<string> {
  const row = await db.orm.public.User.where((u) =>
    u.email.eq(TEST_EMAIL),
  ).first();
  return row!.id;
}

describe("refresh token families", () => {
  it("revokes the family when a token issued before families is replayed", async () => {
    const oauthClient = await client();
    const user = await userId();
    const first = await issueTokenPair(user, oauthClient.id);
    // A row written before the family column existed.
    await db.orm.public.OAuthToken.where({
      tokenHash: hashToken(first.refreshToken),
    }).updateAll({ familyId: null });

    const rotated = await rotateRefreshToken(oauthClient, first.refreshToken);
    expect(rotated).toBeDefined();
    const successor = await db.orm.public.OAuthToken.where({
      tokenHash: hashToken(rotated!.refreshToken),
    }).first();
    // The legacy row joined a family, so the pair it rotated into shares it.
    expect(successor?.familyId).toBeTruthy();

    // Replaying the legacy token now takes the successor with it.
    expect(
      await rotateRefreshToken(oauthClient, first.refreshToken),
    ).toBeUndefined();
    expect(await verifyAccessToken(rotated!.accessToken)).toBeUndefined();
    expect(
      await rotateRefreshToken(oauthClient, rotated!.refreshToken),
    ).toBeUndefined();
  });

  it("keeps a family alive across a normal rotation", async () => {
    const oauthClient = await client();
    const first = await issueTokenPair(await userId(), oauthClient.id);
    const rotated = await rotateRefreshToken(oauthClient, first.refreshToken);
    expect(rotated).toBeDefined();
    expect(await verifyAccessToken(rotated!.accessToken)).toMatchObject({
      clientId: oauthClient.id,
    });
  });
});
