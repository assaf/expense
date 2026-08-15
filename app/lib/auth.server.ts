import { createCookieSessionStorage, redirect } from "react-router";
import { SESSION_SECRET } from "./env";
import {
  generateOpaqueToken,
  hashPassword,
  needsRehash,
  normalizeInviteCode,
  verifyPassword,
} from "./passwords";
import { sendAccountVerificationEmail } from "./account-verification.server";
import { sendVerificationEmail } from "./sender-verification.server";
import {
  createAccount,
  createUser,
  deleteUnverifiedUser,
  findAccountByInviteCode,
  findUserByEmail,
  findUserById,
  getPasswordHash,
  readAccount,
  resendUserVerification,
  setUserVerificationToken,
  type ReplaceUnverifiedOutcome,
  updateUserPasswordHash,
} from "~/lib/db/accounts";
import { ensureInboundSenderForUser } from "~/lib/db/inbound";
import { initStore } from "~/lib/db/seed";
import {
  authLockedUntil,
  clearAuthFailures,
  recordAuthFailure,
} from "~/lib/db/auth-attempts";
import { isEmail, MAX_PASSWORD_LENGTH } from "./validation";
import type { User } from "./types";

/**
 * Multi-user access control. Users live in Postgres (accounts + users
 * tables); the session is a signed HttpOnly cookie holding the user id
 * (SESSION_SECRET). Every protected route resolves the user — and therefore
 * the account — before touching any data, so users only ever see their own
 * account's expenses/settings.
 *
 * The very first user/account is bootstrapped from APP_EMAIL /
 * APP_PASSWORD when the database is empty (see database.ts).
 */

if (!SESSION_SECRET) {
  throw new Error(
    "SESSION_SECRET is not configured — set it in .env / the deployment dashboard.",
  );
}

const SESSION_COOKIE = "expense_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: SESSION_COOKIE,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
    secrets: [SESSION_SECRET],
  },
});

/** Require an authenticated request. Returns the user or redirects to /login. */
export async function requireUser(request: Request): Promise<User> {
  await initStore();
  const session = await sessionStorage.getSession(
    request.headers.get("Cookie"),
  );
  const userId = session.get("userId");
  const user =
    typeof userId === "string" ? await findUserById(userId) : undefined;
  if (!user) {
    const url = new URL(request.url);
    // Loader fetches arrive as /path.data — redirect back to the real page
    // so the post-login bounce (safeNext) lands on the route, not its data.
    const pathname = url.pathname.endsWith(".data")
      ? url.pathname.slice(0, -5)
      : url.pathname;
    const next =
      pathname === "/"
        ? ""
        : `?next=${encodeURIComponent(pathname + url.search)}`;
    throw redirect(`/login${next}`);
  }
  return user;
}

/** True when the request already has a valid session. */
export async function isAuthenticated(request: Request): Promise<boolean> {
  const session = await sessionStorage.getSession(
    request.headers.get("Cookie"),
  );
  const userId = session.get("userId");
  return (
    typeof userId === "string" && (await findUserById(userId)) !== undefined
  );
}

/** The Set-Cookie value for the given user's session. */
async function commitUserSession(userId: string): Promise<string> {
  const session = await sessionStorage.getSession();
  session.set("userId", userId);
  return sessionStorage.commitSession(session);
}

/** Login failed because the account's email hasn't been verified yet. The
 * login UI catches this to offer a resend button. */
export class EmailNotVerifiedError extends Error {
  readonly email: string;

  constructor(email: string) {
    super(
      "Please verify your email address first — check your inbox for the link we sent.",
    );
    this.name = "EmailNotVerifiedError";
    this.email = email;
  }
}

/** Login/join rejected because the target is in brute-force lockout. The
 * message is user-facing and deliberately vague about the exact window. */
class TooManyAttemptsError extends Error {
  constructor() {
    super(
      "Too many failed attempts for this account — try again in about 15 minutes.",
    );
    this.name = "TooManyAttemptsError";
  }
}

/** Best-effort failure bookkeeping: auth must never break because the
 * counter row couldn't be written. */
async function recordFailureBestEffort(key: string): Promise<void> {
  try {
    await recordAuthFailure(key);
  } catch (err) {
    console.warn("[auth] failed to record auth attempt for %s:", key, err);
  }
}

async function clearFailuresBestEffort(key: string): Promise<void> {
  try {
    await clearAuthFailures(key);
  } catch (err) {
    console.warn("[auth] failed to clear auth attempts for %s:", key, err);
  }
}

/** Reject when the target key is in lockout (throws TooManyAttemptsError). */
async function guardLockout(key: string): Promise<void> {
  if (await authLockedUntil(key)) {
    throw new TooManyAttemptsError();
  }
}

/**
 * Validate credentials and, on success, return the Set-Cookie header value
 * for the session. Throws on invalid credentials or an unverified email
 * (EmailNotVerifiedError). Pass the result to
 * `redirect(…, { headers: { "Set-Cookie": value } })`.
 *
 * Brute-force protection: attempts are counted per email in Postgres
 * (`auth_attempts`); five failures inside 15 minutes lock the account for
 * 15 minutes, and the lock is checked BEFORE the scrypt derivation (a
 * locked account costs the attacker nothing). Passwords over
 * MAX_PASSWORD_LENGTH are rejected without deriving. A successful login
 * clears the counter.
 *
 * The login email is the account's default receipts-by-email sender: it is
 * ensured to exist and a verification email is sent when owed (see
 * ensureDefaultSender). `origin` builds the absolute verification link.
 */
export async function login(
  email: string,
  password: string,
  origin?: string,
): Promise<string> {
  await initStore();
  const normalizedEmail = email.trim().toLowerCase();
  const lockKey = `login:${normalizedEmail}`;
  if (password.length > MAX_PASSWORD_LENGTH) {
    // Same public message as a wrong password; scrypt never runs.
    throw new Error("Invalid email or password");
  }
  await guardLockout(lockKey);
  const user = await findUserByEmail(normalizedEmail);
  const stored = user ? await getPasswordHash(user.id) : "";
  if (!user || !stored || !(await verifyPassword(password, stored))) {
    await recordFailureBestEffort(lockKey);
    throw new Error("Invalid email or password");
  }
  await clearFailuresBestEffort(lockKey);
  // The account can't sign in until the emailed link was clicked.
  if (!user.emailVerifiedAt) {
    throw new EmailNotVerifiedError(user.email);
  }
  // Re-derive with the current scrypt cost when the stored hash used older
  // parameters (legacy `salt:hash` rows or an older cost factor) — a
  // one-time cost on the next successful sign-in.
  if (needsRehash(stored)) {
    await updateUserPasswordHash(user.id, await hashPassword(password));
  }
  await ensureDefaultSender(user, origin);
  return commitUserSession(user.id);
}

/**
 * Create a new account with its first user and return the pending signup
 * state — the user is NOT logged in until the emailed verification link is
 * clicked. If an earlier signup with the same email is still unverified it
 * is discarded (account, old verification link) and replaced by this one.
 * Throws with a user-facing message on invalid input or a verified email
 * that is already taken.
 */
export async function createAccountWithUser(
  input: {
    accountName: string;
    email: string;
    password: string;
  },
  origin?: string,
): Promise<{ email: string }> {
  await initStore();
  validateSignup(input.email, input.password);
  await replaceUnverifiedSignup(input.email);
  const account = await createAccount(input.accountName);
  return createPendingUser({
    accountId: account.id,
    email: input.email,
    password: input.password,
    accountName: input.accountName,
    origin,
  });
}

/**
 * Join an existing account via its invite code. Like signup, the new user
 * must verify their email before signing in; an earlier unverified user
 * with the same email is discarded and replaced. Returns the pending
 * signup state — never a session. Throws with a user-facing message on a
 * bad code or duplicate verified email.
 */
export async function joinAccountWithInviteCode(
  input: {
    inviteCode: string;
    email: string;
    password: string;
  },
  origin?: string,
): Promise<{ email: string }> {
  await initStore();
  validateSignup(input.email, input.password);
  const code = normalizeInviteCode(input.inviteCode);
  // Brute-force guard on the invite code itself: five wrong guesses inside
  // 15 minutes lock that code for 15 minutes.
  const lockKey = `invite:${code}`;
  await guardLockout(lockKey);
  const account = await findAccountByInviteCode(code);
  if (!account) {
    await recordFailureBestEffort(lockKey);
    throw new Error("That invite code is not valid");
  }
  await clearFailuresBestEffort(lockKey);
  await replaceUnverifiedSignup(input.email);
  return createPendingUser({
    accountId: account.id,
    email: input.email,
    password: input.password,
    accountName: account.name,
    origin,
  });
}

/**
 * Discard an earlier unverified signup with the same email so a fresh
 * signup/join can proceed: the old account and its verification link are
 * deleted and the email is free again. Throws when the email belongs to a
 * verified account (it can't be replaced) or the replacement fails.
 */
async function replaceUnverifiedSignup(email: string): Promise<void> {
  const existing = await findUserByEmail(email);
  if (existing?.emailVerifiedAt) {
    throw new Error("That email is already in use.");
  }
  if (existing) {
    const outcome: ReplaceUnverifiedOutcome = await deleteUnverifiedUser(email);
    if (outcome.status !== "replaced") {
      throw new Error("Could not re-create the account — please try again.");
    }
  }
}

/**
 * The pending-signup tail shared by signup and join: create the user, mint
 * + store the verification token, ensure the default receipts-by-email
 * sender, and email the verification link. The account must already exist
 * and the email must be free (see replaceUnverifiedSignup). Returns the
 * pending signup's email — never a session.
 */
async function createPendingUser(input: {
  accountId: string;
  email: string;
  password: string;
  accountName: string;
  origin?: string;
}): Promise<{ email: string }> {
  const user = await createUser({
    accountId: input.accountId,
    email: input.email,
    passwordHash: await hashPassword(input.password),
    emailVerifiedAt: null,
  });
  const token = generateOpaqueToken();
  await setUserVerificationToken(user.id, token);
  await ensureDefaultSender(user, input.origin);
  await sendAccountVerificationEmail({
    to: user.email,
    token,
    origin: input.origin,
    accountName: input.accountName,
  });
  return { email: user.email };
}

/** Re-send the account-verification email for an unverified signup (login
 * page's resend button). Throws with a user-facing message when there is no
 * such account, the email is already verified, or the last email was sent
 * less than a day ago (rate limit). */
export async function resendAccountVerification(
  email: string,
  origin?: string,
): Promise<{ email: string }> {
  await initStore();
  const user = await findUserByEmail(email);
  if (!user) throw new Error("No account with that email.");
  if (user.emailVerifiedAt) {
    throw new Error("That email is already verified — sign in.");
  }
  const result = await resendUserVerification(user.id);
  if (!("token" in result)) {
    if (result.status === "rate-limited") {
      throw new Error(
        "We already sent a verification email recently — check your inbox.",
      );
    }
    throw new Error("That email is already verified — sign in.");
  }
  const account = await readAccount(user.accountId);
  await sendAccountVerificationEmail({
    to: user.email,
    token: result.token,
    origin,
    accountName: account?.name ?? user.email,
  });
  return { email: user.email };
}

/**
 * The user's login email is their default receipts-by-email sender. Make
 * sure the sender row exists and email a verification link when one is owed
 * (freshly added, or the last one is stale). Receipts only start flowing
 * after the link is clicked. Failures never break sign-in: a skipped email
 * just means the address waits to be verified from Settings.
 */
async function ensureDefaultSender(user: User, origin?: string): Promise<void> {
  try {
    const { token, claimedByOther } = await ensureInboundSenderForUser(
      user.accountId,
      user.email,
    );
    if (claimedByOther) {
      console.warn(
        "[auth] login email %s is already verified for another account — not added as a sender",
        user.email,
      );
      return;
    }
    if (!token) return;
    const account = await readAccount(user.accountId);
    await sendVerificationEmail({
      to: user.email,
      token,
      origin,
      accountName: account?.name ?? user.email,
    });
  } catch (err) {
    console.warn(
      "[auth] failed to ensure default receipts-by-email sender for %s:",
      user.email,
      err,
    );
  }
}

function validateSignup(email: string, password: string): void {
  if (!isEmail(email)) {
    throw new Error("Enter a valid email address");
  }
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at most ${MAX_PASSWORD_LENGTH} characters`,
    );
  }
}

/** Destroy the session and return the Set-Cookie header value that clears it. */
export async function logout(request: Request): Promise<string> {
  const session = await sessionStorage.getSession(
    request.headers.get("Cookie"),
  );
  return sessionStorage.destroySession(session);
}
