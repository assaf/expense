import {
  createContext,
  createCookieSessionStorage,
  redirect,
  type RouterContextProvider,
} from "react-router";
import { SESSION_SECRET } from "./env";
import {
  generateOpaqueToken,
  hashPassword,
  needsRehash,
  normalizeInviteCode,
  verifyPasswordWithParity,
} from "./passwords";
import { sendAccountVerificationEmail } from "./account-verification.server";
import { sendEmailChangeNotice } from "./email-change-notice.server";
import { sendVerificationEmail as sendSenderVerificationEmail } from "./sender-verification.server";
import { sendVerificationEmail as sendPasswordResetEmail } from "./verification-email.server";
import { escapeHtml } from "./escape";
import { paragraph } from "./email-layout.server";
import {
  changeUserEmail,
  changeUserPassword,
  createAccount,
  createUser,
  deleteUnverifiedUser,
  findAccountByInviteCode,
  findUserByEmail,
  findUserById,
  readCredentialsEpoch,
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
 * APP_PASSWORD when the database is empty (see app/lib/db/accounts.ts).
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
/** The session key holding the credentials epoch the session was minted under.
 * A password reset bumps the user's epoch, so a session carrying the old value
 * is refused (the signed cookie itself cannot be recalled). */
const SESSION_CREDENTIALS_KEY = "credentialsChangedAt";
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

/** The user a valid session refers to, or undefined when there is none. A
 * session minted before the user's last password change is not valid: the
 * epoch comparison is what revokes it. A cookie from before this check existed
 * carries no epoch, and a user who never reset has none either, so both
 * normalize to "" and existing sessions keep working. A user row that is gone
 * reads as the `DELETED_EPOCH` sentinel instead (see readCredentialsEpoch), so
 * a closed account's cookie is refused immediately rather than when the
 * process-local user cache expires. Exported
 * for the OAuth callbacks, which resolve the parked session's user without
 * requireContextUser (they must not redirect). */
export async function sessionUser(request: Request): Promise<User | undefined> {
  const session = await sessionStorage.getSession(
    request.headers.get("Cookie"),
  );
  const userId = session.get(SESSION_USER_KEY);
  if (typeof userId !== "string") return undefined;
  const user = await findUserById(userId);
  if (!user) return undefined;
  const minted = session.get(SESSION_CREDENTIALS_KEY);
  const epoch = typeof minted === "string" ? minted : "";
  // The epoch is read fresh: the user row above is cached per process for
  // 30s, and a password reset on another instance must revoke this cookie
  // now, not when that cache happens to expire.
  return epoch === (await readCredentialsEpoch(userId)) ? user : undefined;
}

/** The /login redirect an anonymous request to a private path gets, at the
 * page path rather than its `.data` fetch path so the post-login bounce
 * (safeNext) lands on the route, not the data endpoint. The gate throws it,
 * and requireContextUser throws it for a route the gate somehow let through. */
export function loginRedirect(request: Request): Response {
  const url = new URL(request.url);
  const pathname = url.pathname.endsWith(".data")
    ? url.pathname.slice(0, -5)
    : url.pathname;
  const next =
    pathname === "/"
      ? ""
      : `?next=${encodeURIComponent(pathname + url.search)}`;
  return redirect(`/login${next}`);
}

/** Per-request value the root middleware stores the resolved session user in:
 * the user, or null for an anonymous request. Routes read it instead of
 * resolving the session a second time, which is what used to happen: the root
 * loader resolved it for the gate, then each route loader resolved it again. */
export const userContext = createContext<User | null>(null);

/** Resolve the session for one request and publish it on `context`. The root
 * middleware calls this once per request; an anonymous request stores null
 * rather than leaving the key unset, so a route can tell "no user" apart from
 * "the middleware never ran". */
export async function resolveSessionUser(
  context: Readonly<RouterContextProvider>,
  request: Request,
): Promise<User | undefined> {
  await initStore();
  const user = await sessionUser(request);
  context.set(userContext, user ?? null);
  return user;
}

/** The session user the root middleware resolved, or the /login redirect when
 * there is none. Routes call this instead of resolving the session: the cookie
 * verification, the user lookup and the credentials-epoch read all already
 * happened. The check stays because the gate's public-path list and a route's
 * own idea of whether it is private must never disagree: a disagreement has to
 * fail closed, not hand the route a null user. */
export function requireContextUser(
  context: Readonly<RouterContextProvider>,
  request: Request,
): User {
  const user = context.get(userContext);
  if (!user) throw loginRedirect(request);
  return user;
}

/** The Set-Cookie value for the given user's session, stamped with the
 * credentials epoch it is minted under. */
async function commitUserSession(
  user: Pick<User, "id" | "credentialsChangedAt">,
): Promise<string> {
  const session = await sessionStorage.getSession();
  session.set(SESSION_USER_KEY, user.id);
  session.set(SESSION_CREDENTIALS_KEY, user.credentialsChangedAt ?? "");
  return sessionStorage.commitSession(session);
}

/** Exposed for Fastmail onboarding: mint a session cookie for a freshly
 * created VERIFIED user without going through the login path (the login
 * path re-verifies credentials; the onboarding token already proved
 * mailbox control and the password was set in the same step). */
export async function createSessionCookie(
  user: Pick<User, "id" | "credentialsChangedAt">,
): Promise<string> {
  return commitUserSession(user);
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
  if (originUrl.origin === new URL(request.url).origin) return;
  // Behind a TLS-terminating proxy (local dev: https://expense.localhost
  // terminating at an http://127.0.0.1 vite server) the scheme and host the
  // server sees can both differ from the browser's Origin. The proxy
  // reports the public side of the chain in x-forwarded-host, so the same
  // host through the proxy chain is still the same site.
  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  const host = forwardedHost || new URL(request.url).host;
  if (originUrl.host !== host) {
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
  // A missing (or hashless) user still pays the scrypt derivation, so the
  // response time does not reveal which addresses have accounts.
  const matches = await verifyPasswordWithParity(password, stored);
  if (!user || !stored || !matches) {
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
  return commitUserSession(user);
}

/** Re-authenticate a signed-in user for a destructive action. Same lockout
 * key, same constant-time comparison, and the same failure bookkeeping login
 * uses, so a stolen session cannot brute-force the password through this path.
 * Never throws on a mismatch; the error text is the caller's to render. */
export async function confirmPassword(
  user: Pick<User, "id" | "email">,
  password: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const lockKey = `login:${user.email.trim().toLowerCase()}`;
  if (password.length > MAX_PASSWORD_LENGTH) {
    // Same short-circuit login uses: nothing the app stored could be this
    // long, so scrypt never runs.
    return { ok: false, error: "That password doesn't match." };
  }
  try {
    await guardLockout(lockKey);
  } catch (error) {
    // The lockout owns its user-facing text; a different failure is a bug.
    if (error instanceof TooManyAttemptsError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
  const stored = await getPasswordHash(user.id);
  if (!(await verifyPasswordWithParity(password, stored))) {
    await recordFailureBestEffort(lockKey);
    // Deliberately not login's "Invalid email or password": the caller is
    // already signed in, so the address is not a secret here.
    return { ok: false, error: "That password doesn't match." };
  }
  await clearFailuresBestEffort(lockKey);
  return { ok: true };
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
  await claimEmailAddress(input.email);
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
  await claimEmailAddress(input.email);
  return createPendingUser({
    accountId: account.id,
    email: input.email,
    password: input.password,
    accountName: account.name,
    origin,
  });
}

/**
 * Make an email address available to the caller: an earlier UNVERIFIED
 * signup holding it is discarded (the account and its verification link are
 * deleted, and the address is free again). Throws when the address belongs to
 * a VERIFIED account, since that one can't be replaced, and when a
 * verification email went out too recently to tell whether the signup is
 * abandoned. Signup, join and a change of sign-in email all come through
 * here, so the rule about who owns an address is one rule.
 */
async function claimEmailAddress(email: string): Promise<void> {
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
 * and the email must be free (see claimEmailAddress). Returns the
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
 * page's resend button). The response is the same whether or not the
 * address has an account, is already verified, or was mailed within the
 * last day (rate limit): the caller must not be able to probe which
 * addresses exist, matching requestPasswordReset. Only an existing,
 * unverified, not-recently-mailed account actually receives mail. */
export async function resendAccountVerification(
  email: string,
  origin?: string,
): Promise<{ email: string }> {
  await initStore();
  const normalizedEmail = email.trim().toLowerCase();
  const user = await findUserByEmail(normalizedEmail);
  if (!user || user.emailVerifiedAt) return { email: normalizedEmail };
  const result = await resendUserVerification(user.id);
  if (!("token" in result)) return { email: normalizedEmail };
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
  validatePassword(password);
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
 * Change a signed-in user's password. The current one is verified the way
 * login verifies it (same lockout key, same constant-time comparison, same
 * failure bookkeeping), so a stolen session can't use this form to grind
 * through passwords it doesn't know.
 *
 * On success the new password supersedes the old credential: other devices
 * are signed out, connected apps are revoked (see changeUserPassword), and
 * that includes the session that asked for the change. The returned cookie
 * re-mints it, and the caller has to send it back or the user signs
 * themselves out. Never throws on bad input; the message belongs to the form.
 */
export async function changePassword(
  user: Pick<User, "id" | "email">,
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: true; cookie: string } | { ok: false; error: string }> {
  const confirmed = await confirmPassword(user, currentPassword);
  if (!confirmed.ok) return confirmed;
  const problem = passwordProblem(newPassword);
  if (problem) return { ok: false, error: problem };
  // Setting the same password again would bump the epoch and revoke every
  // connected app for nothing, so it is refused instead of silently landed.
  const stored = await getPasswordHash(user.id);
  if (await verifyPasswordWithParity(newPassword, stored)) {
    return { ok: false, error: "That's already your password." };
  }
  const epoch = await changeUserPassword(
    user.id,
    await hashPassword(newPassword),
  );
  return {
    ok: true,
    cookie: await commitUserSession({
      id: user.id,
      credentialsChangedAt: epoch,
    }),
  };
}

/**
 * Point a signed-in user's sign-in email at another address. Takes effect
 * immediately, like the receipts-by-email sender flow does for a new mailbox:
 * the address is a login identifier, and the account has already been
 * verified. Three things happen around the write.
 *
 * The current password is checked first, so a stolen session can't move the
 * account to an address its owner controls (nor probe which addresses are
 * already taken, which the uniqueness rule would otherwise reveal).
 *
 * The new address becomes the account's default receipts-by-email sender, so
 * it gets a verification link of its own: that link is what proves the
 * mailbox before receipts from it are accepted.
 *
 * The OLD address gets a notice naming the new one (sendEmailChangeNotice).
 * Nothing about the session changes: the password, the credentials epoch and
 * the cookie are untouched, so the device that made the change stays signed
 * in, and a mailbox that just lost the account is told about it.
 *
 * Never throws on bad input; the message belongs to the form.
 */
export async function changeEmail(
  user: Pick<User, "id" | "accountId" | "email">,
  newEmail: string,
  currentPassword: string,
  origin?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = newEmail.trim().toLowerCase();
  if (!isEmail(email)) {
    return { ok: false, error: "Enter a valid email address" };
  }
  if (email === user.email.trim().toLowerCase()) {
    return { ok: false, error: "That's the address you already use." };
  }
  const confirmed = await confirmPassword(user, currentPassword);
  if (!confirmed.ok) return confirmed;
  try {
    await claimEmailAddress(email);
  } catch (error) {
    // claimEmailAddress owns this wording: it is the same rule signup and
    // join apply to an address someone else already holds.
    if (error instanceof Error) return { ok: false, error: error.message };
    throw error;
  }
  const previous = user.email;
  await changeUserEmail(user.id, email);
  await ensureDefaultSender({ accountId: user.accountId, email }, origin);
  const account = await readAccount(user.accountId);
  await sendEmailChangeNotice({
    to: previous,
    newEmail: email,
    accountName: account?.name ?? email,
    origin,
  });
  return { ok: true };
}

/**
 * The user's login email is their default receipts-by-email sender. Make
 * sure the sender row exists and email a verification link when one is owed
 * (freshly added, or the last one is stale). Receipts only start flowing
 * after the link is clicked. Failures never break sign-in: a skipped email
 * just means the address waits to be verified from Settings.
 */
async function ensureDefaultSender(
  user: Pick<User, "accountId" | "email">,
  origin?: string,
): Promise<void> {
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

/** The password contract, in one place: signup, join, the emailed reset link
 * and the Settings change all check the same two bounds. Returns the
 * user-facing message, or null when the password is acceptable; the callers
 * that hand a message to a form use this form, the rest wrap it. */
function passwordProblem(password: string): string | null {
  if (password.length < 8) {
    return "Password must be at least 8 characters";
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  return null;
}

/** The password contract as a throwing validator (the signup/join/reset
 * shape: the message bubbles up to the form that rendered it). */
function validatePassword(password: string): void {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
}

/** Shared signup validation: email format + the password contract above. The
 * Fastmail onboarding flow reuses this for the create step, so the password
 * rules are identical to email signup. */
export function validateSignup(email: string, password: string): void {
  if (!isEmail(email)) {
    throw new Error("Enter a valid email address");
  }
  validatePassword(password);
}

/** Destroy the session and return the Set-Cookie header value that clears it. */
export async function logout(request: Request): Promise<string> {
  const session = await sessionStorage.getSession(
    request.headers.get("Cookie"),
  );
  return sessionStorage.destroySession(session);
}
