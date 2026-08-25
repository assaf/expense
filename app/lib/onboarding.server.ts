import {
  createAccount,
  createUser,
  deleteUnverifiedUser,
  findUserByEmail,
} from "~/lib/db/accounts";
import { createEmailConnection } from "~/lib/db/email-connections";
import { verifyInboundSenderDirect } from "~/lib/db/inbound";
import { initStore } from "~/lib/db/seed";
import { readSettings, writeSettings } from "~/lib/db/settings";
import { verifyJmapToken } from "~/lib/jmap.server";
import { hashPassword } from "~/lib/passwords";
import { db } from "~/lib/prisma.server";
import { encryptSecret } from "~/lib/token-crypto.server";
import { createSessionCookie, login, validateSignup } from "~/lib/auth.server";
import type { Account } from "~/lib/types";

/**
 * FastMail onboarding (/onboarding): a first-run flow that skips the
 * emailed verification link entirely. A valid FastMail API token proves
 * mailbox control (strictly stronger than a click-through link), so:
 *
 * - the address the token resolves to (JMAP session `username`) becomes the
 *   login identity with `emailVerifiedAt` stamped (no verification email);
 * - the same address is claimed as a VERIFIED receipts-by-email sender, so
 *   forwarding from it works immediately (no link either);
 * - the mailbox is connected for auto-import, and the user lands in the
 *   inbox review.
 *
 * The user still sets a password: the session cookie expires after 30 days
 * and every later sign-in needs credentials. The account name is derived
 * from the email (unique collision gets a numeric suffix).
 *
 * Existing accounts: a verified user with the address signs in with their
 * password and the mailbox attaches to that account; an unverified (stale
 * pending signup) row is replaced: the token proves the same control the
 * emailed link would have.
 */

/** Step-1 resolution: what the token's address maps to in the DB, so the
 * UI can offer "set a password" (new) vs "enter your password" (attach). */
export type TokenResolution =
  | { ok: true; email: string; existing: "none" | "verified" | "unverified" }
  | { ok: false; error: string };

export async function verifyOnboardingToken(
  token: string,
): Promise<TokenResolution> {
  const verification = await verifyJmapToken(token);
  if (!verification.ok) return { ok: false, error: verification.message };
  const user = await findUserByEmail(verification.info.username);
  return {
    ok: true,
    email: verification.info.username,
    existing: !user ? "none" : user.emailVerifiedAt ? "verified" : "unverified",
  };
}

export interface OnboardingOutcome {
  sessionCookie: string;
  connectionId: string;
  email: string;
}

/**
 * Complete onboarding. The step-2 form carries the token (re-verified here;
 * it is the credential) plus the EMAIL + PASSWORD the user signs in
 * with. The mailbox connects to THAT account, not necessarily to the
 * account matching the mailbox address: the token proves mailbox control,
 * the password proves account ownership, and the two are combined (a
 * mailbox address may have a bootstrap/legacy account the user can't
 * authenticate to, and the attach step must not force it).
 *
 * - verified account for the entered email → sign in (lockout + rehash
 *   apply), connect the mailbox to it;
 * - unverified account → replaced by deleteUnverifiedUser (the token
 *   proves mailbox control, the same basis the emailed link would use);
 * - no account → created verified, name derived from the email.
 *
 * The receipts-by-email sender is claimed as verified ONLY when the
 * account email equals the mailbox address (the token proves control of
 * the mailbox, not of any other address). Throws Error with a
 * user-facing message; a freshly created account is rolled back if the
 * mailbox can't be connected.
 */
export async function completeOnboarding(input: {
  token: string;
  email: string;
  password: string;
}): Promise<OnboardingOutcome> {
  await initStore();
  const verification = await verifyJmapToken(input.token);
  if (!verification.ok) throw new Error(verification.message);
  const mailboxAddress = verification.info.username;
  const email = input.email.trim().toLowerCase();

  const existing = await findUserByEmail(email);
  let sessionCookie: string;
  let accountId: string;
  let createdFresh = false;

  if (existing?.emailVerifiedAt) {
    // Attach: the account the user actually signs in with.
    if (existing.email === mailboxAddress) {
      // Mailbox control also proves the login email as a sender; claim it
      // BEFORE login() so its ensureDefaultSender sees the verified row and
      // skips the verification email. A rival claim is not fatal.
      const sender = await verifyInboundSenderDirect(
        existing.accountId,
        existing.email,
      );
      if (sender.claimedByOther) {
        console.warn(
          "[onboarding] login email %s already verified for another account — sender not claimed",
          existing.email,
        );
      }
    }
    sessionCookie = await login(existing.email, input.password);
    accountId = existing.accountId;
  } else {
    validateSignup(email, input.password);
    // The token proves control of mailboxAddress ONLY: a new account's
    // login email must be that address, or emailVerifiedAt would be stamped
    // for an identity the token never verified (signup squatting / a
    // verification-gate bypass). Other addresses go through regular signup.
    if (email !== mailboxAddress) {
      throw new Error(
        `No Expense account exists for ${email}, and the token only verifies ${mailboxAddress}. Use the address from your token, or create an account with email verification instead.`,
      );
    }
    if (existing) {
      const outcome = await deleteUnverifiedUser(email);
      if (outcome.status !== "replaced") {
        throw new Error("Could not create the account — please try again.");
      }
    }
    const account = await createAccountWithDerivedName(email);
    const newUser = await createUser({
      accountId: account.id,
      email,
      passwordHash: await hashPassword(input.password),
      emailVerifiedAt: new Date().toISOString(),
    });
    if (newUser.email === mailboxAddress) {
      // createUser already made the email a sender row; claim it as
      // verified (mailbox control). A rival claim is not fatal.
      const sender = await verifyInboundSenderDirect(account.id, email);
      if (sender.claimedByOther) {
        console.warn(
          "[onboarding] login email %s already verified for another account — sender not claimed",
          email,
        );
      }
    }
    createdFresh = true;
    accountId = account.id;
    sessionCookie = await createSessionCookie(newUser.id);
  }

  const created = await createEmailConnection({
    accountId,
    provider: "fastmail",
    emailAddress: mailboxAddress,
    jmapAccountId: verification.info.mailAccountId,
    tokenEnc: encryptSecret(input.token),
  });
  if (!created.ok) {
    if (createdFresh) {
      // The mailbox is claimed elsewhere (or the connection failed), so roll
      // back the half-onboarded account. It is brand new (one user, no
      // expenses), and the account delete cascades the user, sender rows,
      // and default categories.
      await db.orm.public.Account.where({ id: accountId })
        .delete()
        .catch(() => {});
    }
    throw new Error(created.error);
  }
  await markWelcomePending(accountId);
  return {
    sessionCookie,
    connectionId: created.connection.id,
    email: mailboxAddress,
  };
}

/** The home page shows its one-time welcome panel only for accounts that
 * completed FastMail onboarding (default is hidden; see Settings). */
async function markWelcomePending(accountId: string): Promise<void> {
  const settings = await readSettings(accountId);
  await writeSettings(accountId, { ...settings, welcomePending: true });
}

/** "alex.jones@example.com" → "Alex Jones". */
function deriveAccountName(email: string): string {
  const local = (email.split("@")[0] ?? "").trim();
  const words = local
    .replace(/[._-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const base =
    words.length > 0
      ? words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
      : "My account";
  return base.length > 30 ? base.slice(0, 30).trim() : base;
}

/** Account names are unique; retry the derived name with a numeric suffix
 * on collision ("Alex Jones", "Alex Jones 2", …). */
async function createAccountWithDerivedName(email: string): Promise<Account> {
  const base = deriveAccountName(email);
  for (let i = 1; i <= 20; i++) {
    const name = i === 1 ? base : `${base} ${i}`;
    try {
      return await createAccount(name);
    } catch (err) {
      const taken =
        err instanceof Error && err.message.includes("already exists");
      if (!taken) throw err;
    }
  }
  throw new Error("Could not create the account — please try again.");
}
