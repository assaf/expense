import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { goto } from "./helpers/launchBrowser";

// The review page with no connection selected shows the fallback (the
// test server has no connected mailboxes). The full flow (scan → list →
// process/ignore) is covered at the unit level in test/email-review.test.ts.
describe("Email review page", () => {
  let page: Page;

  beforeAll(async () => {
    page = await goto("/email-review");
  });

  afterAll(async () => {
    await page.close();
  });

  it("shows the review page title", async () => {
    await expect(page.locator("h1")).toContainText("Review inbox");
  });

  it("prompts to connect an account when none is selected", async () => {
    await expect(page.getByText("No email connection selected.")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Connect an email account first." }),
    ).toBeVisible();
  });
});
