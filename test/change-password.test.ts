import { describe, expect, it } from "vitest";
import { expect as pwExpect } from "playwright/test";
import { hashPassword } from "~/lib/passwords";
import { db } from "~/lib/prisma.server";
import { nowWire } from "~/lib/db/wire";
import { action } from "~/routes/settings";
import {
  resetUserPasswordWithToken,
  setUserPasswordResetToken,
} from "~/lib/db/accounts";
import {
  confirmPassword,
  sessionStorage,
  SESSION_USER_KEY,
} from "~/lib/auth.server";
import { testPrisma } from "./helpers/seedTestData";
import { freshPage, signIn, waitForHydration } from "./helpers/launchBrowser";
import type { Route as SettingsRoute } from "+types/app/routes/+types/settings";

/**
 * Changing your own password from Settings, and the well-known URL that
 * publishes where that happens (/.well-known/change-password).
 *
 * Every case that changes a password uses an account of its own, so nothing
 * here is order-dependent: the seeded fixtures (acct_test1) keep the password
 * the rest of the suite signs in with.
 */

const BASE_URL = "http://127.0.0.1:5199";
const NOW = "2026-06-15T00:00:00.000Z";
const OLD_PASSWORD = "old-password-1";
const NEW_PASSWORD = "new-password-2";

/** A committed session cookie for a user id, exactly as login mints it. */
async function sessionCookie(userId: string): Promise<string> {
  const session = await sessionStorage.getSession();
  session.set(SESSION_USER_KEY, userId);
  return sessionStorage.commitSession(session);
}

let seq = 0;

/** A dedicated account + verified user for one test, so a password change
 * can't disturb anything another case reads. */
async function makePasswordUser(): Promise<{
  id: string;
  accountId: string;
  email: string;
}> {
  const n = ++seq;
  const id = `user_pw_${n}`;
  const accountId = `acct_pw_${n}`;
  const email = `pw${n}@example.com`;
  await testPrisma.account.create({
    data: {
      id: accountId,
      name: `Password ${n}`,
      inviteCode: `pwcode0${n}`,
      createdAt: NOW,
    },
  });
  await testPrisma.user.create({
    data: {
      id,
      accountId,
      email,
      passwordHash: await hashPassword(OLD_PASSWORD),
      emailVerifiedAt: NOW,
      createdAt: NOW,
    },
  });
  return { id, accountId, email };
}

/** POST the change-password intent through the route action, signed in as
 * `cookie`'s user. */
async function changePassword(
  cookie: string,
  fields: { current?: string; next?: string; confirm?: string },
): Promise<Response> {
  const form = new FormData();
  form.set("intent", "changePassword");
  form.set("currentPassword", fields.current ?? OLD_PASSWORD);
  form.set("newPassword", fields.next ?? NEW_PASSWORD);
  form.set("confirmPassword", fields.confirm ?? fields.next ?? NEW_PASSWORD);
  return action({
    request: new Request("https://expense.test/settings", {
      method: "POST",
      body: form,
      headers: { cookie },
    }),
    params: {},
    context: {},
  } as SettingsRoute.ActionArgs);
}

/** A GET against the running test server with a session cookie, without
 * following the redirect a refused session produces. */
async function getSettings(cookie: string): Promise<Response> {
  return fetch(`${BASE_URL}/settings`, {
    headers: { cookie: cookie.split(";")[0]! },
    redirect: "manual",
  });
}

/** Does this password still open the account? */
async function passwordWorks(
  user: { id: string; email: string },
  password: string,
): Promise<boolean> {
  return (await confirmPassword(user, password)).ok;
}

describe("changing your own password", () => {
  it("refuses a wrong current password and leaves the credential alone", async () => {
    const user = await makePasswordUser();
    const res = await changePassword(await sessionCookie(user.id), {
      current: "not-the-password",
    });
    expect((await res.json()).error).toBe("That password doesn't match.");
    // A refusal keeps the session: no re-minted cookie, and the old password
    // still works.
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await passwordWorks(user, OLD_PASSWORD)).toBe(true);
    const row = await testPrisma.user.findUnique({
      where: { id: user.id },
      select: { credentialsChangedAt: true },
    });
    expect(row?.credentialsChangedAt).toBeNull();
  });

  it("refuses a new password that breaks the contract or repeats the old one", async () => {
    const user = await makePasswordUser();
    const cookie = await sessionCookie(user.id);

    expect(
      await (await changePassword(cookie, { next: "short" })).json(),
    ).toEqual({ ok: false, error: "Password must be at least 8 characters" });

    expect(
      await (
        await changePassword(cookie, {
          next: NEW_PASSWORD,
          confirm: "something-else",
        })
      ).json(),
    ).toEqual({ ok: false, error: "Those passwords don't match." });

    expect(
      await (await changePassword(cookie, { next: OLD_PASSWORD })).json(),
    ).toEqual({ ok: false, error: "That's already your password." });

    // None of the three refusals moved the credential.
    expect(await passwordWorks(user, OLD_PASSWORD)).toBe(true);
  });

  it("takes the new password, keeps this device in, and ends the others", async () => {
    const user = await makePasswordUser();
    const before = await sessionCookie(user.id);
    // This GET warms the server process's user cache (30s TTL) under the old
    // epoch, which is what the changed epoch has to override.
    expect((await getSettings(before)).status).toBe(200);

    const res = await changePassword(before, {});
    // Success navigates (what a password manager watches for) and carries the
    // re-minted cookie for the session the change just invalidated.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/settings?password=changed#change-password",
    );
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("expense_session=");
    expect(cookie).not.toContain("Expires=Thu, 01 Jan 1970");

    // The credential moved: new password in, old one out.
    expect(await passwordWorks(user, NEW_PASSWORD)).toBe(true);
    expect(await passwordWorks(user, OLD_PASSWORD)).toBe(false);
    const row = await testPrisma.user.findUnique({
      where: { id: user.id },
      select: { credentialsChangedAt: true },
    });
    expect(row?.credentialsChangedAt).not.toBeNull();

    // Sessions minted under the old password are refused, including one the
    // server had already resolved; the cookie this response handed back is
    // the one that still works.
    const stale = await getSettings(before);
    expect(stale.status).toBe(302);
    expect(stale.headers.get("location")).toBe("/login?next=%2Fsettings");
    expect((await getSettings(cookie)).status).toBe(200);
  });

  it("revokes the connected apps and any pending reset link", async () => {
    const user = await makePasswordUser();
    await db.orm.public.OAuthClient.create({
      id: "client_pw_test",
      name: "Password Change Test",
      redirectUris: "[]",
      authMethod: "none",
      createdAt: nowWire(),
    });
    await db.orm.public.OAuthToken.create({
      tokenHash: `token_pw_${user.id}`,
      userId: user.id,
      clientId: "client_pw_test",
      _type: "access",
      scope: "read",
      expiresAt: nowWire(),
      createdAt: nowWire(),
    });
    // A reset link somebody asked for earlier is a credential that sets a
    // password without the new one, so the change has to consume it.
    await setUserPasswordResetToken(user.id, "pending-reset-token");

    await changePassword(await sessionCookie(user.id), {});

    const token = await db.orm.public.OAuthToken.where({
      tokenHash: `token_pw_${user.id}`,
    }).first();
    // Revoked, not deleted: the grant row is what Settings → Agents & API
    // lists, and the token is what stops working.
    expect(token?.revokedAt).not.toBeNull();
    expect(
      await resetUserPasswordWithToken("pending-reset-token", "another-one"),
    ).toEqual({ status: "invalid" });
  });

  it("publishes the change-password well-known URL", async () => {
    // The spec (w3c.github.io/webappsec-change-password-url) allows 302, 303
    // or 307 and forbids a permanent redirect, and the form itself must not
    // live at this path. No cookie: a password manager fetches it cold.
    const res = await fetch(`${BASE_URL}/.well-known/change-password`, {
      redirect: "manual",
    });
    expect([302, 303, 307]).toContain(res.status);
    const location = new URL(res.headers.get("location") ?? "", BASE_URL);
    expect(location.origin).toBe(BASE_URL);
    expect(location.pathname).toBe("/settings");
    expect(location.hash).toBe("#change-password");
  });

  it("changes the password from Settings, showing refusals inline", async () => {
    const user = await makePasswordUser();
    const page = await freshPage();
    await signIn(page, user.email, OLD_PASSWORD);
    // The well-known URL is what a password manager follows, so the browser
    // case starts there: it has to land on the form, signed in.
    await page.goto("/.well-known/change-password", { waitUntil: "load" });
    await waitForHydration(page);
    expect(new URL(page.url()).pathname).toBe("/settings");
    expect(new URL(page.url()).hash).toBe("#change-password");

    const section = page.locator("#change-password");
    await section.locator('input[name="currentPassword"]').fill("nope-nope");
    await section.locator('input[name="newPassword"]').fill(NEW_PASSWORD);
    await section.locator('input[name="confirmPassword"]').fill(NEW_PASSWORD);
    await section.locator('button[type="submit"]').click();
    await pwExpect(section.getByRole("alert")).toHaveText(
      "That password doesn't match.",
    );

    await section.locator('input[name="currentPassword"]').fill(OLD_PASSWORD);
    await section.locator('button[type="submit"]').click();
    // Success is a navigation, the signal password managers look for.
    await page.waitForURL(
      (url) => url.searchParams.get("password") === "changed",
    );
    await pwExpect(section.getByRole("status")).toContainText(
      "Password changed",
    );
    // The fields don't keep the new password around.
    await pwExpect(section.locator('input[name="newPassword"]')).toHaveValue(
      "",
    );
    await page.reload({ waitUntil: "load" });
    expect(new URL(page.url()).pathname).toBe("/settings");

    // And the new password is the one that signs in.
    const fresh = await freshPage();
    await signIn(fresh, user.email, NEW_PASSWORD);
    expect(new URL(fresh.url()).pathname).toBe("/");
  });
});
