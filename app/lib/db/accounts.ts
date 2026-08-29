import { ulid } from "ulid";
import { db } from "~/lib/prisma.server";
import {
  fromIso,
  nowWire,
  fromIsoOrNull,
  toIso,
  toIsoOrNull,
} from "~/lib/db/wire";
import {
  generateInviteCode,
  generateOpaqueToken,
  hashPassword,
  hashToken,
} from "~/lib/passwords";
import {
  accountFromRow,
  cachedRead,
  createCache,
  userFromRow,
  VERIFICATION_RESEND_MS,
  VERIFICATION_TTL_MS,
  withinWindow,
} from "~/lib/db/shared";
import { initStore, seedDefaultCategories } from "~/lib/db/seed";
import type { Account, User } from "~/lib/types";

// --- Accounts --------------------------------------------------------------

/** Short-lived in-process cache for readAccount: an account's invite code
 * and name rarely change once set. 5-minute TTL; cache miss or regeneration
 * re-queries. */
const accountCache = createCache<Account>(300_000);

export async function readAccount(id: string): Promise<Account | undefined> {
  return cachedRead(accountCache, id, async () => {
    const row = await db.orm.public.Account.first({ id });
    return row ? accountFromRow(row) : undefined;
  });
}

/** One member of an account, as shown in Settings, never secrets. */
interface AccountMember {
  email: string;
  /** When the emailed verification link was clicked; null = can't sign in yet. */
  emailVerifiedAt: string | null;
  createdAt: string;
}

/**
 * Everyone who joined the account, oldest first. The Settings member list
 * reads only this; password hashes and verification tokens never leave
 * the store.
 */
export async function readAccountUsers(
  accountId: string,
): Promise<AccountMember[]> {
  const rows = await db.orm.public.User.where((u) => u.accountId.eq(accountId))
    .select("email", "emailVerifiedAt", "createdAt")
    .orderBy((u) => u.createdAt.asc())
    .all();
  return rows.map((row) => ({
    email: row.email,
    emailVerifiedAt: toIsoOrNull(row.emailVerifiedAt),
    createdAt: toIso(row.createdAt),
  }));
}

/**
 * The bootstrap user (oldest user); the MCP smoke check issues an OAuth
 * token for them directly. Undefined only when the database has no users.
 */
export async function readBootstrapUser(): Promise<User | undefined> {
  await initStore();
  const first = await db.orm.public.User.select(
    "id",
    "accountId",
    "email",
    "emailVerifiedAt",
    "createdAt",
  )
    .orderBy([(u) => u.createdAt.asc(), (u) => u.id.asc()])
    .first();
  if (!first) return undefined;
  return userFromRow(first);
}

/** Create a new account. Throws if the name is already taken. */
export async function createAccount(name: string): Promise<Account> {
  const clean = name.trim();
  if (!clean) throw new Error("Account name is required");
  await initStore();
  const clash = await db.orm.public.Account.where((a) =>
    a.name.eq(clean),
  ).first();
  if (clash) throw new Error("An account with that name already exists");
  const account: Account = {
    id: ulid(),
    name: clean,
    inviteCode: generateInviteCode(),
    createdAt: new Date().toISOString(),
  };
  // The account is created with the IRS Schedule C default categories so
  // receipts can be categorized immediately.
  await db.transaction(async (tx) => {
    await tx.orm.public.Account.create({
      ...account,
      createdAt: fromIso(account.createdAt),
    });
    await seedDefaultCategories(tx, account.id);
  });
  return account;
}

export async function findAccountByInviteCode(
  inviteCode: string,
): Promise<Account | undefined> {
  const row = await db.orm.public.Account.where((a) =>
    a.inviteCode.eq(inviteCode),
  ).first();
  return row ? accountFromRow(row) : undefined;
}

/** Replace an account's invite code with a fresh one; returns the new code. */
export async function regenerateInviteCode(accountId: string): Promise<string> {
  const code = generateInviteCode();
  await db.orm.public.Account.where({ id: accountId }).update({
    inviteCode: code,
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
  const clash = await db.orm.public.User.where((u) =>
    u.email.eq(email),
  ).first();
  if (clash) throw new Error("That email is already in use");
  const user: User = {
    id: ulid(),
    accountId: input.accountId,
    email,
    emailVerifiedAt: input.emailVerifiedAt ?? null,
    createdAt: new Date().toISOString(),
  };
  // The registering email becomes an allowed "receipts by email" sender by
  // default; the account can remove it or add more addresses in Settings.
  await db.transaction(async (tx) => {
    await tx.orm.public.User.create({
      id: user.id,
      accountId: user.accountId,
      email: user.email,
      passwordHash: input.passwordHash,
      emailVerifiedAt: fromIsoOrNull(user.emailVerifiedAt),
      verificationTokenHash: input.verificationTokenHash ?? null,
      verificationSentAt: fromIsoOrNull(input.verificationSentAt ?? null),
      createdAt: fromIso(user.createdAt),
    });
    const existing = await tx.orm.public.InboundSender.where((s) =>
      s.accountId.eq(input.accountId),
    )
      .select("address")
      .all();
    if (!existing.some((s) => s.address === email)) {
      await tx.orm.public.InboundSender.create({
        accountId: input.accountId,
        address: email,
        createdAt: fromIso(user.createdAt),
      });
    }
  });
  return user;
}

export async function findUserByEmail(
  email: string,
): Promise<User | undefined> {
  const row = await db.orm.public.User.where((u) =>
    u.email.eq(email.trim().toLowerCase()),
  ).first();
  return row ? userFromRow(row) : undefined;
}

/** Short-lived in-process cache for findUserById. Every request re-resolves
 * the session's user (requireUser), and image-heavy pages fire dozens of
 * those per render; caching the lookup for a few seconds cuts the connection
 * churn that exhausts the Supabase pooler under load. Only successful
 * lookups are cached; a deleted user is re-checked after the TTL (and a stale
 * hit merely means the next request redirects to login). */
const userCache = createCache<User>(30_000);

export async function findUserById(id: string): Promise<User | undefined> {
  return cachedRead(
    userCache,
    id,
    async () => {
      const row = await db.orm.public.User.first({ id });
      return row ? userFromRow(row) : undefined;
    },
    // Unlike the other caches, the user cache keeps serving under VITEST:
    // every request re-resolves the session user, and tests count on the
    // same connection-churn relief production gets.
    { evenInTests: true },
  );
}

/** The stored password hash for a user (never exposed on the User type). */
export async function getPasswordHash(userId: string): Promise<string> {
  const row = await db.orm.public.User.where({ id: userId })
    .select("passwordHash")
    .first();
  return row?.passwordHash ?? "";
}

/** Replace a user's stored password hash; the login path rehashes with
 * the current scrypt cost when the stored hash used older parameters (see
 * `needsRehash` in passwords.ts). */
export async function updateUserPasswordHash(
  userId: string,
  passwordHash: string,
): Promise<void> {
  await db.orm.public.User.where({ id: userId }).update({ passwordHash });
}

/** Store the current verification token for a user (sha256 at rest) with a
 * fresh sent-at time. Called by the signup/join flows and the resend path. */
export async function setUserVerificationToken(
  userId: string,
  rawToken: string,
): Promise<void> {
  await db.orm.public.User.where({ id: userId }).update({
    verificationTokenHash: hashToken(rawToken),
    verificationSentAt: nowWire(),
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
  const row = await db.orm.public.User.where((u) =>
    u.verificationTokenHash.eq(hashToken(rawToken)),
  ).first();
  if (!row) return { status: "invalid" };
  if (row.emailVerifiedAt) {
    return { status: "already-verified", email: row.email };
  }
  if (!withinWindow(row.verificationSentAt, VERIFICATION_TTL_MS)) {
    return { status: "expired", email: row.email };
  }
  await db.orm.public.User.where({ id: row.id }).update({
    emailVerifiedAt: nowWire(),
  });
  return { status: "verified", email: row.email };
}

/** Outcome of a re-signup attempt against an existing email. */
export type ReplaceUnverifiedOutcome =
  | { status: "replaced" }
  /** The email belongs to a verified account, which can't be replaced. */
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
  const { count } = await db.orm.public.User.where((u) =>
    u.accountId.eq(user.accountId),
  ).aggregate((a) => ({ count: a.count() }));
  if (count <= 1) {
    // The throwaway account holds only this user; drop it (cascades the
    // user and every account-scoped row).
    await db.orm.public.Account.where({ id: user.accountId }).delete();
  } else {
    // The user joined an existing account: drop just the user and its
    // receipts-by-email sender rows (the address claim is abandoned too).
    await db.transaction(async (tx) => {
      await tx.orm.public.User.where({ id: user.id }).delete();
      await tx.orm.public.InboundSender.where((s) =>
        s.accountId.eq(user.accountId),
      )
        .where((s) => s.address.eq(email))
        .deleteAll();
      await tx.orm.public.InboundSenderVerification.where((s) =>
        s.address.eq(email),
      ).deleteAll();
    });
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
  const row = await db.orm.public.User.where({ id: userId })
    .select("emailVerifiedAt", "verificationSentAt")
    .first();
  if (!row || row.emailVerifiedAt) return { status: "already-verified" };
  if (withinWindow(row.verificationSentAt, VERIFICATION_RESEND_MS)) {
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
  await db.orm.public.User.where({ id: userId }).update({
    passwordResetTokenHash: hashToken(rawToken),
    passwordResetSentAt: nowWire(),
  });
}

/** Outcome of submitting a password-reset link. */
export type PasswordResetOutcome =
  | { status: "reset"; email: string }
  | { status: "expired"; email: string }
  | { status: "invalid" };

/** Consume an emailed password-reset token: set the new password hash and
 * clear the token (single-use; a replayed link reports invalid). 7-day
 * TTL, mirroring the account-verification link; a stale token is cleared
 * on first use so it can't be retried. */
export async function resetUserPasswordWithToken(
  rawToken: string,
  password: string,
): Promise<PasswordResetOutcome> {
  if (!rawToken) return { status: "invalid" };
  const row = await db.orm.public.User.where((u) =>
    u.passwordResetTokenHash.eq(hashToken(rawToken)),
  ).first();
  if (!row) return { status: "invalid" };
  if (!withinWindow(row.passwordResetSentAt, VERIFICATION_TTL_MS)) {
    await db.orm.public.User.where({ id: row.id }).update({
      passwordResetTokenHash: null,
      passwordResetSentAt: null,
    });
    return { status: "expired", email: row.email };
  }
  // Derived only after the token row validates: the reset route is
  // anonymous, so an invalid or expired token must not buy a full scrypt
  // derivation (the per-IP throttle bounds the rate; this bounds the cost).
  const passwordHash = await hashPassword(password);
  await db.orm.public.User.where({ id: row.id }).update({
    passwordHash,
    passwordResetTokenHash: null,
    passwordResetSentAt: null,
  });
  return { status: "reset", email: row.email };
}

/** Has a reset email for this user been sent within the once-a-day resend
 * window? The request path skips re-sending (and re-minting) while one is
 * still fresh. */
export async function passwordResetRecentlySent(
  userId: string,
): Promise<boolean> {
  const row = await db.orm.public.User.where({ id: userId })
    .select("passwordResetSentAt")
    .first();
  return withinWindow(row?.passwordResetSentAt, VERIFICATION_RESEND_MS);
}

/** Has a verification email for this address been sent within the
 * once-a-day resend window? The signup path refuses a same-day re-signup
 * so the replace flow can't be used to re-send on demand. */
export async function verificationRecentlySent(
  email: string,
): Promise<boolean> {
  const row = await db.orm.public.User.where((u) => u.email.eq(email)).first();
  return withinWindow(row?.verificationSentAt, VERIFICATION_RESEND_MS);
}
