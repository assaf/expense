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

  /** The page's sections, by their heading. */
  function sectionOf(target: Page, title: string) {
    return target.locator("section").filter({
      has: target.getByRole("heading", { name: title }),
    });
  }

  it("shows the email page", async () => {
    await expect(page.locator("h1")).toContainText("Email");
  });

  it("shows the email sections", async () => {
    await expect(sectionOf(page, "Email accounts")).toBeVisible();
    await expect(sectionOf(page, "Receipts by email")).toBeVisible();
    await expect(sectionOf(page, "Auto-imported senders")).toBeVisible();
  });

  it("shows the connect buttons with no accounts connected", async () => {
    // The test server sets EMAIL_TOKEN_ENCRYPTION_KEY (and the dummy
    // GOOGLE_* / FASTMAIL OAuth vars), so the section is configured:
    // empty list + both connect buttons. Nothing is pasted by hand.
    const section = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Email accounts" }),
    });
    await expect(
      section.getByText("No email accounts connected yet."),
    ).toBeVisible();
    await expect(
      section.getByRole("link", { name: "Connect with Gmail" }),
    ).toBeVisible();
    await expect(
      section.getByRole("link", { name: "Connect with Fastmail" }),
    ).toBeVisible();
  });

  it("connects another JMAP server by URL and surfaces a refused host", async () => {
    const section = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Email accounts" }),
    });
    await section.getByText("Connect another JMAP server").click();
    await section
      .locator('input[name="serverUrl"]')
      .fill("https://127.0.0.1/jmap");
    await section.locator('input[name="secret"]').fill("tok-123");
    await section.getByRole("button", { name: "Connect server" }).click();
    // The SSRF guard refuses a literal loopback host before any request goes
    // out; the action returns that message and the form shows it.
    await expect(
      section.getByText("Blocked: private or unresolvable host"),
    ).toBeVisible();
  });

  it("shows the sign-in email as a pending approved sender", async () => {
    // The login email is auto-added as the account's default sender on
    // sign-in, pending until its verification link is clicked. It belongs
    // with the forward-to address, not with the rules.
    const section = sectionOf(page, "Receipts by email");
    await expect(section.getByText("Senders you approved")).toBeVisible();
    const row = section.locator("li").filter({
      hasText: "testuser@example.com",
    });
    await expect(row.getByText("Your sign-in email")).toBeVisible();
    await expect(row.getByText("Awaiting verification")).toBeVisible();
    // The default sender row can't be removed.
    await expect(
      row.getByRole("button", { name: /Remove testuser@example.com/ }),
    ).toHaveCount(0);
  });

  it("adds a sender as pending and reports the verification email", async () => {
    const page = await goto("/emails");
    const receipts = sectionOf(page, "Receipts by email");
    await receipts
      .locator('input[type="email"][name="address"]')
      .fill("extra@example.com");
    await receipts.getByRole("button", { name: "Add address" }).click();
    await expect(
      receipts.getByText(/Verification email sent to extra@example.com/),
    ).toBeVisible();
    // The new address lands in the approved list, still awaiting its link.
    await expect(
      receipts
        .locator("li")
        .filter({ hasText: "extra@example.com" })
        .getByText("Awaiting verification"),
    ).toBeVisible();
    await page.close();
  });

  it("lists pre-selected senders and turns one off, then restores it", async () => {
    const page = await goto("/emails");
    const section = sectionOf(page, "Auto-imported senders");
    await expect(section.getByText("Pre-selected by Expense")).toBeVisible();
    // The pre-selected senders come from the shared rule list every
    // workspace starts with, not from anything this account did.
    const row = section.locator("li").filter({ hasText: "apple.com" });
    await expect(row.getByText("Pre-selected")).toBeVisible();
    await row.getByRole("button", { name: "Remove apple.com" }).click();
    // Both controls submit a real navigation (that is what lets the row
    // morph to its new group), so the page's place has to survive it: a
    // scroll reset or one history entry per toggle would be felt
    // immediately on a list this long.
    const before = await page.evaluate(() => ({
      scrollY: window.scrollY,
      history: history.length,
    }));
    await page.getByRole("button", { name: "Delete" }).click();
    // Off: the sender moves to the turned-off group and its mail goes back
    // to waiting on the review list.
    const off = section.locator("li").filter({ hasText: "apple.com" });
    await expect(off.getByText("Turned off")).toBeVisible();
    const afterRemove = await page.evaluate(() => ({
      scrollY: window.scrollY,
      history: history.length,
    }));
    expect(afterRemove).toEqual(before);
    await off.getByRole("button", { name: "Restore apple.com" }).click();
    await expect(
      section
        .locator("li")
        .filter({ hasText: "apple.com" })
        .getByText("Pre-selected"),
    ).toBeVisible();
    // History only for this one: the restore control sits in the group at
    // the page's foot, so clicking it scrolls there, which is not the page
    // losing its place.
    expect(await page.evaluate(() => history.length)).toBe(before.history);
    await page.close();
  });

  it("shows Email in the header nav after Insights", async () => {
    const page = await goto("/");
    const labels = await page.locator("header nav a").allTextContents();
    expect(labels.map((s) => s.trim())).toEqual([
      "Insights",
      "Email",
      "Reconcile",
      "Reports",
      "Settings",
    ]);
    await page.close();
  });
});
