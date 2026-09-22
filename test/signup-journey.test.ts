import { expect } from "playwright/test";
import { afterAll, describe, it } from "vite-plus/test";
import { ulid } from "ulid";
import { closeBrowser, freshPage, signIn } from "./helpers/launchBrowser";
import { signUp, verifyEmail } from "./helpers/signup-flows";
import { sessionStorage } from "~/lib/auth.server";
import { FM_PENDING_SESSION_KEY } from "~/lib/fastmail-oauth.server";
import { encryptSecret } from "~/lib/token-crypto.server";
import { testPrisma } from "./helpers/seedTestData";

/**
 * The two signup journeys a new user actually walks, end to end in the
 * browser against the spawned server:
 *
 * A. Landing page → create account → email verification link → sign in →
 *    upload a receipt and save it.
 * B. Fastmail onboarding → set a password and land on the review inbox,
 *    starting from the state the OAuth callback leaves on the session
 *    (connected mailbox, credentials parked encrypted). The provider round
 *    trip needs a real consent, so it stays out of the browser suite and is
 *    covered by fastmail-oauth.test.ts.
 */

describe("Signup journeys", () => {
  afterAll(async () => {
    await closeBrowser();
  });

  it("lands, signs up, verifies, signs in, and files a receipt", async () => {
    const page = await freshPage();
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
      await page.waitForURL((url) => url.pathname === "/expenses", {
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

  it("onboards from a connected mailbox: verified account, connection, review inbox", async () => {
    const page = await freshPage();
    // The mailbox arrives through the provider's OAuth flow, so what the
    // browser can walk here starts where that callback leaves off: the
    // encrypted credentials parked on the session, and step two. The
    // provider round trip itself is covered by fastmail-oauth.test.ts.
    const address = `journey-${ulid().toLowerCase()}@fastmail.test`;
    const session = await sessionStorage.getSession();
    session.set(FM_PENDING_SESSION_KEY, {
      provider: "fastmail",
      username: address,
      mailAccountId: "jmap-journey",
      tokenEnc: encryptSecret("journey-at"),
      refreshTokenEnc: encryptSecret("journey-rt"),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    // commitSession returns the whole Set-Cookie header; the browser needs
    // the value alone.
    const setCookie = await sessionStorage.commitSession(session);
    await page.context().addCookies([
      {
        name: "expense_session",
        value: setCookie.slice(setCookie.indexOf("=") + 1).split(";")[0]!,
        url: "http://localhost:5199",
      },
    ]);

    let cleanupAccountId: string | undefined;
    try {
      await page.goto("/onboarding", { waitUntil: "load", timeout: 15_000 });

      // Step 2: the connected mailbox proved control, so only a password is
      // asked for; the email comes pre-filled from the connection.
      await expect(
        page.getByRole("heading", { name: "Set your password" }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByLabel("Account email")).toHaveValue(address);
      await page.fill('input[name="password"]', "onboarding-password");
      await page.getByRole("button", { name: "Create my account" }).click();

      // Onboarding lands straight on the review inbox.
      await page.waitForURL(/\/email-review\?onboarding=1/, {
        timeout: 15_000,
      });
      await expect(
        page.getByRole("heading", { name: "Review inbox" }),
      ).toBeVisible();

      // The account came out verified with its mailbox connected.
      const user = await testPrisma.user.findUnique({
        where: { email: address },
      });
      expect(user?.emailVerifiedAt).not.toBeNull();
      cleanupAccountId = String(user!.accountId);
      const connection = await testPrisma.emailConnection.findUniqueOrThrow({
        where: { emailAddress: address },
      });
      expect(connection.accountId).toBe(user!.accountId);
      expect(connection.provider).toBe("fastmail");
    } finally {
      if (cleanupAccountId)
        await testPrisma.account.delete({ where: { id: cleanupAccountId } });
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
