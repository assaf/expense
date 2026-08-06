import { createCookieSessionStorage, redirect } from "react-router";
import { SESSION_SECRET } from "./env";
import {
  hashPassword,
  needsRehash,
  normalizeInviteCode,
  verifyPassword,
} from "./passwords";
import { sendVerificationEmail } from "./sender-verification.server";
import {
  createAccount,
  createUser,
  ensureInboundSenderForUser,
  findAccountByInviteCode,
  findUserByEmail,
  findUserById,
  getPasswordHash,
  initStore,
  readAccount,
  updateUserPasswordHash,
} from "./store.server";
import { isEmail } from "./validation";
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

/**
 * Validate credentials and, on success, return the Set-Cookie header value
 * for the session. Throws on invalid credentials. Pass the result to
 * `redirect(…, { headers: { "Set-Cookie": value } })`.
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
  const user = await findUserByEmail(email);
  const stored = user ? await getPasswordHash(user.id) : "";
  if (!user || !stored || !(await verifyPassword(password, stored))) {
    throw new Error("Invalid email or password");
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
 * Create a new account with its first user and return the session cookie.
 * Throws with a user-facing message on invalid input or duplicates.
 */
export async function createAccountWithUser(
  input: {
    accountName: string;
    email: string;
    password: string;
  },
  origin?: string,
): Promise<string> {
  await initStore();
  validateSignup(input.email, input.password);
  const account = await createAccount(input.accountName);
  const user = await createUser({
    accountId: account.id,
    email: input.email,
    passwordHash: await hashPassword(input.password),
  });
  await ensureDefaultSender(user, origin);
  return commitUserSession(user.id);
}

/**
 * Join an existing account via its invite code and return the session cookie.
 * Throws with a user-facing message on a bad code or duplicate email.
 */
export async function joinAccountWithInviteCode(
  input: {
    inviteCode: string;
    email: string;
    password: string;
  },
  origin?: string,
): Promise<string> {
  await initStore();
  validateSignup(input.email, input.password);
  const account = await findAccountByInviteCode(
    normalizeInviteCode(input.inviteCode),
  );
  if (!account) throw new Error("That invite code is not valid");
  const user = await createUser({
    accountId: account.id,
    email: input.email,
    passwordHash: await hashPassword(input.password),
  });
  await ensureDefaultSender(user, origin);
  return commitUserSession(user.id);
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
}

/** Destroy the session and return the Set-Cookie header value that clears it. */
export async function logout(request: Request): Promise<string> {
  const session = await sessionStorage.getSession(
    request.headers.get("Cookie"),
  );
  return sessionStorage.destroySession(session);
}
