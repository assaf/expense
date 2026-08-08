import { randomBytes, scryptSync } from "node:crypto";
import { expect } from "playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { signIn } from "./helpers/launchBrowser";
import {
  OTHER_ACCOUNT_ID,
  TEST_ACCOUNT_ID,
  TEST_EMAIL,
  TEST_INVITE_CODE,
  TEST_PASSWORD,
  testPrisma,
} from "./helpers/seedTestData";
import { DEFAULT_CATEGORIES } from "~/lib/default-categories.server";
import { hashToken, verifyPassword } from "~/lib/passwords";

const baseURL = process.env.TEST_BASE_URL ?? "http://localhost:5199";

describe("Access control", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  /** A fresh context — no session cookie, no shared state. */
  async function openPage(): Promise<Page> {
    const context = await browser.newContext({ baseURL });
    return context.newPage();
  }

  /** A fresh context signed in as the seeded testuser. */
  async function signedInPage(): Promise<Page> {
    const page = await openPage();
    await signIn(page, TEST_EMAIL, TEST_PASSWORD);
    return page;
  }

  /** Fill the signup form and submit; expect the pending "check your
   * email" state — signup never signs the user in anymore. */
  async function signUp(
    page: Page,
    accountName: string,
    email: string,
    password: string,
  ): Promise<void> {
    await page.goto("/login", { waitUntil: "load", timeout: 15_000 });
    await page.getByRole("button", { name: "Create a new account" }).click();
    await page.fill('input[name="accountName"]', accountName);
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');
    // Wait for the form submission to finish — the button re-enables when
    // the action resolves. Without this, the "Check your email" assert
    // races against the server round-trip and flakes under load.
    await page.waitForSelector('button[type="submit"]:not([disabled])', {
      timeout: 15_000,
    });
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
  }

  /** Complete email verification for a user: the app mints tokens
   * internally and never exposes them, so the test pins the row's hash to
   * a known token, then clicks the real /verify-email route. */
  async function verifyEmail(
    page: Page,
    email: string,
    rawToken: string,
  ): Promise<void> {
    const user = await testPrisma.user.findUnique({ where: { email } });
    if (!user) throw new Error(`No user row for ${email}`);
    await testPrisma.user.update({
      where: { id: user.id },
      data: {
        verificationTokenHash: hashToken(rawToken),
        verificationSentAt: new Date().toISOString(),
      },
    });
    await page.goto(`/verify-email?token=${rawToken}`, {
      waitUntil: "load",
      timeout: 15_000,
    });
    await expect(page.locator("h1")).toContainText("verified");
  }

  it("shows the landing page to unauthenticated visitors", async () => {
    const page = await openPage();
    await page.goto("/", { waitUntil: "load", timeout: 15_000 });
    await expect(
      page.getByRole("heading", {
        name: "Every receipt, ready for tax season.",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Create your account" }).first(),
    ).toHaveAttribute("href", "/login?mode=create");
    await expect(
      page.getByRole("link", { name: /GitHub/ }).first(),
    ).toHaveAttribute("href", "https://github.com/assaf/expense");
    // The app itself stays behind the session.
    await expect(page.getByText("Test Store")).not.toBeVisible();
    await page.close();
  });

  it("navigates from the landing footer to public pages without a login redirect", async () => {
    // Client-side Link clicks fetch /<page>.data — the root loader must
    // recognize those as the public page, or every footer link bounces
    // anonymous visitors to /login?next=... (regression: root loader only
    // matched the bare path).
    const page = await openPage();
    await page.goto("/", { waitUntil: "load", timeout: 15_000 });
    for (const [label, path] of [
      ["About", "/about"],
      ["AI", "/ai"],
      ["FAQ", "/faq"],
      ["Compare", "/alternatives"],
    ] as const) {
      await page
        .getByRole("link", { name: label, exact: true })
        .first()
        .click();
      await page.waitForURL((url) => url.pathname === path, {
        timeout: 15_000,
      });
      // The page actually rendered — not a redirect to /login.
      await expect(
        page.getByRole("heading", { level: 1 }).first(),
      ).toBeVisible();
      await page.goto("/", { waitUntil: "load", timeout: 15_000 });
    }
    await page.close();
  });

  it("deep-links the landing CTA straight to the signup form", async () => {
    const page = await openPage();
    await page.goto("/login?mode=create", {
      waitUntil: "load",
      timeout: 15_000,
    });
    await expect(
      page.getByRole("heading", { name: "Create your account" }),
    ).toBeVisible();
    await expect(page.getByLabel("Account name")).toBeVisible();
    await page.close();
  });

  it("rejects a wrong password with an error", async () => {
    const page = await openPage();
    await page.goto("/login", { waitUntil: "load", timeout: 15_000 });
    await page.fill('input[name="email"]', TEST_EMAIL);
    await page.fill('input[name="password"]', "definitely-wrong");
    await page.click('button[type="submit"]');
    await page.waitForSelector('button[type="submit"]:not([disabled])', {
      timeout: 10_000,
    });
    await expect(page.getByRole("alert")).toContainText(
      "Invalid email or password",
    );
    await expect(page).toHaveURL(/\/login$/);
    await page.close();
  });

  it("signs in with the seeded credentials", async () => {
    const page = await signedInPage();
    await expect(page.locator("h1")).toContainText("Expense");
    await expect(page.getByText("Test Store")).toBeVisible();
    await page.close();
  });

  it("rehashes a legacy password hash to the current scrypt cost on login", async () => {
    // Rewrite the seeded user's stored hash to the pre-format-change shape
    // (hex `salt:hash` derived with Node's default scrypt cost), then sign
    // in — the login path must upgrade the row to the self-describing
    // format while still accepting the same password.
    const salt = randomBytes(16).toString("hex");
    const legacyHash = `${salt}:${scryptSync(TEST_PASSWORD, salt, 64).toString("hex")}`;
    await testPrisma.user.update({
      where: { id: "user_test1" },
      data: { passwordHash: legacyHash },
    });

    const page = await openPage();
    await signIn(page, TEST_EMAIL, TEST_PASSWORD);
    await page.close();

    const row = await testPrisma.user.findUnique({
      where: { id: "user_test1" },
      select: { passwordHash: true },
    });
    expect(row?.passwordHash).toMatch(/^\$scrypt\$N=65536,r=8,p=1\$/);
    await expect(
      verifyPassword(TEST_PASSWORD, row?.passwordHash ?? ""),
    ).resolves.toBe(true);
  });

  it("signs out from settings and locks the app again", async () => {
    const page = await signedInPage();
    await page.goto("/settings", { waitUntil: "load", timeout: 15_000 });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/login$/, { timeout: 15_000 });

    // A subsequent visit shows the landing page, not the app.
    await page.goto("/", { waitUntil: "load", timeout: 15_000 });
    await expect(
      page.getByRole("heading", {
        name: "Every receipt, ready for tax season.",
      }),
    ).toBeVisible();
    await page.close();
  });

  it("protects resource routes (PDF export) too", async () => {
    const context = await browser.newContext({ baseURL });
    // Unauthenticated: the export endpoint must not hand out the PDF.
    const res = await context.request.get("/export/report/2026%20Test.pdf", {
      maxRedirects: 0,
    });
    expect([302, 401, 404]).toContain(res.status());
    await context.close();
  });

  it("creates a brand-new account at signup with no shared data", async () => {
    const page = await openPage();
    await signUp(
      page,
      "Fresh Account",
      "freshuser@example.com",
      "fresh-password",
    );
    await verifyEmail(page, "freshuser@example.com", "fresh-verify-token");
    await signIn(page, "freshuser@example.com", "fresh-password");
    await expect(page.locator("h1")).toContainText("Expense");
    // A new account starts empty — none of the seeded data may appear.
    await expect(page.getByText("Test Store")).not.toBeVisible();
    await page.close();
  });

  it("seeds the IRS Schedule C default categories at signup", async () => {
    const page = await openPage();
    await signUp(
      page,
      "IRS Fresh",
      "irsfreshuser@example.com",
      "irs-fresh-password",
    );
    await page.close();

    const user = await testPrisma.user.findUnique({
      where: { email: "irsfreshuser@example.com" },
    });
    if (!user) throw new Error("No irsfreshuser row after signup");
    const names = (
      await testPrisma.category.findMany({
        where: { accountId: user.accountId },
        orderBy: { id: "asc" },
        select: { name: true },
      })
    ).map((c) => c.name);
    expect(names).toEqual(DEFAULT_CATEGORIES);

    // The seeded accounts keep their hand-picked categories, not the defaults.
    const testAccountNames = (
      await testPrisma.category.findMany({
        where: { accountId: TEST_ACCOUNT_ID },
        select: { name: true },
      })
    ).map((c) => c.name);
    expect(testAccountNames).not.toContain(DEFAULT_CATEGORIES[0]);
  });

  it("defaults the signup email as an allowed receipts-by-email sender", async () => {
    const page = await openPage();
    await signUp(
      page,
      "Sender Fresh",
      "senderfresh@example.com",
      "sender-fresh-password",
    );
    await page.close();

    const user = await testPrisma.user.findUnique({
      where: { email: "senderfresh@example.com" },
    });
    if (!user) throw new Error("No senderfresh row after signup");
    const senders = await testPrisma.inboundSender.findMany({
      where: { accountId: user.accountId },
      select: { address: true },
    });
    expect(senders.map((s) => s.address)).toEqual(["senderfresh@example.com"]);
    // The signup email starts PENDING — receipts are only accepted after it
    // is verified by clicking the emailed link.
    const verifications = await testPrisma.inboundSenderVerification.findMany({
      where: { accountId: user.accountId },
    });
    expect(verifications).toHaveLength(0);
  });

  it("joins an account with its invite code and shares its data", async () => {
    const page = await openPage();
    await page.goto("/login", { waitUntil: "load", timeout: 15_000 });
    await page
      .getByRole("button", {
        name: "Join an existing account with an invite code",
      })
      .click();
    await page.fill('input[name="inviteCode"]', TEST_INVITE_CODE);
    await page.fill('input[name="email"]', "seconduser@example.com");
    await page.fill('input[name="password"]', "second-password");
    await page.click('button[type="submit"]');
    // Joining also requires email verification before the first sign-in.
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
    await verifyEmail(page, "seconduser@example.com", "join-verify-token");
    await signIn(page, "seconduser@example.com", "second-password");
    // Joining the test account means seeing its expenses.
    await expect(page.getByText("Test Store")).toBeVisible();
    await page.close();
  });

  it("blocks sign-in until the email is verified", async () => {
    const page = await openPage();
    await signUp(
      page,
      "Unverified Co",
      "unverifieduser@example.com",
      "unverified-password",
    );
    // The pending account can't sign in — the login page says why and
    // offers a resend button.
    await page.goto("/login", { waitUntil: "load", timeout: 15_000 });
    await page.fill('input[name="email"]', "unverifieduser@example.com");
    await page.fill('input[name="password"]', "unverified-password");
    await page.click('button[type="submit"]');
    await page.waitForSelector('button[type="submit"]:not([disabled])', {
      timeout: 10_000,
    });
    await expect(page.getByRole("alert")).toContainText("verify your email");
    await expect(
      page.getByRole("button", { name: "Resend verification email" }),
    ).toBeVisible();
    // After clicking the emailed link, the same credentials work.
    await verifyEmail(page, "unverifieduser@example.com", "uv-verify-token");
    await signIn(page, "unverifieduser@example.com", "unverified-password");
    await expect(page.locator("h1")).toContainText("Expense");
    await page.close();
  });

  it("re-signing up with an unverified email replaces the account and discards the old verification link", async () => {
    const page = await openPage();
    await signUp(page, "First Try", "retryuser@example.com", "first-password");
    const firstUser = await testPrisma.user.findUnique({
      where: { email: "retryuser@example.com" },
    });
    if (!firstUser) throw new Error("No first user row");
    const firstAccountId = firstUser.accountId;
    // Pin the first verification link to a known token so we can prove it
    // stops working after the re-signup.
    await testPrisma.user.update({
      where: { id: firstUser.id },
      data: {
        verificationTokenHash: hashToken("old-link-token"),
        verificationSentAt: new Date().toISOString(),
      },
    });

    // The user typed the wrong password — back to the signup page with the
    // same email and a new password. The unverified account is replaced.
    await signUp(
      page,
      "Second Try",
      "retryuser@example.com",
      "second-password",
    );
    const secondUser = await testPrisma.user.findUnique({
      where: { email: "retryuser@example.com" },
    });
    if (!secondUser) throw new Error("No second user row");
    expect(secondUser.id).not.toBe(firstUser.id);
    expect(secondUser.accountId).not.toBe(firstAccountId);
    expect(secondUser.verificationTokenHash).not.toBe(
      firstUser.verificationTokenHash,
    );
    // The throwaway first account is gone entirely.
    await expect(
      testPrisma.account.findUnique({ where: { id: firstAccountId } }),
    ).resolves.toBeNull();

    // The old verification link is dead — the re-signup discarded it.
    await page.goto("/verify-email?token=old-link-token", {
      waitUntil: "load",
      timeout: 15_000,
    });
    await expect(page.locator("h1")).toContainText("not valid");
    // The new link works, and the new password is the one that signs in.
    await verifyEmail(page, "retryuser@example.com", "new-link-token");
    await signIn(page, "retryuser@example.com", "second-password");
    await expect(page.locator("h1")).toContainText("Expense");
    await page.close();
  });

  it("rejects an invalid invite code", async () => {
    const page = await openPage();
    await page.goto("/login", { waitUntil: "load", timeout: 15_000 });
    await page
      .getByRole("button", {
        name: "Join an existing account with an invite code",
      })
      .click();
    await page.fill('input[name="inviteCode"]', "NOPE1234");
    await page.fill('input[name="email"]', "thirduser@example.com");
    await page.fill('input[name="password"]', "third-password");
    await page.click('button[type="submit"]');
    await page.waitForSelector('button[type="submit"]:not([disabled])', {
      timeout: 10_000,
    });
    await expect(page.getByRole("alert")).toContainText(
      "That invite code is not valid",
    );
    await page.close();
  });

  it("never exposes another account's expenses, reports, or PDFs", async () => {
    const page = await signedInPage();

    // The other account's expense is invisible on the home page.
    await expect(page.getByText("Test Store")).toBeVisible();
    await expect(page.getByText("Secret Corp")).not.toBeVisible();

    // Its report does not appear in the export list.
    await page.goto("/export", { waitUntil: "load", timeout: 15_000 });
    await expect(page.getByText("Private Report")).not.toBeVisible();

    // Direct URLs to the other account's data must 404.
    const otherId = await otherExpenseId();
    await page.goto(`/expense/${otherId}`, { waitUntil: "load" });
    await expect(page.locator("h1")).toContainText("404");

    const pdfRes = await page.request.get(
      "/export/report/Private%20Report.pdf",
      { maxRedirects: 0 },
    );
    expect(pdfRes.status()).toBe(404);
    await page.close();
  });
});

/** Grab an expense id from the second (isolation) account. */
async function otherExpenseId(): Promise<string> {
  const row = await testPrisma.expense.findFirst({
    where: { accountId: OTHER_ACCOUNT_ID },
    select: { id: true },
  });
  if (!row) throw new Error("No isolation expense seeded");
  return row.id;
}
