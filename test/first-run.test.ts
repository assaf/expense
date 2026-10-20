import { expect as pwExpect } from "playwright/test";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { ulid } from "ulid";
import { contextForRequest } from "./helpers/authContext";
import { closeBrowser, freshPage, signIn } from "./helpers/launchBrowser";
import { testPrisma } from "./helpers/seedTestData";
import { availableHighlights } from "~/components/FeatureHighlight";
import { sessionStorage, SESSION_USER_KEY } from "~/lib/auth.server";
import { hashPassword } from "~/lib/passwords";
import { loader } from "~/routes/expenses";

/**
 * The first-run screen: what a brand-new account sees on its first visit.
 *
 * An account with nothing filed is the one case where the app has no data
 * to show, so every word on the screen has to do work: the empty list has
 * to say what to do and make it tappable, the "Did you know?" card must not
 * describe a tax year or a statement the account does not have, and the
 * controls have to be reachable with a thumb.
 */

const NOW = new Date().toISOString();
const PASSWORD = "first-run-password";

interface BrandNewAccount {
  accountId: string;
  userId: string;
  email: string;
}

/** A verified user on an account with no expenses, no mailbox and no
 * reports: the state a signup leaves behind. */
async function seedBrandNewAccount(): Promise<BrandNewAccount> {
  const accountId = `acct_first_run_${ulid().toLowerCase()}`;
  const userId = `user_first_run_${ulid().toLowerCase()}`;
  const email = `first-run-${ulid().toLowerCase()}@example.com`;
  await testPrisma.account.create({
    data: {
      id: accountId,
      name: "First Run",
      inviteCode: `RUN${ulid().slice(0, 5).toUpperCase()}`,
      createdAt: NOW,
    },
  });
  await testPrisma.user.create({
    data: {
      id: userId,
      accountId,
      email,
      passwordHash: await hashPassword(PASSWORD),
      emailVerifiedAt: NOW,
      createdAt: NOW,
    },
  });
  return { accountId, userId, email };
}

/** The highlight the home page would show this account: the card it
 * picked, and the data the pool was built from. The card the browser
 * renders is pinned for the screenshot suite, so the loader is the honest
 * place to look. */
async function highlightFor(userId: string): Promise<{
  id: string;
  data: Parameters<typeof availableHighlights>[0];
}> {
  const session = await sessionStorage.getSession();
  session.set(SESSION_USER_KEY, userId);
  const cookie = await sessionStorage.commitSession(session);
  const request = new Request("https://expense.test/expenses", {
    headers: { cookie: cookie.split(";")[0]! },
  });
  const result = await loader({
    request,
    params: {},
    context: await contextForRequest(request),
  } as unknown as Parameters<typeof loader>[0]);
  const payload = (
    result as unknown as { data: { highlight: { id: string; data: never } } }
  ).data;
  return payload.highlight;
}

describe("First run", () => {
  afterAll(async () => {
    await closeBrowser();
  });

  it("offers the next step as links, not as prose", async () => {
    const { accountId, email } = await seedBrandNewAccount();
    const page = await freshPage();
    try {
      await signIn(page, email, PASSWORD);
      await page.goto("/expenses", { waitUntil: "load", timeout: 15_000 });

      // The invitation to start is actionable where the reader is looking:
      // inside the empty list, not up in the toolbar.
      const addReceipt = page.getByRole("link", {
        name: "Add your first receipt",
      });
      await pwExpect(addReceipt).toBeVisible();
      await pwExpect(addReceipt).toHaveAttribute("href", "/expense/new");

      const logDrive = page.getByRole("link", { name: "log a drive" });
      await pwExpect(logDrive).toBeVisible();
      await pwExpect(logDrive).toHaveAttribute(
        "href",
        "/expense/new?type=mileage",
      );

      // The mailbox is the other way in, so it is a link too.
      const connect = page.getByRole("link", {
        name: "connect your Gmail or Fastmail account",
      });
      await pwExpect(connect).toBeVisible();
      await pwExpect(connect).toHaveAttribute("href", "/emails");

      // And the link works: the receipt editor opens.
      await addReceipt.click();
      await page.waitForURL((url) => url.pathname === "/expense/new", {
        timeout: 10_000,
      });
    } finally {
      await page.close();
      await testPrisma.account.delete({ where: { id: accountId } });
    }
  });

  it("does not offer a tip about data the account does not have", async () => {
    const { accountId, userId } = await seedBrandNewAccount();
    try {
      const highlight = await highlightFor(userId);

      // Nothing filed: the account cannot be told to check up its tax year,
      // match a statement against no records, search nothing, or have its
      // spending read back by a browser agent.
      expect(highlight.data.hasExpenses).toBe(false);
      const pool = availableHighlights(highlight.data);
      for (const id of ["checkup", "reconcile", "search-operators", "webmcp"]) {
        expect(pool).not.toContain(id);
      }
      // And the card that was picked is one the account can be shown.
      expect(pool).toContain(highlight.id);
    } finally {
      await testPrisma.account.delete({ where: { id: accountId } });
    }
  });

  it("keeps offering the filed-data tips once there is something filed", async () => {
    const { accountId, userId } = await seedBrandNewAccount();
    try {
      const before = await highlightFor(userId);
      expect(before.data.hasExpenses).toBe(false);

      // One receipt, written the way a user writes one.
      await testPrisma.expense.create({
        data: {
          id: `exp_first_run_${ulid().toLowerCase()}`,
          accountId,
          type: "receipt",
          date: "2026-10-19",
          report: "",
          category: "",
          description: "",
          amount: "4.50",
          merchant: "First Run Cafe",
          imageFile: "",
          imageMime: "",
          originalName: "",
          distanceMiles: null,
          locations: [],
          createdAt: NOW,
          updatedAt: NOW,
        },
      });

      const after = await highlightFor(userId);
      expect(after.data.hasExpenses).toBe(true);
      const pool = availableHighlights(after.data);
      expect(pool).toContain("checkup");
      expect(pool).toContain("reconcile");
    } finally {
      await testPrisma.account.delete({ where: { id: accountId } });
    }
  });

  it("gives the first-run controls a thumb-sized target on a phone", async () => {
    const { accountId, email } = await seedBrandNewAccount();
    // A phone: the labels are hidden, so the icons are the whole target.
    const page = await freshPage({ viewport: { width: 390, height: 844 } });
    try {
      await signIn(page, email, PASSWORD);
      await page.goto("/expenses", { waitUntil: "load", timeout: 15_000 });

      // The three primary actions, and every header icon.
      const targets = [
        page.getByRole("button", { name: "Receipt" }),
        page.getByRole("button", { name: "Mileage" }),
        page.getByRole("button", { name: "Upload" }),
        page.getByRole("link", { name: "Insights" }),
        page.getByRole("link", { name: "Email" }),
        page.getByRole("link", { name: "Reconcile" }),
        page.getByRole("link", { name: "Reports" }),
        page.getByRole("link", { name: "Warranties" }),
        page.getByRole("link", { name: "Settings" }),
      ];
      for (const target of targets) {
        await pwExpect(target).toBeVisible();
        const box = await target.boundingBox();
        expect(box, "target has no box").not.toBeNull();
        // 44px is the size a thumb can hit without aiming.
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.width).toBeGreaterThanOrEqual(24);
      }

      // And the row still fits: the header must not push the page sideways.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(overflow).toBe(false);
    } finally {
      await page.close();
      await testPrisma.account.delete({ where: { id: accountId } });
    }
  });
});
