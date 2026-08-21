import { ulid } from "ulid";
import {
  generateInviteCode,
  generateOpaqueToken,
  hashToken,
} from "~/lib/passwords";
import prisma from "~/lib/prisma.server";
import {
  createCache,
  isTest,
  VERIFICATION_RESEND_MS,
  VERIFICATION_TTL_MS,
} from "~/lib/db/shared";
import { initStore, seedDefaultCategories } from "~/lib/db/seed";
import type { Account, User } from "~/lib/types";

// --- Accounts --------------------------------------------------------------

/** Short-lived in-process cache for readAccount — an account's invite code
 * and name rarely change once set. 5-minute TTL; cache miss or regeneration
 * re-queries. */
const accountCache = createCache<Account>(300_000);

export async function readAccount(id: string): Promise<Account | undefined> {
  if (!isTest) {
    const cached = accountCache.get(id);
    if (cached !== undefined) return cached;
  }
  const row = await prisma.account.findUnique({ where: { id } });
  if (row) accountCache.set(id, row);
  return row ?? undefined;
}

/** One member of an account, as shown in Settings — never secrets. */
interface AccountMember {
  email: string;
  /** When the emailed verification link was clicked; null = can't sign in yet. */
  emailVerifiedAt: string | null;
  createdAt: string;
}

/**
 * Everyone who joined the account, oldest first. The Settings member list
 * reads only this — password hashes and verification tokens never leave
 * the store.
 */
export async function readAccountUsers(
  accountId: string,
): Promise<AccountMember[]> {
  return prisma.user.findMany({
    where: { accountId },
    select: { email: true, emailVerifiedAt: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * The bootstrap user (oldest user) — the MCP smoke check issues an OAuth
 * token for them directly. Undefined only when the database has no users.
 */
export async function readBootstrapUser(): Promise<User | undefined> {
  await initStore();
  const first = await prisma.user.findFirst({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      accountId: true,
      email: true,
      emailVerifiedAt: true,
      createdAt: true,
    },
  });
  if (!first) return undefined;
  return {
    id: first.id,
    accountId: first.accountId,
    email: first.email,
    emailVerifiedAt: first.emailVerifiedAt ?? null,
    createdAt: first.createdAt,
  };
}

/** Create a new account. Throws if the name is already taken. */
export async function createAccount(name: string): Promise<Account> {
  const clean = name.trim();
  if (!clean) throw new Error("Account name is required");
  await initStore();
  const clash = await prisma.account.findUnique({ where: { name: clean } });
  if (clash) throw new Error("An account with that name already exists");
  const account: Account = {
    id: ulid(),
    name: clean,
    inviteCode: generateInviteCode(),
    createdAt: new Date().toISOString(),
  };
  // The account is created with the IRS Schedule C default categories so
  // receipts can be categorized immediately.
  await prisma.$transaction([
    prisma.account.create({ data: account }),
    seedDefaultCategories(account.id),
  ]);
  return account;
}

export async function findAccountByInviteCode(
  inviteCode: string,
): Promise<Account | undefined> {
  const row = await prisma.account.findUnique({ where: { inviteCode } });
  return row ?? undefined;
}

/** Replace an account's invite code with a fresh one; returns the new code. */
export async function regenerateInviteCode(accountId: string): Promise<string> {
  const code = generateInviteCode();
  await prisma.account.update({
    where: { id: accountId },
    data: { inviteCode: code },
  });
  accountCache.delete(accountId);
  return code;
}

// --- Users ----------------------------------------------------------------

/** Create a user in an account. Throws if the email is already taken.
 * `emailVerifiedAt` null (the default) means the new login must verify the
 * emailed link before it can sign in; the verification columns hold the
 * current single-use token and when it was sent. */
export async function createUser(input: {
  accountId: string;
  email: string;
  passwordHash: string;
  emailVerifiedAt?: string | null;
  verificationTokenHash?: string | null;
  verificationSentAt?: string | null;
}): Promise<User> {
  await initStore();
  const email = input.email.trim().toLowerCase();
  if (!email) throw new Error("Email is required");
  const clash = await prisma.user.findUnique({ where: { email } });
  if (clash) throw new Error("That email is already in use");
  const user: User = {
    id: ulid(),
    accountId: input.accountId,
    email,
    emailVerifiedAt: input.emailVerifiedAt ?? null,
    createdAt: new Date().toISOString(),
  };
  // The registering email becomes an allowed "receipts by email" sender by
  // default — the account can remove it or add more addresses in Settings.
  await prisma.$transaction([
    prisma.user.create({
      data: {
        ...user,
        passwordHash: input.passwordHash,
        verificationTokenHash: input.verificationTokenHash ?? null,
        verificationSentAt: input.verificationSentAt ?? null,
      },
    }),
    prisma.inboundSender.createMany({
      data: [
        {
          accountId: input.accountId,
          address: email,
          createdAt: user.createdAt,
        },
      ],
      skipDuplicates: true,
    }),
  ]);
  return user;
}

/** Map a Prisma user row to the domain User shape (the password hash and
 * verification token columns are deliberately never exposed). */
function rowToUser(row: {
  id: string;
  accountId: string;
  email: string;
  emailVerifiedAt: string | null;
  createdAt: string;
}): User {
  return {
    id: row.id,
    accountId: row.accountId,
    email: row.email,
    emailVerifiedAt: row.emailVerifiedAt ?? null,
    createdAt: row.createdAt,
  };
}

export async function findUserByEmail(
  email: string,
): Promise<User | undefined> {
  const row = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
  });
  return row ? rowToUser(row) : undefined;
}

/** Short-lived in-process cache for findUserById — every request re-resolves
 * the session's user (requireUser), and image-heavy pages fire dozens of
 * those per render; caching the lookup for a few seconds cuts the connection
 * churn that exhausts the Supabase pooler under load. Only successful
 * lookups are cached; a deleted user is re-checked after the TTL (and a stale
 * hit merely means the next request redirects to login). */
const userCache = createCache<User>(30_000);

export async function findUserById(id: string): Promise<User | undefined> {
  const cached = userCache.get(id);
  if (cached !== undefined) return cached;
  const row = await prisma.user.findUnique({ where: { id } });
  const user = row ? rowToUser(row) : undefined;
  if (user) userCache.set(id, user);
  return user;
}

/** The stored password hash for a user (never exposed on the User type). */
export async function getPasswordHash(userId: string): Promise<string> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  return row?.passwordHash ?? "";
}

/** Replace a user's stored password hash — the login path rehashes with
 * the current scrypt cost when the stored hash used older parameters (see
 * `needsRehash` in passwords.ts). */
export async function updateUserPasswordHash(
  userId: string,
  passwordHash: string,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
  });
}

/** Store the current verification token for a user (sha256 at rest) with a
 * fresh sent-at time. Called by the signup/join flows and the resend path. */
export async function setUserVerificationToken(
  userId: string,
  rawToken: string,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      verificationTokenHash: hashToken(rawToken),
      verificationSentAt: new Date().toISOString(),
    },
  });
}

/** Outcome of clicking an emailed account-verification link. */
export type VerifyEmailOutcome =
  | { status: "verified"; email: string }
  | { status: "already-verified"; email: string }
  | { status: "expired"; email: string }
  | { status: "invalid" };

/** Consume an emailed account-verification token: marks the user's email
 * verified so they can sign in. The token hash is kept after success, so
 * refreshing a used link reports "already-verified"; a token from a
 * replaced account (re-signup) no longer matches any row and reports
 * "invalid". */
export async function verifyUserEmailAddress(
  rawToken: string,
): Promise<VerifyEmailOutcome> {
  if (!rawToken) return { status: "invalid" };
  const row = await prisma.user.findFirst({
    where: { verificationTokenHash: hashToken(rawToken) },
  });
  if (!row) return { status: "invalid" };
  if (row.emailVerifiedAt) {
    return { status: "already-verified", email: row.email };
  }
  const sentAt = row.verificationSentAt;
  if (!sentAt || Date.now() - Date.parse(sentAt) > VERIFICATION_TTL_MS) {
    return { status: "expired", email: row.email };
  }
  await prisma.user.update({
    where: { id: row.id },
    data: { emailVerifiedAt: new Date().toISOString() },
  });
  return { status: "verified", email: row.email };
}

/** Outcome of a re-signup attempt against an existing email. */
export type ReplaceUnverifiedOutcome =
  | { status: "replaced" }
  /** The email belongs to a verified account — it can't be replaced. */
  | { status: "verified" }
  | { status: "no-user" };

/** Discard a user's unverified account so a fresh signup with the same
 * email can proceed: deletes the user (and its account when it was the
 * only user) plus its receipts-by-email sender rows, so the old
 * verification link stops working and the email is free again. */
export async function deleteUnverifiedUser(
  email: string,
): Promise<ReplaceUnverifiedOutcome> {
  const user = await findUserByEmail(email);
  if (!user) return { status: "no-user" };
  if (user.emailVerifiedAt) return { status: "verified" };
  const accountUserCount = await prisma.user.count({
    where: { accountId: user.accountId },
  });
  if (accountUserCount <= 1) {
    // The throwaway account holds only this user — drop it (cascades the
    // user and every account-scoped row).
    await prisma.account.delete({ where: { id: user.accountId } });
  } else {
    // The user joined an existing account — drop just the user and its
    // receipts-by-email sender rows (the address claim is abandoned too).
    await prisma.$transaction([
      prisma.user.delete({ where: { id: user.id } }),
      prisma.inboundSender.deleteMany({
        where: { accountId: user.accountId, address: email },
      }),
      prisma.inboundSenderVerification.deleteMany({
        where: { address: email },
      }),
    ]);
  }
  return { status: "replaced" };
}

/** Mint a fresh verification token for an already-created user, refusing
 * to re-send more than once a day (mirrors the receipts-by-email sender
 * resend guard). Returns the raw token to email, or a refusal. */
export async function resendUserVerification(
  userId: string,
): Promise<
  { token: string } | { status: "already-verified" | "rate-limited" }
> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { emailVerifiedAt: true, verificationSentAt: true },
  });
  if (!row || row.emailVerifiedAt) return { status: "already-verified" };
  if (
    row.verificationSentAt &&
    Date.now() - Date.parse(row.verificationSentAt) < VERIFICATION_RESEND_MS
  ) {
    return { status: "rate-limited" };
  }
  const token = generateOpaqueToken();
  await setUserVerificationToken(userId, token);
  return { token };
}

/** Store the current password-reset token for a user (sha256 at rest) with
 * a fresh sent-at time. Mirrors setUserVerificationToken. */
export async function setUserPasswordResetToken(
  userId: string,
  rawToken: string,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordResetTokenHash: hashToken(rawToken),
      passwordResetSentAt: new Date().toISOString(),
    },
  });
}

/** Outcome of submitting a password-reset link. */
export type PasswordResetOutcome =
  | { status: "reset"; email: string }
  | { status: "expired"; email: string }
  | { status: "invalid" };

/** Consume an emailed password-reset token: set the new password hash and
 * clear the token (single-use — a replayed link reports invalid). 7-day
 * TTL, mirroring the account-verification link; a stale token is cleared
 * on first use so it can't be retried. */
export async function resetUserPasswordWithToken(
  rawToken: string,
  passwordHash: string,
): Promise<PasswordResetOutcome> {
  if (!rawToken) return { status: "invalid" };
  const row = await prisma.user.findFirst({
    where: { passwordResetTokenHash: hashToken(rawToken) },
  });
  if (!row) return { status: "invalid" };
  const sentAt = row.passwordResetSentAt;
  if (!sentAt || Date.now() - Date.parse(sentAt) > VERIFICATION_TTL_MS) {
    await prisma.user.update({
      where: { id: row.id },
      data: { passwordResetTokenHash: null, passwordResetSentAt: null },
    });
    return { status: "expired", email: row.email };
  }
  await prisma.user.update({
    where: { id: row.id },
    data: {
      passwordHash,
      passwordResetTokenHash: null,
      passwordResetSentAt: null,
    },
  });
  return { status: "reset", email: row.email };
}

/** Has a reset email for this user been sent within the once-a-day resend
 * window? The request path skips re-sending (and re-minting) while one is
 * still fresh. */
export async function passwordResetRecentlySent(
  userId: string,
): Promise<boolean> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordResetSentAt: true },
  });
  return Boolean(
    row?.passwordResetSentAt &&
    Date.now() - Date.parse(row.passwordResetSentAt) < VERIFICATION_RESEND_MS,
  );
}
