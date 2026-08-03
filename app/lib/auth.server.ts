import { createCookieSessionStorage, redirect } from "react-router";
import { SESSION_SECRET } from "./env";
import { hashPassword, normalizeInviteCode, verifyPassword } from "./passwords";
import {
  createAccount,
  createUser,
  findAccountByInviteCode,
  findUserByEmail,
  findUserById,
  getPasswordHash,
  initStore,
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
    const next =
      url.pathname === "/"
        ? ""
        : `?next=${encodeURIComponent(url.pathname + url.search)}`;
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
 */
export async function login(email: string, password: string): Promise<string> {
  await initStore();
  const user = await findUserByEmail(email);
  const stored = user ? await getPasswordHash(user.id) : "";
  if (!user || !stored || !(await verifyPassword(password, stored))) {
    throw new Error("Invalid email or password");
  }
  return commitUserSession(user.id);
}

/**
 * Create a new account with its first user and return the session cookie.
 * Throws with a user-facing message on invalid input or duplicates.
 */
export async function createAccountWithUser(input: {
  accountName: string;
  email: string;
  password: string;
}): Promise<string> {
  await initStore();
  validateSignup(input.email, input.password);
  const account = await createAccount(input.accountName);
  const user = await createUser({
    accountId: account.id,
    email: input.email,
    passwordHash: await hashPassword(input.password),
  });
  return commitUserSession(user.id);
}

/**
 * Join an existing account via its invite code and return the session cookie.
 * Throws with a user-facing message on a bad code or duplicate email.
 */
export async function joinAccountWithInviteCode(input: {
  inviteCode: string;
  email: string;
  password: string;
}): Promise<string> {
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
  return commitUserSession(user.id);
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
