import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expect as pwExpect } from "playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { ulid } from "ulid";
import { TEST_EMAIL, seedTestData, testPrisma } from "./helpers/seedTestData";
import { freezePageClock } from "./helpers/launchBrowser";
import { createAccount, createUser } from "~/lib/db/accounts";
import { hashPassword, hashToken } from "~/lib/passwords";
import {
  login,
  requestPasswordReset,
  resetPasswordWithToken,
} from "~/lib/auth.server";

/**
 * Password recovery: request an emailed single-use link, set a new password
 * with it. The email transport is never hit (the test env has no public
 * origin / skips sends), so these tests assert the token lifecycle and the
 * password swap.
 */

const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a brand new password";

async function seedUser(email: string, password = PASSWORD) {
  const account = await createAccount(`Reset ${ulid()}`);
  const user = await createUser({
    accountId: account.id,
    email,
    passwordHash: await hashPassword(password),
    emailVerifiedAt: new Date().toISOString(),
  });
  return { account, user };
}

/** Pin the row's reset-token hash to a known token (the app mints tokens
 * internally and emails them; tests can't see the raw token otherwise). */
async function pinResetToken(userId: string, rawToken: string) {
  await testPrisma.user.update({
    where: { id: userId },
    data: {
      passwordResetTokenHash: hashToken(rawToken),
      passwordResetSentAt: new Date().toISOString(),
    },
  });
}

describe("password reset", () => {
  it("emails a reset link (mints a hashed, fresh token) and rate-limits re-sends", async () => {
    const email = `reset-${ulid().toLowerCase()}@example.com`;
    await seedUser(email);
    await requestPasswordReset(email);

    const after = await testPrisma.user.findUnique({ where: { email } });
    expect(after?.passwordResetTokenHash).toBeTruthy();
    expect(after?.passwordResetSentAt).toBeTruthy();
    const firstHash = after!.passwordResetTokenHash;

    // A second request within the resend window must not re-mint.
    await requestPasswordReset(email);
    const second = await testPrisma.user.findUnique({ where: { email } });
    expect(second?.passwordResetTokenHash).toBe(firstHash);
  });

  it("sets the new password, clears the token, and makes login work", async () => {
    const email = `reset-${ulid().toLowerCase()}@example.com`;
    const { user } = await seedUser(email);
    const token = "reset-token-1";
    await pinResetToken(user.id, token);

    const result = await resetPasswordWithToken(token, NEW_PASSWORD);
    expect(result.email).toBe(email);

    const row = await testPrisma.user.findUnique({ where: { email } });
    expect(row?.passwordResetTokenHash).toBeNull();
    expect(row?.passwordResetSentAt).toBeNull();

    // Old password dead, new password signs in.
    await expect(login(email, PASSWORD)).rejects.toThrow();
    const cookie = await login(email, NEW_PASSWORD);
    expect(cookie).toContain("expense_session");
  });

  it("is single-use: a replayed link fails after the reset", async () => {
    const email = `reset-${ulid().toLowerCase()}@example.com`;
    const { user } = await seedUser(email);
    const token = "reset-token-2";
    await pinResetToken(user.id, token);

    await resetPasswordWithToken(token, NEW_PASSWORD);
    await expect(
      resetPasswordWithToken(token, "yet another password"),
    ).rejects.toThrow(/no longer valid/);
  });

  it("rejects an expired link and clears it", async () => {
    const email = `reset-${ulid().toLowerCase()}@example.com`;
    const { user } = await seedUser(email);
    const token = "reset-token-3";
    await pinResetToken(user.id, token);
    // Expire it: 8 days before the suite's pinned now.
    await testPrisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetSentAt: new Date(
          Date.now() - 8 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
    });

    await expect(resetPasswordWithToken(token, NEW_PASSWORD)).rejects.toThrow(
      /expired/,
    );

    const row = await testPrisma.user.findUnique({ where: { email } });
    expect(row?.passwordResetTokenHash).toBeNull();
  });

  it("rejects a bad password without consuming the live link", async () => {
    const email = `reset-${ulid().toLowerCase()}@example.com`;
    const { user } = await seedUser(email);
    const token = "reset-token-4";
    await pinResetToken(user.id, token);

    await expect(resetPasswordWithToken(token, "short")).rejects.toThrow(
      /at least 8/,
    );

    // The token survives; the user can retry.
    const row = await testPrisma.user.findUnique({ where: { email } });
    expect(row?.passwordResetTokenHash).toBe(hashToken(token));
  });

  it("is a silent no-op for unknown or unverified accounts", async () => {
    const email = `reset-${ulid().toLowerCase()}@example.com`;
    await expect(requestPasswordReset(email)).resolves.toBeUndefined();
    const rows = await testPrisma.user.findMany({ where: { email } });
    expect(rows).toHaveLength(0);

    // Unverified account: skip (the verification link is the recovery).
    const pendingEmail = `reset-${ulid().toLowerCase()}@example.com`;
    const account = await createAccount(`Reset ${ulid()}`);
    await createUser({
      accountId: account.id,
      email: pendingEmail,
      passwordHash: await hashPassword(PASSWORD),
      emailVerifiedAt: null,
    });
    await requestPasswordReset(pendingEmail);
    const pending = await testPrisma.user.findUnique({
      where: { email: pendingEmail },
    });
    expect(pending?.passwordResetTokenHash).toBeNull();
  });
});

describe("password reset UI", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  async function openPage(): Promise<Page> {
    const context = await browser.newContext({
      baseURL: "http://localhost:5199",
    });
    const page = await context.newPage();
    await freezePageClock(page);
    return page;
  }

  it("links from the login page and shows the generic inbox state", async () => {
    await seedTestData();
    const page = await openPage();
    await page.goto("/login", { waitUntil: "load" });
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await pwExpect(page).toHaveURL(/\/reset-password/);
    await pwExpect(
      page.getByRole("heading", { name: "Reset your password" }),
    ).toBeVisible();

    await page.getByLabel("Email").fill(TEST_EMAIL);
    await page.getByRole("button", { name: "Email a reset link" }).click();
    await pwExpect(
      page.getByRole("heading", { name: "Check your inbox" }),
    ).toBeVisible();
    await page.close();
  });
  it("caps reset attempts per IP (scrypt runs only for live tokens)", async () => {
    const page = await openPage();
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 2}`;
    // Five invalid-token attempts burn the per-IP budget; each pays a
    // token lookup, never a scrypt derivation. The sixth is locked before
    // any work and surfaces as the error boundary.
    for (let i = 0; i < 5; i++) {
      const res = await page.request.post("/reset-password", {
        form: {
          intent: "reset",
          token: `wrong-${ulid()}`,
          email: `reset-${ulid().toLowerCase()}@example.com`,
          password: "a valid password",
        },
        headers: { "x-forwarded-for": ip },
      });
      expect(res.status()).toBe(200);
    }
    const locked = await page.request.post("/reset-password", {
      form: {
        intent: "reset",
        token: `wrong-${ulid()}`,
        email: `reset-${ulid().toLowerCase()}@example.com`,
        password: "a valid password",
      },
      headers: { "x-forwarded-for": ip },
    });
    expect(locked.status()).toBeGreaterThanOrEqual(500);
    await page.close();
  });
});

afterAll(async () => {
  await testPrisma.$disconnect();
});
