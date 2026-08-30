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
import { sendVerificationEmail as sendSenderVerificationEmail } from "./sender-verification.server";
import { sendVerificationEmail as sendPasswordResetEmail } from "./verification-email.server";
import { escapeHtml } from "./escape";
import { paragraph } from "./email-layout.server";
import {
  createAccount,
  createUser,
  deleteUnverifiedUser,
  findAccountByInviteCode,
  findUserByEmail,
  findUserById,
  getPasswordHash,
  passwordResetRecentlySent,
  readAccount,
  resendUserVerification,
  resetUserPasswordWithToken,
  setUserPasswordResetToken,
  setUserVerificationToken,
  type ReplaceUnverifiedOutcome,
  updateUserPasswordHash,
  verificationRecentlySent,
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
 * (SESSION_SECRET). Every protected route resolves the user (and therefore
 * the account) before touching any data, so users only ever see their own
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
/** The session key holding the signed-in user id (cookie-session based;
 * the whole session serializes into the signed cookie). */
export const SESSION_USER_KEY = "userId";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export const sessionStorage = createCookieSessionStorage({
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
  const userId = session.get(SESSION_USER_KEY);
  const user =
    typeof userId === "string" ? await findUserById(userId) : undefined;
  if (!user) {
    const url = new URL(request.url);
    // Loader fetches arrive as /path.data; redirect back to the real page
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
  const userId = session.get(SESSION_USER_KEY);
  return (
    typeof userId === "string" && (await findUserById(userId)) !== undefined
  );
}

/** The Set-Cookie value for the given user's session. */
async function commitUserSession(userId: string): Promise<string> {
  const session = await sessionStorage.getSession();
  session.set(SESSION_USER_KEY, userId);
  return sessionStorage.commitSession(session);
}

/** Exposed for FastMail onboarding: mint a session cookie for a freshly
 * created VERIFIED user without going through the login path (the login
 * path re-verifies credentials; the onboarding token already proved
 * mailbox control and the password was set in the same step). */
export async function createSessionCookie(userId: string): Promise<string> {
  return commitUserSession(userId);
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
 * Reject a state-changing POST whose Origin is another site (login CSRF).
 * SameSite=Lax stops cross-site POSTs from CARRYING the session cookie,
 * but the browser still processes a Set-Cookie on the response, so the
 * session-creating actions (login, signup, onboarding, reset-request) must
 * verify the request actually came from this app. Requests without an
 * Origin header (curl, server-to-server) are allowed: they carry no
 * ambient cookies, so they can't be CSRF.
 */
export function rejectCrossSitePost(request: Request): void {
  const origin = request.headers.get("Origin");
  if (!origin) return;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    // Unparseable Origin: treat as foreign rather than guess.
    throw new Response("Cross-site request blocked", { status: 403 });
  }
  if (originUrl.origin !== new URL(request.url).origin) {
    throw new Response("Cross-site request blocked", { status: 403 });
  }
}

/** The client IP for per-IP throttling. x-forwarded-for is set by Vercel's
 * proxy; take the leftmost (original) entry. */
function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
}

/** The per-IP throttle key for an anonymous action, scoped to the path AND
 * the scope so a burst against signin never starves signup/join/resend.
 * Null when there is no client IP (direct server-to-server calls, the
 * test suite's forked server): the per-IP throttle has nothing to key on,
 * and the per-email lockout still guards the account. Production requests
 * always carry x-forwarded-for via Vercel's proxy, so the throttle applies
 * there. */
function anonymousAttemptKey(request: Request, scope: string): string | null {
  const ip = clientIp(request);
  if (!ip) return null;
  const path = new URL(request.url).pathname;
  return `anon:${ip}:${path}${scope ? `:${scope}` : ""}`;
}

/**
 * Per-IP guard for unauthenticated actions (signup/join/resend, and
 * with scope "signin" the sign-in path, which otherwise has no per-IP
 * bound and lets one IP force unlimited scrypt derivations or trip the
 * per-email lockout of any account). Every attempt counts: five inside 15
 * minutes lock the IP for 15 minutes.
 */
export async function guardAnonymousAction(
  request: Request,
  scope = "",
): Promise<void> {
  const key = anonymousAttemptKey(request, scope);
  if (!key) return;
  await guardLockout(key);
}

/** Count one anonymous attempt (call after guardAnonymousAction, success or
 * failure; the cap is on work, not on outcomes). */
export async function recordAnonymousAttempt(
  request: Request,
  scope = "",
): Promise<void> {
  const key = anonymousAttemptKey(request, scope);
  if (!key) return;
  await recordFailureBestEffort(key);
}

/**
 * The anonymous-throttle unit of work: reject when the IP is locked out,
 * then count this attempt BEFORE the work it caps (an email send, a scrypt
 * derivation, an outbound call). Counting before the work means a
 * concurrent burst sees the attempt while the slow operation is still in
 * flight, and successes consume the budget too (a burst of signups sends
 * real emails). The two calls are one semantic operation; use this wrapper
 * rather than pairing them by hand at each call site.
 */
export async function guardAnonymousAttempt(
  request: Request,
  scope = "",
): Promise<void> {
  await guardAnonymousAction(request, scope);
  await recordAnonymousAttempt(request, scope);
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
  // parameters (legacy `salt:hash` rows or an older cost factor), a
  // one-time cost on the next successful sign-in.
  if (needsRehash(stored)) {
    await updateUserPasswordHash(user.id, await hashPassword(password));
  }
  await ensureDefaultSender(user, origin);
  return commitUserSession(user.id);
}

/**
 * Create a new account with its first user and return the pending signup
 * state: the user is NOT logged in until the emailed verification link is
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
 * signup state, never a session. Throws with a user-facing message on a
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
  if (existing && (await verificationRecentlySent(email))) {
    // The pending signup's verification email just went out: refuse the
    // re-signup instead of deleting the account and sending again, or
    // anyone could re-trigger the emails at will. The link already in the
    // inbox is still good (7-day TTL).
    throw new Error(
      "We emailed a verification link to this address recently. Use that link to finish signing up.",
    );
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
 * pending signup's email (never a session).
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
 * Email a single-use password-reset link for a verified account. The
 * response is the same whether or not the account exists (no account
 * enumeration); a reset already sent within the last day is not re-sent
 * (the recipient checks their inbox). Unverified accounts are skipped;
 * they can't sign in anyway (the verification link is the recovery).
 * Never throws: email failures are logged inside the send path.
 */
export async function requestPasswordReset(
  email: string,
  origin?: string,
): Promise<void> {
  await initStore();
  const user = await findUserByEmail(email.trim().toLowerCase());
  if (!user?.emailVerifiedAt) return;
  if (await passwordResetRecentlySent(user.id)) return;
  const token = generateOpaqueToken();
  await setUserPasswordResetToken(user.id, token);
  const account = await readAccount(user.accountId);
  await sendPasswordResetEmail({
    to: user.email,
    token,
    origin,
    subject: "Reset your Expense password",
    verifyPath: "/reset-password",
    buttonLabel: "Set a new password",
    body: [
      paragraph(
        `We got a request to reset the password for <b>${escapeHtml(user.email)}</b> on <b>${escapeHtml(account?.name ?? user.email)}</b>.`,
      ),
      paragraph(
        "Click below to choose a new password. The link is single-use and expires in 7 days.",
      ),
    ],
    closingNote:
      "If you didn't request this, you can ignore this email — your password stays the same.",
  });
}

/**
 * Set a new password with the token from a reset email. Single-use, 7-day
 * TTL; the token is consumed regardless so a stale link can't be replayed.
 * Throws Error with a user-facing message on an invalid/expired token or a
 * password that fails the signup rules.
 */
export async function resetPasswordWithToken(
  rawToken: string,
  password: string,
): Promise<{ email: string }> {
  await initStore();
  // Same password contract as signup: check BEFORE the token is consumed,
  // so a bad password doesn't burn a live link.
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at most ${MAX_PASSWORD_LENGTH} characters`,
    );
  }
  // The hash is derived inside the store call, after the token row
  // validates: an invalid token must not buy a scrypt derivation.
  const outcome = await resetUserPasswordWithToken(rawToken, password);
  if (outcome.status === "invalid") {
    throw new Error("This reset link is no longer valid — request a new one.");
  }
  if (outcome.status === "expired") {
    throw new Error("This reset link has expired — request a new one.");
  }
  return { email: outcome.email };
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
    await sendSenderVerificationEmail({
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

/** Shared signup validation: email format + password length bounds. The
 * FastMail onboarding flow reuses this for the create step, so the
 * password contract is identical to email signup. */
export function validateSignup(email: string, password: string): void {
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
