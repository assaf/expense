import { expect } from "playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { signIn } from "./helpers/launchBrowser";
import {
  OTHER_ACCOUNT_ID,
  TEST_INVITE_CODE,
  TEST_PASSWORD,
  TEST_USERNAME,
  testPrisma,
} from "./helpers/seedTestData";

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
    await signIn(page, TEST_USERNAME, TEST_PASSWORD);
    return page;
  }

  it("redirects unauthenticated visitors to /login", async () => {
    const page = await openPage();
    await page.goto("/", { waitUntil: "load", timeout: 15_000 });
    await expect(page).toHaveURL(/\/login$/);
    await expect(
      page.getByRole("heading", { name: "Sign in to Expense" }),
    ).toBeVisible();
    await page.close();
  });

  it("rejects a wrong password with an error", async () => {
    const page = await openPage();
    await page.goto("/login", { waitUntil: "load", timeout: 15_000 });
    await page.fill('input[name="username"]', TEST_USERNAME);
    await page.fill('input[name="password"]', "definitely-wrong");
    await page.click('button[type="submit"]');
    await expect(page.getByRole("alert")).toContainText(
      "Invalid username or password",
    );
    await expect(page).toHaveURL(/\/login$/);
    await page.close();
  });

  it("signs in with the seeded credentials", async () => {
    const page = await signedInPage();
    await expect(page.locator("h1")).toContainText("Expenses");
    await expect(page.getByText("Test Store")).toBeVisible();
    await page.close();
  });

  it("signs out from settings and locks the app again", async () => {
    const page = await signedInPage();
    await page.goto("/settings", { waitUntil: "load", timeout: 15_000 });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/login$/, { timeout: 15_000 });

    // A subsequent visit must be blocked again.
    await page.goto("/", { waitUntil: "load", timeout: 15_000 });
    await expect(page).toHaveURL(/\/login$/);
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
    await page.goto("/login", { waitUntil: "load", timeout: 15_000 });
    await page.getByRole("button", { name: "Create a new account" }).click();
    await page.fill('input[name="accountName"]', "Fresh Account");
    await page.fill('input[name="userName"]', "Fresh Person");
    await page.fill('input[name="username"]', "freshuser");
    await page.fill('input[name="password"]', "fresh-password");
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => url.pathname === "/", {
      timeout: 15_000,
    });
    await expect(page.locator("h1")).toContainText("Expenses");
    // A new account starts empty — none of the seeded data may appear.
    await expect(page.getByText("Test Store")).not.toBeVisible();
    await page.close();
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
    await page.fill('input[name="userName"]', "Second User");
    await page.fill('input[name="username"]', "seconduser");
    await page.fill('input[name="password"]', "second-password");
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => url.pathname === "/", {
      timeout: 15_000,
    });
    // Joining the test account means seeing its expenses.
    await expect(page.getByText("Test Store")).toBeVisible();
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
    await page.fill('input[name="userName"]', "Third User");
    await page.fill('input[name="username"]', "thirduser");
    await page.fill('input[name="password"]', "third-password");
    await page.click('button[type="submit"]');
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
