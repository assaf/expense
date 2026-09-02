import { randomBytes, scryptSync } from "node:crypto";
import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, describe, it } from "vitest";
import { ulid } from "ulid";
import { freshPage, closeBrowser, signIn } from "./helpers/launchBrowser";
import {
  OTHER_ACCOUNT_ID,
  TEST_ACCOUNT_ID,
  TEST_EMAIL,
  TEST_INVITE_CODE,
  TEST_PASSWORD,
  testPrisma,
} from "./helpers/seedTestData";
import { DEFAULT_CATEGORIES } from "~/lib/default-categories.server";
import { signUp, verifyEmail } from "./helpers/signup-flows";
import { hashPassword, hashToken, verifyPassword } from "~/lib/passwords";
import { createAccountWithUser } from "~/lib/auth.server";

describe("Access control", () => {
  afterAll(async () => {
    await closeBrowser();
  });

  /** A fresh context: no session cookie, no shared state. */
  async function openPage(): Promise<Page> {
    return freshPage();
  }

  /** A fresh context signed in as the seeded testuser. */
  async function signedInPage(): Promise<Page> {
    const page = await openPage();
    await signIn(page, TEST_EMAIL, TEST_PASSWORD);
    return page;
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
    // No GitHub link anywhere on the marketing site.
    await expect(page.getByRole("link", { name: /GitHub/ })).toHaveCount(0);
    // The app itself stays behind the session.
    await expect(page.getByText("Test Store")).not.toBeVisible();
    await page.close();
  });

  it("denies framing on every page with real HTTP headers", async () => {
    const page = await openPage();
    const res = await page.request.get("http://localhost:5199/login");
    expect(res.headers()["x-frame-options"]).toBe("DENY");
    expect(res.headers()["content-security-policy"]).toContain(
      "frame-ancestors",
    );
    await page.close();
  });

  it("blocks cross-site POSTs to the auth actions (login CSRF)", async () => {
    const page = await openPage();
    // A foreign Origin must be rejected outright, even with valid creds.
    // React Router's own action-origin check rejects it with 400 before
    // the route runs (Origin host vs request host); the action-only
    // /sign-out route bypasses that framework check, so our
    // rejectCrossSitePost answers 403 there.
    const foreign = await page.request.post("http://localhost:5199/login", {
      form: { mode: "signin", email: TEST_EMAIL, password: TEST_PASSWORD },
      headers: { origin: "https://evil.example" },
    });
    expect(foreign.status()).toBe(400);
    const foreignSignOut = await page.request.post(
      "http://localhost:5199/sign-out",
      { headers: { origin: "https://evil.example" } },
    );
    expect(foreignSignOut.status()).toBe(403);

    // A request with no Origin header (curl, same-origin fetch) still works.
    const plain = await page.request.post("http://localhost:5199/login", {
      form: { mode: "signin", email: TEST_EMAIL, password: TEST_PASSWORD },
    });
    expect(plain.status()).toBe(200);
    await page.close();
  });
  it("refuses a re-signup while the verification email is fresh, keeping the sent link alive", async () => {
    const page = await openPage();
    const email = `replace-throttle-${ulid()}@example.com`.toLowerCase();
    await signUp(page, "Replace Throttle", email, TEST_PASSWORD);
    // A second signup for the same address inside the once-a-day resend
    // window is refused instead of deleting the pending account and
    // re-sending: an unlimited replace loop is unlimited verification
    // email on demand. The refusal keeps the original row, so the link
    // already in the inbox still verifies.
    // Same flow as signUp, but the server refuses inside the resend
    // window: the form re-renders with the error instead of the
    // "Check your email" screen.
    await page.goto("/login", { waitUntil: "load", timeout: 15_000 });
    await page.getByRole("button", { name: "Create a new account" }).click();
    await page.fill('input[name="accountName"]', "Replace Again");
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page.getByRole("alert")).toContainText(/verification link/i, {
      timeout: 15_000,
    });
    await verifyEmail(page, email, `still-live-${ulid()}`);
    await page.close();
  });

  it("caps successful signups per IP, not just failures", async () => {
    const page = await openPage();
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 2}`;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await page.request.post("http://localhost:5199/login", {
        form: {
          mode: "create",
          accountName: `Rate Limit ${i}`,
          email: `ratelimit-${ulid()}@example.com`,
          password: TEST_PASSWORD,
        },
        headers: { "x-forwarded-for": ip },
      });
      statuses.push(res.status());
    }
    // Five attempts consume the per-IP budget (successes count too, since
    // each sends real email); the sixth is locked before any work.
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBeGreaterThanOrEqual(500);
    await page.close();
  });

  it("navigates from the landing footer to public pages without a login redirect", async () => {
    // Client-side Link clicks fetch /<page>.data, so the root loader must
    // recognize those as the public page, or every footer link bounces
    // anonymous visitors to /login?next=... (regression: root loader only
    // matched the bare path).
    const page = await openPage();
    await page.goto("/", { waitUntil: "load", timeout: 15_000 });
    for (const [label, path] of [
      ["About", "/about"],
      ["AI", "/ai"],
      ["MCP", "/connect"],
      ["FAQ", "/faq"],
      ["Compare", "/alternatives"],
      ["Mileage", "/mileage-rates"],
    ] as const) {
      await page
        .getByRole("link", { name: label, exact: true })
        .first()
        .click();
      await page.waitForURL((url) => url.pathname === path, {
        timeout: 15_000,
      });
      // The page actually rendered, not a redirect to /login.
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
    // in; the login path must upgrade the row to the self-describing
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
      verifyPassword(TEST_PASSWORD, (row?.passwordHash ?? "") as string),
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
    const page = await freshPage();
    // Unauthenticated: the export endpoint must not hand out the PDF.
    const res = await page.request.get("/export/report/2026%20Test.pdf", {
      maxRedirects: 0,
    });
    expect([302, 401, 404]).toContain(res.status());
    await page.context().close();
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
    // A new account starts empty: none of the seeded data may appear.
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
    // The signup email starts PENDING; receipts are only accepted after it
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
    // The pending account can't sign in, so the login page says why and
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
        // A re-signup is refused while the emailed link is fresh (the
        // once-a-day window); an email from yesterday can still be replaced.
        verificationSentAt: new Date(
          Date.now() - 25 * 60 * 60 * 1000,
        ).toISOString(),
      },
    });

    // The user typed the wrong password: back to the signup page with the
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

    // The old verification link is dead; the re-signup discarded it.
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

  /** Create a verified user row directly (no email round trip) with a real
   * password hash so correct-password logins work. Returns the account id
   * for cleanup. */
  async function createVerifiedUser(
    email: string,
    password: string,
  ): Promise<string> {
    const accountId = `lock-account-${ulid()}`;
    const now = new Date().toISOString();
    await testPrisma.account.create({
      data: {
        id: accountId,
        name: `Lock Test ${ulid()}`,
        inviteCode: `LK${ulid()}`.toUpperCase(),
        createdAt: now,
      },
    });
    await testPrisma.user.create({
      data: {
        id: `lock-user-${ulid()}`,
        accountId,
        // Stored lowercase, exactly like a real signup (the login route
        // normalizes before insert/lookup).
        email: email.toLowerCase(),
        passwordHash: await hashPassword(password),
        emailVerifiedAt: now,
        createdAt: now,
      },
    });
    return accountId;
  }

  async function attemptSignIn(
    page: Page,
    email: string,
    password: string,
  ): Promise<void> {
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForSelector('button[type="submit"]:not([disabled])', {
      timeout: 10_000,
    });
  }

  /** Poll the auth_attempts row until the server has recorded the expected
   * failure count. The browser alert text is identical across wrong
   * attempts, so the DB is the only unambiguous signal that the previous
   * request finished server-side before the next one fires. */
  async function waitForFailures(
    key: string,
    minFailures: number,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const row = await testPrisma.authAttempt.findUnique({ where: { key } });
      if (row && (row.failures as number) >= minFailures) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `auth_attempts row ${key} never reached ${minFailures} failures`,
    );
  }

  it("locks the account after five failed sign-ins (brute-force guard)", async () => {
    const email = `lockout-${ulid()}@example.com`;
    const password = "correct-password";
    const accountId = await createVerifiedUser(email, password);
    // login() normalizes the email to lowercase before keying the counter.
    const lockKey = `login:${email.toLowerCase()}`;
    const page = await openPage();
    await page.goto("/login", { waitUntil: "load", timeout: 15_000 });
    try {
      for (let i = 0; i < 5; i += 1) {
        await attemptSignIn(page, email, "wrong-password");
        // Wait for THIS attempt to be recorded before the next click.
        await waitForFailures(lockKey, i + 1);
      }
      // The lockout check runs BEFORE the password check, so even the
      // correct password is rejected while the account is locked.
      await attemptSignIn(page, email, password);
      await expect(page.getByRole("alert")).toContainText(
        "Too many failed attempts",
      );
      const row = await testPrisma.authAttempt.findUnique({
        where: { key: lockKey },
      });
      expect(row).not.toBeNull();
      expect(row!.failures).toBeGreaterThanOrEqual(5);
      expect(row!.lockedUntil).not.toBeNull();
    } finally {
      await page.close();
      await testPrisma.authAttempt.deleteMany({ where: { key: lockKey } });
      await testPrisma.account.deleteMany({ where: { id: accountId } });
    }
  });

  it("lifts the lock once the lock window has passed", async () => {
    const email = `lockout-expired-${ulid()}@example.com`;
    const password = "correct-password";
    const accountId = await createVerifiedUser(email, password);
    // login() normalizes the email to lowercase before keying the counter.
    const lockKey = `login:${email.toLowerCase()}`;
    const now = Date.now();
    await testPrisma.authAttempt.create({
      data: {
        key: lockKey,
        failures: 5,
        windowStart: new Date(now - 60_000).toISOString(),
        lockedUntil: new Date(now - 1_000).toISOString(), // already expired
        updatedAt: new Date(now).toISOString(),
      },
    });
    const page = await openPage();
    try {
      await signIn(page, email, password);
      // A successful login clears the failure row.
      // performance.now(): the suite freezes Date, so a Date.now() deadline
      // would never advance.
      const deadline = performance.now() + 10_000;
      while (performance.now() < deadline) {
        const row = await testPrisma.authAttempt.findUnique({
          where: { key: lockKey },
        });
        if (row === null) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const row = await testPrisma.authAttempt.findUnique({
        where: { key: lockKey },
      });
      expect(row).toBeNull();
    } finally {
      await page.close();
      await testPrisma.authAttempt.deleteMany({ where: { key: lockKey } });
      await testPrisma.account.deleteMany({ where: { id: accountId } });
    }
  });

  it("rejects a password longer than 128 characters at signup", async () => {
    // Exercised at the boundary (createAccountWithUser) rather than through
    // the form, because the password input's maxLength truncates typed
    // values before they reach the validator.
    await expect(
      createAccountWithUser({
        accountName: "Long Password Co",
        email: `longpass-${ulid()}@example.com`,
        password: "a".repeat(200),
      }),
    ).rejects.toThrow("Password must be at most 128 characters");
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
  return row.id as string;
}
