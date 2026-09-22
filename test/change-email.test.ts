import { describe, expect, it, beforeEach, vi } from "vitest";
import { expect as pwExpect } from "playwright/test";
import { hashPassword } from "~/lib/passwords";
import { action } from "~/routes/settings";
import { findUserByEmail, findUserById } from "~/lib/db/accounts";
import { sessionStorage, SESSION_USER_KEY } from "~/lib/auth.server";
import { testPrisma } from "./helpers/seedTestData";
import { freshPage, signIn, waitForHydration } from "./helpers/launchBrowser";
import type { Route as SettingsRoute } from "+types/app/routes/+types/settings";
import { contextForRequest } from "./helpers/authContext";

/**
 * Changing the sign-in email from Settings: the password gate, the address
 * rule shared with signup, the notice the OLD address gets, and the
 * receipts-by-email verification the NEW address starts.
 *
 * Outbound email is mocked here (the send path itself is exercised in
 * test/fastmail-send.test.ts), because what this feature promises is who gets
 * which email, not how the transport works. Each case runs in an account of
 * its own with its own next address, so nothing is order-dependent (the test
 * database is reseeded per file, not per case).
 */

interface SentMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const SEND = vi.hoisted(() => ({
  sendEmail: vi.fn(async (_input: SentMail) => true),
}));

vi.mock("~/lib/reply.server", () => ({ sendEmail: SEND.sendEmail }));

const NOW = "2026-06-15T00:00:00.000Z";
const PASSWORD = "email-change-pass";

/** A committed session cookie for a user id, exactly as login mints it. */
async function sessionCookie(userId: string): Promise<string> {
  const session = await sessionStorage.getSession();
  session.set(SESSION_USER_KEY, userId);
  return sessionStorage.commitSession(session);
}

let seq = 0;

interface TestAccount {
  id: string;
  accountId: string;
  email: string;
  /** The address this case moves to. Mixed case on purpose: the write
   * normalizes it, because the address is the login identifier. */
  nextEmail: string;
}

/** A dedicated account + verified user for one test. */
async function makeAccount(): Promise<TestAccount> {
  const n = ++seq;
  const id = `user_mail_${n}`;
  const accountId = `acct_mail_${n}`;
  const email = `mail${n}@example.com`;
  await testPrisma.account.create({
    data: {
      id: accountId,
      name: `Mail ${n}`,
      inviteCode: `mailcode${n}`,
      createdAt: NOW,
    },
  });
  await testPrisma.user.create({
    data: {
      id,
      accountId,
      email,
      passwordHash: await hashPassword(PASSWORD),
      emailVerifiedAt: NOW,
      createdAt: NOW,
    },
  });
  return { id, accountId, email, nextEmail: `Moved${n}@Example.COM` };
}

/** POST the change-email intent through the route action, signed in as
 * `cookie`'s user. */
async function changeEmail(
  cookie: string,
  to: string,
  password = PASSWORD,
): Promise<Response> {
  const form = new FormData();
  form.set("intent", "changeEmail");
  form.set("email", to);
  form.set("password", password);
  const request = new Request("https://expense.test/settings", {
    method: "POST",
    body: form,
    headers: { cookie },
  });
  return action({
    request,
    params: {},
    context: await contextForRequest(request),
  } as unknown as SettingsRoute.ActionArgs);
}

/** Every email the app sent during this test, oldest first. */
function sent(): SentMail[] {
  return SEND.sendEmail.mock.calls.map(([input]) => input);
}

describe("changing your sign-in email", () => {
  beforeEach(() => {
    SEND.sendEmail.mockClear();
  });

  it("refuses a wrong password, a bad address, and the address already in use", async () => {
    const user = await makeAccount();
    const cookie = await sessionCookie(user.id);

    expect(
      await (
        await changeEmail(cookie, user.nextEmail, "not-the-password")
      ).json(),
    ).toEqual({ ok: false, error: "That password doesn't match." });
    expect(await (await changeEmail(cookie, "nope")).json()).toEqual({
      ok: false,
      error: "Enter a valid email address",
    });
    expect(await (await changeEmail(cookie, user.email)).json()).toEqual({
      ok: false,
      error: "That's the address you already use.",
    });

    // A verified account holds the address: the change is refused, and it
    // takes a correct password to even hear that.
    const taken = await makeAccount();
    expect(await (await changeEmail(cookie, taken.email)).json()).toEqual({
      ok: false,
      error: "That email is already in use.",
    });

    expect((await findUserById(user.id))?.email).toBe(user.email);
    // No email went out for any of the refusals.
    expect(SEND.sendEmail).not.toHaveBeenCalled();
  });

  it("moves the address, notices the old one, and starts the new one's sender verification", async () => {
    const user = await makeAccount();
    const cookie = await sessionCookie(user.id);
    // The old address is an approved receipts sender; changing the sign-in
    // email doesn't touch sender rows, so it keeps importing until the user
    // says otherwise on the Email page.
    await testPrisma.inboundSender.create({
      data: { accountId: user.accountId, address: user.email, createdAt: NOW },
    });

    const res = await changeEmail(cookie, user.nextEmail);
    // Success navigates (the card re-renders with the new address) and leaves
    // the session alone: no cookie, because the credential did not change.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/settings?email=changed#sign-in-email",
    );
    expect(res.headers.get("set-cookie")).toBeNull();

    // Normalized on the way in: the address is the login identifier.
    const moved = user.nextEmail.toLowerCase();
    expect((await findUserById(user.id))?.email).toBe(moved);
    expect((await findUserByEmail(moved))?.id).toBe(user.id);
    expect(await findUserByEmail(user.email)).toBeUndefined();

    // The old mailbox is told, with the new address named in it.
    const notice = sent().find(
      (mail) => mail.subject === "Your Expense sign-in email was changed",
    );
    expect(notice?.to).toBe(user.email);
    expect(notice?.html).toContain(moved);

    // The new mailbox gets its own proof-of-control link, which is what gates
    // receipts sent from there.
    const verify = sent().find(
      (mail) =>
        mail.subject === "Verify your email to receive receipts by email",
    );
    expect(verify?.to).toBe(moved);
    expect(verify?.html).toContain("/receipts-email-verify?token=");

    const oldSender = await testPrisma.inboundSender.count({
      where: { accountId: user.accountId, address: user.email },
    });
    expect(oldSender).toBe(1);
    const newSender = await testPrisma.inboundSender.findFirst({
      where: { accountId: user.accountId, address: moved },
    });
    expect(newSender).not.toBeNull();
    // Unverified, pending the link: receipts from it are not imported yet.
    expect(
      await testPrisma.inboundSenderVerification.count({
        where: { address: moved },
      }),
    ).toBe(0);
  });

  it("keeps the session working and the password unchanged", async () => {
    const user = await makeAccount();
    const cookie = await sessionCookie(user.id);
    const before = await testPrisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });

    expect((await changeEmail(cookie, user.nextEmail)).status).toBe(302);

    // A password reset is what revokes sessions and tokens; an email change
    // is not, so the signed-in browser stays signed in.
    const settings = await fetch("http://127.0.0.1:5199/settings", {
      headers: { cookie: cookie.split(";")[0]! },
      redirect: "manual",
    });
    expect(settings.status).toBe(200);
    const row = await testPrisma.user.findUnique({
      where: { id: user.id },
      select: { credentialsChangedAt: true, passwordHash: true },
    });
    expect(row?.passwordHash).toBe(before?.passwordHash);
    expect(row?.credentialsChangedAt).toBeNull();
  });

  it("takes an address from an unverified signup, the same rule signup applies", async () => {
    const user = await makeAccount();
    const pendingEmail = "pending.signup@example.com";
    await testPrisma.account.create({
      data: {
        id: "acct_pending_email",
        name: "Pending",
        inviteCode: "pending1",
        createdAt: NOW,
      },
    });
    await testPrisma.user.create({
      data: {
        id: "user_pending_email",
        accountId: "acct_pending_email",
        email: pendingEmail,
        passwordHash: await hashPassword("pending-pass"),
        emailVerifiedAt: null,
        createdAt: NOW,
      },
    });

    const res = await changeEmail(await sessionCookie(user.id), pendingEmail);
    expect(res.status).toBe(302);
    // The abandoned signup is gone (its account with it) and the address is
    // the caller's now.
    expect(
      await testPrisma.user.count({ where: { id: "user_pending_email" } }),
    ).toBe(0);
    expect((await findUserByEmail(pendingEmail))?.id).toBe(user.id);
  });

  it("changes it from Settings and signs in with the new address", async () => {
    const user = await makeAccount();
    const moved = user.nextEmail.toLowerCase();
    const page = await freshPage();
    // Fail fast with a locator in the message rather than a 30s test timeout.
    page.setDefaultTimeout(10_000);
    await signIn(page, user.email, PASSWORD);
    await page.goto("/settings#sign-in-email", { waitUntil: "load" });
    await waitForHydration(page);

    const card = page.locator("#sign-in-email");
    await pwExpect(card).toBeVisible();
    await pwExpect(card).toContainText(user.email);

    // A wrong password leaves the card (and the typed address) in place.
    await card.locator('input[name="email"]').fill(moved);
    await card.locator('input[name="password"]').fill("wrong-password");
    await card.locator('button[type="submit"]').click();
    await pwExpect(card.getByRole("alert")).toHaveText(
      "That password doesn't match.",
    );
    await pwExpect(card.locator('input[name="email"]')).toHaveValue(moved);

    await card.locator('input[name="password"]').fill(PASSWORD);
    await card.locator('button[type="submit"]').click();
    await page.waitForURL((url) => url.searchParams.get("email") === "changed");
    await pwExpect(card.getByRole("status")).toContainText(
      "Sign-in email changed",
    );
    // The card shows the new address right away: the loader reads it fresh,
    // not from the cached user row.
    await pwExpect(card).toContainText(moved);
    await pwExpect(card).not.toContainText(user.email);

    // And the new address is the one that signs in.
    const fresh = await freshPage();
    await signIn(fresh, moved, PASSWORD);
    expect(new URL(fresh.url()).pathname).toBe("/expenses");
  });
});
