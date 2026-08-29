import { expect } from "playwright/test";
import type { Page } from "playwright";
import { hashToken } from "~/lib/passwords";
import { testPrisma } from "./seedTestData";

/** Fill the signup form and submit; expect the pending "check your
 * email" state. Signup never signs the user in anymore. Shared by the
 * auth tests and the signup-journey end-to-end tests. */
export async function signUp(
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
  // On success the form is replaced by the "Check your email" screen
  // (there is no submit button on it), so wait for the heading directly
  // with a generous timeout to absorb the server round-trip.
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible({ timeout: 15_000 });
}

/** Complete email verification for a user: the app mints tokens
 * internally and never exposes them, so the test pins the row's hash to
 * a known token, then clicks the real /verify-email route. */
export async function verifyEmail(
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
