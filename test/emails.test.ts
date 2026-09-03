import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { goto } from "./helpers/launchBrowser";

// The Email page (/emails) holds both email features: connected email
// accounts (auto-import) and receipts-by-email (forward-to address, verified
// senders). The test server pins EMAIL_TOKEN_ENCRYPTION_KEY (launchServer),
// so the connected-accounts section renders the connect form.
describe("Email", () => {
  let page: Page;

  beforeAll(async () => {
    page = await goto("/emails");
  });

  afterAll(async () => {
    await page.close();
  });

  it("shows the email page", async () => {
    await expect(page.locator("h1")).toContainText("Email");
  });

  it("shows both email sections", async () => {
    await expect(
      page.getByRole("heading", { name: "Email accounts" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Receipts by email" }),
    ).toBeVisible();
  });

  it("shows the connect form with no accounts connected", async () => {
    // The test server sets EMAIL_TOKEN_ENCRYPTION_KEY (and the dummy
    // GOOGLE_* / FASTMAIL OAuth vars), so the section is configured:
    // empty list + both OAuth buttons + the token paste form.
    const section = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Email accounts" }),
    });
    await expect(
      section.getByText("No email accounts connected yet."),
    ).toBeVisible();
    await expect(
      section.getByText("Connect an email account", { exact: true }),
    ).toBeVisible();
    await expect(
      section.getByRole("link", { name: "Connect with Gmail" }),
    ).toBeVisible();
    await expect(
      section.getByRole("link", { name: "Connect with FastMail" }),
    ).toBeVisible();
  });

  it("shows the sign-in email as a pending receipts-by-email sender", async () => {
    // The login email is auto-added as the account's default sender on
    // sign-in, pending until its verification link is clicked.
    const section = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Receipts by email" }),
    });
    await expect(section.getByText("testuser@example.com")).toBeVisible();
    await expect(section.getByText("Your sign-in email")).toBeVisible();
    await expect(section.getByText("Awaiting verification")).toBeVisible();
    // The default sender row can't be removed.
    await expect(
      section.getByRole("button", { name: /Remove testuser@example.com/ }),
    ).toHaveCount(0);
  });

  it("adds a sender as pending and reports the verification email", async () => {
    const page = await goto("/emails");
    const section = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Receipts by email" }),
    });
    await section
      .locator('input[type="email"][name="address"]')
      .fill("extra@example.com");
    await section.getByRole("button", { name: "Add address" }).click();
    await expect(
      section.getByText("extra@example.com", { exact: true }),
    ).toBeVisible();
    await expect(section.getByText("Awaiting verification")).toHaveCount(2);
    await expect(
      section.getByText(/Verification email sent to extra@example.com/),
    ).toBeVisible();
    await page.close();
  });

  it("shows Email in the header nav between Reports and Settings", async () => {
    const page = await goto("/");
    const labels = await page.locator("header nav a").allTextContents();
    expect(labels.map((s) => s.trim())).toEqual([
      "Reconcile",
      "Reports",
      "Email",
      "Settings",
    ]);
    await page.close();
  });
});
