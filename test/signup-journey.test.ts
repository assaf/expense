import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, describe, it } from "vitest";
import { ulid } from "ulid";
import { closeBrowser, freshPage, signIn } from "./helpers/launchBrowser";
import { signUp, verifyEmail } from "./helpers/signup-flows";
import { hashPassword } from "~/lib/passwords";
import { createAccount, createUser } from "~/lib/db/accounts";
import { testPrisma } from "./helpers/seedTestData";

/**
 * The two signup journeys a new user actually walks, end to end in the
 * browser against the spawned server:
 *
 * A. Landing page → create account → email verification link → sign in →
 *    upload a receipt and save it.
 * B. FastMail onboarding → paste an API token (mock JMAP session; the token
 *    is the credential, so the email verifies automatically) → set a
 *    password → land on the review inbox.
 *
 * The connect form on the Email page is covered too: it is the same token
 * verification the onboarding flow uses, but through the settings UI.
 * JMAP session calls resolve against the launchServer mock (see
 * launchServer.ts), so nothing here touches the network.
 */

describe("Signup journeys", () => {
  afterAll(async () => {
    await closeBrowser();
  });

  async function openPage(): Promise<Page> {
    return freshPage();
  }

  /** Seed a ready verified user directly (signup itself is covered by
   * journey A); returns the email for sign-in. */
  async function seedVerifiedUser(): Promise<string> {
    const email = `journey-seeded-${ulid().toLowerCase()}@example.com`;
    const account = await createAccount(`Journey seeded ${ulid()}`);
    await createUser({
      accountId: account.id,
      email,
      passwordHash: await hashPassword("seeded-password"),
      emailVerifiedAt: new Date().toISOString(),
    });
    return email;
  }

  it("lands, signs up, verifies, signs in, and files a receipt", async () => {
    const page = await openPage();
    const email = `journey-a-${ulid().toLowerCase()}@example.com`;
    try {
      // Landing page is public and carries the signup CTA.
      await page.goto("/", { waitUntil: "load", timeout: 15_000 });
      await expect(
        page.getByRole("heading", {
          name: "Every receipt, ready for tax season.",
        }),
      ).toBeVisible();
      await page
        .getByRole("link", { name: "Create your account" })
        .first()
        .click();
      await page.waitForURL(/\/login\?mode=create/, { timeout: 15_000 });

      await signUp(page, "Journey A", email, "journey-password");

      // The pending account cannot sign in yet.
      await page.goto("/login", { waitUntil: "load", timeout: 15_000 });
      await page.fill('input[name="email"]', email);
      await page.fill('input[name="password"]', "journey-password");
      await page.click('button[type="submit"]');
      await page.waitForSelector('button[type="submit"]:not([disabled])', {
        timeout: 10_000,
      });
      await expect(page.getByRole("alert")).toContainText("verify your email");

      await verifyEmail(page, email, `journey-a-${ulid()}-token`);
      await signIn(page, email, "journey-password");
      await expect(page.locator("h1")).toContainText("Expense");

      // Upload a receipt through the editor and save it.
      await page.getByRole("button", { name: "Receipt" }).click();
      await page.waitForURL(/\/expense\/new$/, { timeout: 10_000 });
      await page.waitForTimeout(100);
      const [resp] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().includes("/api/expense") && r.request().method() === "POST",
          { timeout: 30_000 },
        ),
        page.locator('input[type="file"]').setInputFiles({
          name: "journey-receipt.png",
          mimeType: "image/png",
          buffer: await tinyPng(),
        }),
      ]);
      expect(resp.ok()).toBeTruthy();
      await page.getByText("Save").click();
      await page.waitForURL((url) => url.pathname === "/", {
        timeout: 15_000,
      });

      const account = await testPrisma.account.findFirst({
        where: { users: { some: { email } } },
        select: { id: true },
      });
      const created = await testPrisma.expense.findFirst({
        where: { accountId: account?.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      expect(created).not.toBeNull();
      expect(created?.imageFile).not.toBe("");
    } finally {
      const account = await testPrisma.account.findFirst({
        where: { users: { some: { email } } },
        select: { id: true },
      });
      if (account)
        await testPrisma.account.delete({ where: { id: account.id } });
      await page.close();
    }
  });

  it("onboards through a FastMail token: verified account, connection, review inbox", async () => {
    const page = await openPage();
    // The mock derives the mailbox address from the token, so the account
    // is unique per run.
    const token = `fmu1-onboarding-${ulid()}`;
    let cleanupAccountId: string | undefined;
    try {
      await page.goto("/onboarding", { waitUntil: "load", timeout: 15_000 });
      await page.fill('input[name="token"]', token);
      await page.getByRole("button", { name: "Verify token" }).click();

      // Step 2: the token proved mailbox control, so only a password is
      // asked for; the email is the mock session's username.
      await expect(
        page.getByRole("heading", { name: "Set your password" }),
      ).toBeVisible({ timeout: 15_000 });
      await page.fill('input[name="password"]', "onboarding-password");
      await page.getByRole("button", { name: "Create my account" }).click();

      // Onboarding lands straight on the review inbox.
      await page.waitForURL(/\/email-review\?onboarding=1/, {
        timeout: 15_000,
      });
      await expect(
        page.getByRole("heading", { name: "Review inbox" }),
      ).toBeVisible();

      // The account came out verified with its mailbox connected. The
      // legacy test client has no include support, so query the sides
      // separately.
      const connection = await testPrisma.emailConnection.findFirst({
        where: { provider: "fastmail" },
        orderBy: { createdAt: "desc" },
      });
      expect(connection).not.toBeNull();
      cleanupAccountId = connection!.accountId as string;
      const user = await testPrisma.user.findFirst({
        where: { accountId: cleanupAccountId },
      });
      expect(user?.emailVerifiedAt).not.toBeNull();
      expect(user?.email).toMatch(/^mock-.*@fastmail\.test$/);
    } finally {
      if (cleanupAccountId)
        await testPrisma.account.delete({ where: { id: cleanupAccountId } });
      await page.close();
    }
  });

  it("connects a FastMail account from the Email page settings", async () => {
    const page = await openPage();
    const email = await seedVerifiedUser();
    const accountId = (
      await testPrisma.user.findUniqueOrThrow({
        where: { email },
        select: { accountId: true },
      })
    ).accountId;
    try {
      await signIn(page, email, "seeded-password");
      await page.goto("/emails", { waitUntil: "load", timeout: 15_000 });

      await page.fill('input[name="token"]', "test-settings-connect-token-1");
      await page.getByRole("button", { name: "Connect" }).click();
      await expect(page.getByRole("status")).toContainText(
        "connected; expenses will import automatically",
        { timeout: 15_000 },
      );

      // The connection is stored (token encrypted) against this account.
      const connection = await testPrisma.emailConnection.findFirst({
        where: { accountId },
      });
      expect(connection).not.toBeNull();
      expect(connection!.emailAddress).toMatch(/^mock-.*@fastmail\.test$/);
      expect(connection!.tokenEnc).not.toBe("");
    } finally {
      await testPrisma.account.delete({ where: { id: accountId } });
      await page.close();
    }
  });
});

/** A minimal valid PNG so the editor's draft-upload path (which runs OCR)
 * accepts the file. Same shape as the expenses suite's fixture. */
async function tinyPng(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: {
      width: 120,
      height: 60,
      channels: 3,
      background: { r: 245, g: 245, b: 245 },
    },
  })
    .png()
    .toBuffer();
}
