import { describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { hashToken } from "~/lib/passwords";
import {
  deleteUnverifiedUser,
  resendUserVerification,
  setUserVerificationToken,
  verifyUserEmailAddress,
} from "~/lib/db/accounts";
import { testPrisma } from "./helpers/seedTestData";

const now = new Date().toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;

/** Create a throwaway account with a single (optionally verified) user.
 * Callers clean up by deleting the returned account id. */
async function makeSoleUserAccount(
  email: string,
  opts: { verified?: boolean } = {},
): Promise<{ accountId: string; userId: string }> {
  const accountId = `uvacct_${ulid()}`;
  const userId = `uvuser_${ulid()}`;
  await testPrisma.account.create({
    data: {
      id: accountId,
      name: `UV Account ${ulid()}`,
      inviteCode: `UV${ulid()}`.toUpperCase(),
      createdAt: now,
    },
  });
  await testPrisma.user.create({
    data: {
      id: userId,
      accountId,
      email,
      passwordHash: "unused",
      emailVerifiedAt: opts.verified ? now : null,
      createdAt: now,
    },
  });
  return { accountId, userId };
}

async function cleanup(accountIds: string[]): Promise<void> {
  await testPrisma.account.deleteMany({ where: { id: { in: accountIds } } });
}

describe("user email verification (store)", () => {
  it("verifies an unverified user and reports already-verified on a second click", async () => {
    const { accountId, userId } =
      await makeSoleUserAccount("verify@example.com");
    try {
      await setUserVerificationToken(userId, "tok-1");
      await expect(verifyUserEmailAddress("tok-1")).resolves.toMatchObject({
        status: "verified",
        email: "verify@example.com",
      });
      const row = await testPrisma.user.findUnique({
        where: { id: userId },
        select: { emailVerifiedAt: true },
      });
      expect(row?.emailVerifiedAt).not.toBeNull();
      // The token hash is kept, so a second click on the same link reports
      // "already-verified" rather than "invalid".
      await expect(verifyUserEmailAddress("tok-1")).resolves.toMatchObject({
        status: "already-verified",
      });
      // A token that matches nothing is invalid.
      await expect(verifyUserEmailAddress("nope")).resolves.toEqual({
        status: "invalid",
      });
    } finally {
      await cleanup([accountId]);
    }
  });

  it("rejects an expired verification link", async () => {
    const { accountId, userId } = await makeSoleUserAccount(
      "expired@example.com",
    );
    try {
      await testPrisma.user.update({
        where: { id: userId },
        data: {
          verificationTokenHash: hashToken("stale-tok"),
          // 8 days ago, past the 7-day TTL.
          verificationSentAt: new Date(Date.now() - 8 * DAY_MS).toISOString(),
        },
      });
      const outcome = await verifyUserEmailAddress("stale-tok");
      expect(outcome.status).toBe("expired");
      const row = await testPrisma.user.findUnique({
        where: { id: userId },
        select: { emailVerifiedAt: true },
      });
      expect(row?.emailVerifiedAt).toBeNull();
    } finally {
      await cleanup([accountId]);
    }
  });

  it("deletes an unverified user's throwaway account on re-signup, but never a verified one", async () => {
    const unverified = await makeSoleUserAccount("replace@example.com");
    const verified = await makeSoleUserAccount("keep@example.com", {
      verified: true,
    });
    try {
      await expect(
        deleteUnverifiedUser("replace@example.com"),
      ).resolves.toEqual({ status: "replaced" });
      // The throwaway account is gone; the old verification link can no
      // longer match anything.
      await expect(
        testPrisma.account.findUnique({ where: { id: unverified.accountId } }),
      ).resolves.toBeNull();
      await expect(verifyUserEmailAddress("any-token")).resolves.toEqual({
        status: "invalid",
      });
      // A verified email can never be replaced by a re-signup.
      await expect(deleteUnverifiedUser("keep@example.com")).resolves.toEqual({
        status: "verified",
      });
      await expect(
        testPrisma.user.findUnique({ where: { email: "keep@example.com" } }),
      ).resolves.not.toBeNull();
    } finally {
      await cleanup([unverified.accountId, verified.accountId]);
    }
  });

  it("rate-limits verification resends to once a day", async () => {
    const { accountId, userId } =
      await makeSoleUserAccount("resend@example.com");
    try {
      await setUserVerificationToken(userId, "first-tok");
      // A resend right after the first email is refused.
      const soon = await resendUserVerification(userId);
      if ("token" in soon) throw new Error("expected a rate-limit refusal");
      expect(soon.status).toBe("rate-limited");
      // After backdating the sent-at past 24h, a resend mints a fresh token
      // that verifies.
      await testPrisma.user.update({
        where: { id: userId },
        data: {
          verificationSentAt: new Date(
            Date.now() - 25 * 60 * 60 * 1000,
          ).toISOString(),
        },
      });
      const fresh = await resendUserVerification(userId);
      if (!("token" in fresh)) throw new Error("expected a fresh token");
      await expect(verifyUserEmailAddress(fresh.token)).resolves.toMatchObject({
        status: "verified",
      });
    } finally {
      await cleanup([accountId]);
    }
  });
});
