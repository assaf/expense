import { and } from "@prisma/orm-postgres/orm-client";
import { db } from "~/lib/prisma.server";
import { isUniqueViolation } from "~/lib/db/pg-errors";
import { fromIso, toIso, toIsoOrNull } from "~/lib/db/wire";
import { generateOpaqueToken, hashToken } from "~/lib/passwords";
import { extractEmailAddress, isEmail } from "~/lib/validation";
import { VERIFICATION_RESEND_MS, VERIFICATION_TTL_MS } from "~/lib/db/shared";
import type {
  Account,
  InboundEmailRecord,
  InboundSenderRecord,
} from "~/lib/types";

// --- Inbound email ----------------------------------------------------------

/** Create or update the audit row for a received email. */
export async function upsertInboundEmail(input: {
  emailId: string;
  accountId: string;
  subject: string;
  status: InboundEmailRecord["status"];
  error: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await db.orm.public.InboundEmail.upsert({
    create: { ...input, createdAt: fromIso(now), updatedAt: fromIso(now) },
    update: {
      accountId: input.accountId,
      subject: input.subject,
      status: input.status,
      error: input.error,
      updatedAt: fromIso(now),
    },
  });
}

/**
 * Atomically claim a received email for processing. Inserts the row with
 * status "processing" and lets the primary key break the tie: when two
 * concurrent drains (a burst of webhook pushes, or a push racing the daily
 * cron) both list the same email before either marks it, exactly one wins
 * the claim and the other gets `claimed: false` with the existing row.
 * This closes the read-then-upsert race that let both drains import the
 * same receipt and each send its own confirmation (duplicate replies).
 *
 * The row is updated to the final outcome (created/partial/error) by the
 * pipeline. A drain that crashes mid-processing leaves a "processing" row
 * and the email stays marked in the folder: the same recovery path as a
 * crash after the keyword mark (the error reply / folder state is the
 * recovery), and the price of never replying twice.
 */
export async function claimInboundEmail(input: {
  emailId: string;
  accountId: string;
  subject: string;
}): Promise<{
  claimed: boolean;
  existing: InboundEmailRecord | undefined;
}> {
  const now = new Date().toISOString();
  try {
    await db.orm.public.InboundEmail.create({
      emailId: input.emailId,
      accountId: input.accountId,
      subject: input.subject,
      status: "processing",
      error: "",
      createdAt: fromIso(now),
      updatedAt: fromIso(now),
    });
    return { claimed: true, existing: undefined };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  // The row already exists; read it so the caller can decide how to
  // treat the duplicate (already done, in flight, or previously failed).
  const existing = await db.orm.public.InboundEmail.first({
    emailId: input.emailId,
  });
  return {
    claimed: false,
    existing: (existing ?? undefined) as InboundEmailRecord | undefined,
  };
}

/**
 * The account that verified this sender address (the exclusivity owner).
 * Only verified addresses accept receipts; see InboundSenderVerification.
 * Undefined when no account has verified the address.
 */
export async function findVerifiedSenderAccount(
  senderEmail: string,
): Promise<{ account: Account; verifiedAt: string } | undefined> {
  const address = extractEmailAddress(senderEmail);
  if (!address) return undefined;
  const verification = await db.orm.public.InboundSenderVerification.first({
    address,
  });
  if (!verification) return undefined;
  const account = await db.orm.public.Account.first({
    id: verification.accountId,
  });
  if (!account) return undefined;
  return {
    account: {
      id: account.id,
      name: account.name,
      inviteCode: account.inviteCode,
      createdAt: toIso(account.createdAt),
    },
    verifiedAt: toIso(verification.verifiedAt),
  };
}

/**
 * A pending (added-but-unverified) sender row for an address, if any. Used
 * by the inbound pipeline to tell "verify first" from "not recognized".
 */
export async function findPendingSenderRow(
  senderEmail: string,
): Promise<{ accountId: string; address: string } | undefined> {
  const address = extractEmailAddress(senderEmail);
  if (!address) return undefined;
  const row = await db.orm.public.InboundSender.where((s) =>
    s.address.eq(address),
  )
    .orderBy([(s) => s.createdAt.asc(), (s) => s.accountId.asc()])
    .select("accountId", "address")
    .first();
  return row ?? undefined;
}

/**
 * All sender addresses for an account, in the order they were added, with
 * their verified status (a sender is verified when an
 * inbound_sender_verifications row exists for the address).
 */
export async function listInboundSenders(
  accountId: string,
): Promise<InboundSenderRecord[]> {
  const rows = await db.orm.public.InboundSender.where((s) =>
    s.accountId.eq(accountId),
  )
    .orderBy([(s) => s.createdAt.asc(), (s) => s.address.asc()])
    .all();
  const verifications = await db.orm.public.InboundSenderVerification.where(
    (v) => v.accountId.eq(accountId),
  ).all();
  const byAddress = new Map(verifications.map((v) => [v.address, v]));
  return rows.map((r) => ({
    accountId: r.accountId,
    address: r.address,
    verified: byAddress.has(r.address),
    verifiedAt: toIsoOrNull(byAddress.get(r.address)?.verifiedAt ?? null),
    verificationSentAt: toIsoOrNull(r.verificationSentAt),
    createdAt: toIso(r.createdAt),
  }));
}

/**
 * Add a sender address for an account (normalized, idempotent) and mint a
 * fresh verification token for it. The address is only usable once verified
 * and only one account can verify it. Returns the token so the caller
 * emails the verification link; `token: null` means the address was already
 * verified for this account (nothing to send). Fails when the address is
 * already verified for a different account.
 */
export async function addInboundSender(
  accountId: string,
  address: string,
): Promise<
  | { ok: true; address: string; token: string | null }
  | { ok: false; error: string }
> {
  const normalized = extractEmailAddress(address);
  if (!normalized || !isEmail(normalized)) {
    return { ok: false, error: "Enter a valid email address" };
  }
  const verification = await db.orm.public.InboundSenderVerification.first({
    address: normalized,
  });
  if (verification && verification.accountId !== accountId) {
    return {
      ok: false,
      error: "That email address is already verified for another account",
    };
  }
  if (verification) return { ok: true, address: normalized, token: null };
  const token = await mintSenderToken(accountId, normalized);
  return { ok: true, address: normalized, token };
}

/**
 * Mint a fresh verification token for an already-added sender (the "Resend
 * verification email" action). Fails when the address is already verified
 * or claimed by another account.
 */
export async function resendInboundSenderVerification(
  accountId: string,
  address: string,
): Promise<
  { ok: true; address: string; token: string } | { ok: false; error: string }
> {
  const normalized = extractEmailAddress(address);
  if (!normalized) return { ok: false, error: "Enter a valid email address" };
  const verification = await db.orm.public.InboundSenderVerification.first({
    address: normalized,
  });
  if (verification) {
    return {
      ok: false,
      error:
        verification.accountId === accountId
          ? "That address is already verified"
          : "That email address is already verified for another account",
    };
  }
  const token = await mintSenderToken(accountId, normalized);
  return { ok: true, address: normalized, token };
}

/** Remove a sender address (and its verification) from an account. */
export async function removeInboundSender(
  accountId: string,
  address: string,
): Promise<void> {
  const normalized = extractEmailAddress(address);
  await db.transaction(async (tx) => {
    await tx.orm.public.InboundSender.where((s) =>
      and(s.accountId.eq(accountId), s.address.eq(normalized)),
    ).deleteAll();
    await tx.orm.public.InboundSenderVerification.where((v) =>
      and(v.accountId.eq(accountId), v.address.eq(normalized)),
    ).deleteAll();
  });
}

/** The outcome of clicking a verification link (see verifyInboundSenderAddress). */
type VerifySenderOutcome =
  | {
      status: "verified";
      address: string;
      accountId: string;
      accountName: string;
    }
  | {
      status: "already-verified";
      address: string;
      accountId: string;
      accountName: string;
    }
  | { status: "expired"; address: string }
  | { status: "invalid" };

/**
 * Verify a sender address from its emailed token. Single-use, 7-day expiry,
 * and exclusive: verifying claims the address for this account (the
 * verification row's primary key rejects a second claim) and deletes every
 * other account's pending rows for it. The token is consumed regardless, so
 * a stale link can't be replayed.
 */
export async function verifyInboundSenderAddress(
  rawToken: string,
): Promise<VerifySenderOutcome> {
  if (!rawToken) return { status: "invalid" };
  const row = await db.orm.public.InboundSender.where((s) =>
    s.verificationTokenHash.eq(hashToken(rawToken)),
  ).first();
  if (!row) return { status: "invalid" };
  const sentAt = row.verificationSentAt
    ? Date.parse(toIso(row.verificationSentAt))
    : 0;
  if (!Number.isFinite(sentAt) || Date.now() - sentAt > VERIFICATION_TTL_MS) {
    return { status: "expired", address: row.address };
  }
  const account = await db.orm.public.Account.first({ id: row.accountId });
  const accountName = account?.name ?? "";
  try {
    await db.transaction(async (tx) => {
      // The primary key on address makes a second verified claim impossible.
      await tx.orm.public.InboundSenderVerification.create({
        address: row.address,
        accountId: row.accountId,
        verifiedAt: fromIso(new Date().toISOString()),
      });
      // The address is now exclusively this account's; drop rivals' pending rows.
      await tx.orm.public.InboundSender.where((s) =>
        and(s.address.eq(row.address), s.accountId.neq(row.accountId)),
      ).deleteAll();
      // Consume the token.
      await tx.orm.public.InboundSender.where((s) =>
        and(s.accountId.eq(row.accountId), s.address.eq(row.address)),
      ).update({ verificationTokenHash: null });
    });
  } catch (err) {
    // 23505: another account verified the address first (race).
    if (isUniqueViolation(err)) {
      return {
        status: "already-verified",
        address: row.address,
        accountId: row.accountId,
        accountName,
      };
    }
    throw err;
  }
  return {
    status: "verified",
    address: row.address,
    accountId: row.accountId,
    accountName,
  };
}

/**
 * Claim the account's login email as a VERIFIED receipts-by-email sender
 * without an emailed link; used by FastMail onboarding, where a valid
 * JMAP API token has already proven mailbox control (the same proof the
 * link click provides). Creates the sender row when missing, then claims
 * the address exclusively with the same transaction as the link click.
 * `claimedByOther` means the address is already verified for a different
 * account, so the caller must not touch it (and must not treat it as fatal).
 */
export async function verifyInboundSenderDirect(
  accountId: string,
  address: string,
): Promise<{ verified: boolean; claimedByOther: boolean }> {
  const normalized = extractEmailAddress(address);
  if (!normalized || !isEmail(normalized)) {
    return { verified: false, claimedByOther: false };
  }
  const now = new Date().toISOString();
  await db.orm.public.InboundSender.upsert({
    create: {
      accountId,
      address: normalized,
      createdAt: fromIso(now),
    },
    update: {},
    conflictOn: { accountId, address: normalized },
  });
  try {
    await db.transaction(async (tx) => {
      // The primary key on address makes a second verified claim impossible.
      await tx.orm.public.InboundSenderVerification.create({
        address: normalized,
        accountId,
        verifiedAt: fromIso(now),
      });
      // The address is now exclusively this account's; drop rivals' pending rows.
      await tx.orm.public.InboundSender.where((s) =>
        and(s.address.eq(normalized), s.accountId.neq(accountId)),
      ).deleteAll();
      // No emailed token to consume; the proof was the JMAP session.
      await tx.orm.public.InboundSender.where((s) =>
        and(s.accountId.eq(accountId), s.address.eq(normalized)),
      ).updateAll({ verificationTokenHash: null, verificationSentAt: null });
    });
    return { verified: true, claimedByOther: false };
  } catch (err) {
    // 23505: another account verified the address first (race).
    if (isUniqueViolation(err)) {
      return { verified: false, claimedByOther: true };
    }
    throw err;
  }
}

/**
 * Guarantee the account's login email is a sender row (the "default"
 * receipts-by-email address). Creates it pending when missing and mints a
 * verification token; called on signup, join, and every sign-in. A token is
 * returned (send the verification email now) when the row was just created
 * or the last verification email is stale (>24h). `verified` reports an
 * already-verified own row; `claimedByOther` means the address is verified
 * for a different account (the login email can't be claimed, since the
 * owner verified it elsewhere first).
 */
export async function ensureInboundSenderForUser(
  accountId: string,
  email: string,
): Promise<{
  token: string | null;
  verified: boolean;
  claimedByOther: boolean;
}> {
  const address = extractEmailAddress(email);
  if (!address) return { token: null, verified: false, claimedByOther: false };
  const verification = await db.orm.public.InboundSenderVerification.first({
    address,
  });
  if (verification) {
    return {
      token: null,
      verified: verification.accountId === accountId,
      claimedByOther: verification.accountId !== accountId,
    };
  }
  const existing = await db.orm.public.InboundSender.where((s) =>
    and(s.accountId.eq(accountId), s.address.eq(address)),
  ).first();
  if (existing?.verificationTokenHash) {
    const sentAt = existing.verificationSentAt
      ? Date.parse(toIso(existing.verificationSentAt))
      : 0;
    if (
      Number.isFinite(sentAt) &&
      Date.now() - sentAt < VERIFICATION_RESEND_MS
    ) {
      // A fresh verification email is already in flight; don't re-send.
      return { token: null, verified: false, claimedByOther: false };
    }
  }
  const token = await mintSenderToken(accountId, address);
  return { token, verified: false, claimedByOther: false };
}

/**
 * Create (or refresh) the pending sender row with a fresh single-use
 * verification token, hashed at rest. Returns the raw token for the email
 * link. Shared by addInboundSender, resendInboundSenderVerification, and
 * ensureInboundSenderForUser.
 */
async function mintSenderToken(
  accountId: string,
  address: string,
): Promise<string> {
  const token = generateOpaqueToken();
  const now = new Date().toISOString();
  await db.orm.public.InboundSender.upsert({
    create: {
      accountId,
      address,
      verificationTokenHash: hashToken(token),
      verificationSentAt: fromIso(now),
      createdAt: fromIso(now),
    },
    update: {
      verificationTokenHash: hashToken(token),
      verificationSentAt: fromIso(now),
    },
    conflictOn: { accountId, address },
  });
  return token;
}
