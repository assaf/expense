import { describe, expect, it, afterEach } from "vitest";
import { generateOpaqueToken, hashToken } from "~/lib/passwords";
import {
  addInboundSender,
  ensureInboundSenderForUser,
  findPendingSenderRow,
  findVerifiedSenderAccount,
  removeInboundSender,
  resendInboundSenderVerification,
  verifyInboundSenderAddress,
} from "~/lib/db/inbound";
import {
  OTHER_ACCOUNT_ID,
  TEST_ACCOUNT_ID,
  testPrisma,
} from "./helpers/seedTestData";

/**
 * Sender-address verification + exclusivity (receipts by email). An address
 * is added "pending", only accepts receipts once its mailbox owner clicks
 * the emailed link (single-use token, 7-day expiry), and verifying claims
 * the address exclusively; no other account can use it afterwards.
 */

const usedSenders: { accountId: string; address: string }[] = [];

async function track(accountId: string, address: string): Promise<void> {
  usedSenders.push({ accountId, address });
}

afterEach(async () => {
  for (const s of usedSenders) {
    await testPrisma.inboundSender
      .deleteMany({ where: { accountId: s.accountId, address: s.address } })
      .catch(() => {});
    await testPrisma.inboundSenderVerification
      .deleteMany({ where: { accountId: s.accountId, address: s.address } })
      .catch(() => {});
  }
  usedSenders.length = 0;
});

describe("addInboundSender", () => {
  it("creates a pending row and mints a verification token", async () => {
    const result = await addInboundSender(
      TEST_ACCOUNT_ID,
      "New <new@example.com>",
    );
    expect(result).toMatchObject({ ok: true, address: "new@example.com" });
    if (!result.ok || !result.token) throw new Error("expected a token");
    await track(TEST_ACCOUNT_ID, "new@example.com");

    const row = await testPrisma.inboundSender.findUnique({
      where: {
        accountId_address: {
          accountId: TEST_ACCOUNT_ID,
          address: "new@example.com",
        },
      },
    });
    expect(row?.verificationTokenHash).not.toBeNull();
    // Not verified until the link is clicked.
    expect(await findVerifiedSenderAccount("new@example.com")).toBeUndefined();
    expect(await findPendingSenderRow("new@example.com")).toBeDefined();
  });

  it("normalizes the address and rejects junk", async () => {
    const result = await addInboundSender(TEST_ACCOUNT_ID, "not-an-email");
    expect(result).toMatchObject({ ok: false });
  });

  it("is idempotent for an already-verified own address (no new token)", async () => {
    const first = await addInboundSender(TEST_ACCOUNT_ID, "mine@example.com");
    if (!first.ok || !first.token) throw new Error("addInboundSender failed");
    expect((await verifyInboundSenderAddress(first.token)).status).toBe(
      "verified",
    );
    await track(TEST_ACCOUNT_ID, "mine@example.com");

    const again = await addInboundSender(TEST_ACCOUNT_ID, "mine@example.com");
    expect(again).toMatchObject({ ok: true, token: null });
  });

  it("fails when another account already verified the address", async () => {
    const claimed = await addInboundSender(
      OTHER_ACCOUNT_ID,
      "claimed@example.com",
    );
    if (!claimed.ok || !claimed.token)
      throw new Error("addInboundSender failed");
    expect((await verifyInboundSenderAddress(claimed.token)).status).toBe(
      "verified",
    );
    await track(OTHER_ACCOUNT_ID, "claimed@example.com");

    const result = await addInboundSender(
      TEST_ACCOUNT_ID,
      "claimed@example.com",
    );
    expect(result).toMatchObject({
      ok: false,
      error: "That email address is already verified for another account",
    });
  });
});

describe("verifyInboundSenderAddress", () => {
  /**
   * Mint a pending sender row's token. When the INB-BOMB-1 global
   * cooldown suppresses the mint (a rival row for the same address sent
   * recently), create the row directly — the claim tests need concurrent
   * rival rows to exist.
   */
  async function pendingSender(
    accountId: string,
    address: string,
  ): Promise<string> {
    const result = await addInboundSender(accountId, address);
    await track(accountId, address);
    if (result.ok && result.token) return result.token;
    const token = generateOpaqueToken();
    const now = new Date();
    await testPrisma.inboundSender.create({
      data: {
        accountId,
        address,
        verificationTokenHash: hashToken(token),
        verificationSentAt: now,
        createdAt: now,
      },
    });
    return token;
  }

  it("verifies the address, claims it exclusively, and consumes the token", async () => {
    const token = await pendingSender(TEST_ACCOUNT_ID, "owner@example.com");

    const outcome = await verifyInboundSenderAddress(token);
    expect(outcome).toMatchObject({
      status: "verified",
      address: "owner@example.com",
      accountId: TEST_ACCOUNT_ID,
      accountName: "Test Account",
    });

    // The verification row exists → the account now resolves for this address.
    const verified = await findVerifiedSenderAccount("owner@example.com");
    expect(verified?.account.id).toBe(TEST_ACCOUNT_ID);

    // The token is single-use; a second click is invalid.
    expect((await verifyInboundSenderAddress(token)).status).toBe("invalid");
  });

  it("rejects an unknown token", async () => {
    expect(
      (await verifyInboundSenderAddress("definitely-not-a-token")).status,
    ).toBe("invalid");
  });

  it("rejects expired tokens (7-day TTL)", async () => {
    const token = await pendingSender(TEST_ACCOUNT_ID, "slow@example.com");
    await testPrisma.inboundSender.update({
      where: {
        accountId_address: {
          accountId: TEST_ACCOUNT_ID,
          address: "slow@example.com",
        },
      },
      data: {
        verificationSentAt: new Date(
          Date.now() - 8 * 24 * 3600 * 1000,
        ).toISOString(),
      },
    });
    const outcome = await verifyInboundSenderAddress(token);
    expect(outcome).toMatchObject({
      status: "expired",
      address: "slow@example.com",
    });
    expect(await findVerifiedSenderAccount("slow@example.com")).toBeUndefined();
  });

  it("deletes other accounts' pending rows when it claims an address", async () => {
    const rivalToken = await pendingSender(
      OTHER_ACCOUNT_ID,
      "rival@example.com",
    );
    const ownerToken = await pendingSender(
      TEST_ACCOUNT_ID,
      "rival@example.com",
    );

    expect((await verifyInboundSenderAddress(ownerToken)).status).toBe(
      "verified",
    );

    // The rival's pending row is gone and their token no longer verifies.
    const rivalRow = await testPrisma.inboundSender.findUnique({
      where: {
        accountId_address: {
          accountId: OTHER_ACCOUNT_ID,
          address: "rival@example.com",
        },
      },
    });
    expect(rivalRow).toBeNull();
    expect((await verifyInboundSenderAddress(rivalToken)).status).toBe(
      "invalid",
    );
  });

  it("is already-verified when the address was claimed in the meantime", async () => {
    const token = await pendingSender(TEST_ACCOUNT_ID, "race@example.com");
    // Another account verifies first (simulating a race / rival click).
    await testPrisma.inboundSenderVerification.create({
      data: {
        address: "race@example.com",
        accountId: OTHER_ACCOUNT_ID,
        verifiedAt: new Date().toISOString(),
      },
    });
    await track(OTHER_ACCOUNT_ID, "race@example.com");

    const outcome = await verifyInboundSenderAddress(token);
    expect(outcome.status).toBe("already-verified");
  });
});

describe("resendInboundSenderVerification", () => {
  it("suppresses an immediate resend inside the cooldown window", async () => {
    // INB-BOMB-1: resending within VERIFICATION_RESEND_MS no longer
    // re-mints (an add→resend cycle used to email the address twice). The
    // ORIGINAL token stays valid — the row's token hash is untouched — so
    // a user who lost the first email can still click it.
    const first = await addInboundSender(TEST_ACCOUNT_ID, "resend@example.com");
    if (!first.ok || !first.token) throw new Error("addInboundSender failed");
    await track(TEST_ACCOUNT_ID, "resend@example.com");

    const second = await resendInboundSenderVerification(
      TEST_ACCOUNT_ID,
      "resend@example.com",
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("resend failed");
    expect(second.token).toBeNull();
    expect(second.recent).toBe(true);

    // No re-mint happened: the original token still verifies.
    expect((await verifyInboundSenderAddress(first.token)).status).toBe(
      "verified",
    );
  });

  it("keeps the cooldown across remove → re-add (tombstone)", async () => {
    // The remove→re-add loop used to mint a fresh email per cycle. The
    // tombstone keeps verificationSentAt, so the re-add is suppressed —
    // globally, including a different account re-adding the same address.
    const address = "cycle@example.com";
    const first = await addInboundSender(TEST_ACCOUNT_ID, address);
    if (!first.ok || !first.token) throw new Error("addInboundSender failed");
    await track(TEST_ACCOUNT_ID, address);

    await removeInboundSender(TEST_ACCOUNT_ID, address);
    // The removed row is invisible to the pipeline...
    expect(await findPendingSenderRow(address)).toBeUndefined();

    const second = await addInboundSender(TEST_ACCOUNT_ID, address);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("add failed");
    expect(second.token).toBeNull();
    expect(second.recent).toBe(true);

    const third = await addInboundSender(OTHER_ACCOUNT_ID, address);
    expect(third.ok).toBe(true);
    if (!third.ok) throw new Error("add failed");
    expect(third.token).toBeNull();
    expect(third.recent).toBe(true);
  });

  it("fails for an already-verified address", async () => {
    const first = await addInboundSender(TEST_ACCOUNT_ID, "done@example.com");
    if (!first.ok || !first.token) throw new Error("addInboundSender failed");
    expect((await verifyInboundSenderAddress(first.token)).status).toBe(
      "verified",
    );
    await track(TEST_ACCOUNT_ID, "done@example.com");

    const result = await resendInboundSenderVerification(
      TEST_ACCOUNT_ID,
      "done@example.com",
    );
    expect(result).toMatchObject({
      ok: false,
      error: "That address is already verified",
    });
  });
});

describe("ensureInboundSenderForUser (the login email is the default sender)", () => {
  it("creates the login email as a pending sender and returns a token", async () => {
    const result = await ensureInboundSenderForUser(
      TEST_ACCOUNT_ID,
      "FreshUser@Example.com",
    );
    expect(result).toMatchObject({
      token: expect.any(String),
      verified: false,
    });
    await track(TEST_ACCOUNT_ID, "freshuser@example.com");

    const row = await testPrisma.inboundSender.findUnique({
      where: {
        accountId_address: {
          accountId: TEST_ACCOUNT_ID,
          address: "freshuser@example.com",
        },
      },
    });
    expect(row).not.toBeNull();
  });

  it("does not re-send while a fresh verification email is in flight", async () => {
    const first = await ensureInboundSenderForUser(
      TEST_ACCOUNT_ID,
      "steady@example.com",
    );
    expect(first.token).not.toBeNull();
    await track(TEST_ACCOUNT_ID, "steady@example.com");

    const again = await ensureInboundSenderForUser(
      TEST_ACCOUNT_ID,
      "steady@example.com",
    );
    expect(again).toMatchObject({ token: null, verified: false });
  });

  it("re-sends once the outstanding email is stale (24h)", async () => {
    const first = await ensureInboundSenderForUser(
      TEST_ACCOUNT_ID,
      "stale@example.com",
    );
    expect(first.token).not.toBeNull();
    await track(TEST_ACCOUNT_ID, "stale@example.com");
    await testPrisma.inboundSender.update({
      where: {
        accountId_address: {
          accountId: TEST_ACCOUNT_ID,
          address: "stale@example.com",
        },
      },
      data: {
        verificationSentAt: new Date(
          Date.now() - 25 * 3600 * 1000,
        ).toISOString(),
      },
    });

    const again = await ensureInboundSenderForUser(
      TEST_ACCOUNT_ID,
      "stale@example.com",
    );
    expect(again.token).not.toBeNull();
  });

  it("reports verified when the login email is already verified for the account", async () => {
    const first = await ensureInboundSenderForUser(
      TEST_ACCOUNT_ID,
      "mine2@example.com",
    );
    expect(first.token).not.toBeNull();
    await track(TEST_ACCOUNT_ID, "mine2@example.com");
    if (!first.token) throw new Error("no token");

    expect((await verifyInboundSenderAddress(first.token)).status).toBe(
      "verified",
    );

    const again = await ensureInboundSenderForUser(
      TEST_ACCOUNT_ID,
      "mine2@example.com",
    );
    expect(again).toMatchObject({ token: null, verified: true });
  });

  it("reports claimedByOther when another account verified the email", async () => {
    const other = await ensureInboundSenderForUser(
      OTHER_ACCOUNT_ID,
      "taken@example.com",
    );
    if (!other.token) throw new Error("no token");
    await track(OTHER_ACCOUNT_ID, "taken@example.com");
    expect((await verifyInboundSenderAddress(other.token)).status).toBe(
      "verified",
    );

    const mine = await ensureInboundSenderForUser(
      TEST_ACCOUNT_ID,
      "taken@example.com",
    );
    expect(mine).toMatchObject({
      token: null,
      verified: false,
      claimedByOther: true,
    });
    // No pending row was created for the losing account.
    expect(
      await testPrisma.inboundSender.findUnique({
        where: {
          accountId_address: {
            accountId: TEST_ACCOUNT_ID,
            address: "taken@example.com",
          },
        },
      }),
    ).toBeNull();
  });
});

describe("removeInboundSender", () => {
  it("frees the address by removing both the row and the verification", async () => {
    const first = await addInboundSender(TEST_ACCOUNT_ID, "bye@example.com");
    if (!first.ok || !first.token) throw new Error("addInboundSender failed");
    expect((await verifyInboundSenderAddress(first.token)).status).toBe(
      "verified",
    );
    await track(TEST_ACCOUNT_ID, "bye@example.com");

    await removeInboundSender(TEST_ACCOUNT_ID, "bye@example.com");

    expect(await findVerifiedSenderAccount("bye@example.com")).toBeUndefined();
    expect(await findPendingSenderRow("bye@example.com")).toBeUndefined();
  });
});
