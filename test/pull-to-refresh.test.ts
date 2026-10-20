import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vite-plus/test";
import { goto } from "./helpers/launchBrowser";
import { TEST_ACCOUNT_ID, testPrisma } from "./helpers/seedTestData";
import { todayDate } from "~/lib/format";
import { PULL_REFRESH_TRIGGER_PX } from "~/lib/use-pull-to-refresh";

/**
 * Pull down to refresh, on the expense list.
 *
 * A Home Screen app on iOS has no browser reload gesture: iOS gives the
 * standalone web view no chrome, and the reload gesture is part of that
 * chrome. So the gesture is the app's own, and this covers the three things
 * it has to get right — the pull shows what it will do, letting go past the
 * trigger re-reads the list, and a pull that is too short, or one that
 * starts with the page already scrolled, does nothing at all.
 */
describe("Pull to refresh", () => {
  let page: Page;
  const merchants: string[] = [];

  beforeAll(async () => {
    page = await goto("/expenses");
  });

  afterAll(async () => {
    await testPrisma.expense.deleteMany({
      where: { merchant: { in: merchants } },
    });
  });

  /** A merchant of this case's own, and a row the list does not hold yet, so
   *  a reload has something to show that the list did not have. */
  async function addExpense(name: string): Promise<void> {
    merchants.push(name);
    await testPrisma.expense.create({
      data: {
        id: `pull-refresh-${name.replace(/\W+/g, "-").toLowerCase()}`,
        type: "receipt",
        date: todayDate(),
        report: "",
        category: "Testing",
        description: "",
        amount: "1.23",
        merchant: name,
        imageFile: "",
        imageMime: "",
        originalName: "",
        distanceMiles: null,
        locations: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        accountId: TEST_ACCOUNT_ID,
      },
    });
  }

  /** The touch the hook listens for, at a height on the page. */
  async function touch(
    type: "touchstart" | "touchmove" | "touchend",
    y: number,
  ): Promise<void> {
    await page.evaluate(
      ({ type, y }: { type: string; y: number }) => {
        const target = document.body;
        const touch = new Touch({
          identifier: 1,
          target,
          clientX: 200,
          clientY: y,
        });
        target.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: type === "touchend" ? [] : [touch],
            changedTouches: [touch],
          }),
        );
      },
      { type, y },
    );
  }

  const indicator = () => page.locator("[data-pull-to-refresh]");

  it("reloads the list when the pull is let go past the trigger", async () => {
    const merchant = "PullToRefresh Reloaded";
    await addExpense(merchant);
    // The list on screen is the one from before the row existed.
    await expect(page.getByText(merchant)).toHaveCount(0);

    // The reload is slowed, so the states it passes through are seen: the
    // answer comes from the network, so no fake clock would stand in for it.
    await page.route("**/expenses.data*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });

    await touch("touchstart", 100);
    await touch("touchmove", 100 + PULL_REFRESH_TRIGGER_PX + 90);
    // The pull is far enough now, and says so before it happens.
    await expect(indicator()).toHaveAttribute("data-pull-to-refresh", "armed");
    await touch("touchend", 100 + PULL_REFRESH_TRIGGER_PX + 90);
    // And while the list is being re-read, the indicator says so.
    await expect(indicator()).toHaveAttribute(
      "data-pull-to-refresh",
      "refreshing",
    );

    // The list was re-read, so the row that arrived while the page was open
    // is on it.
    await expect(page.getByText(merchant)).toHaveCount(1, { timeout: 15_000 });
    await expect(indicator()).toHaveAttribute("data-pull-to-refresh", "idle", {
      timeout: 15_000,
    });
  });

  it("does nothing when the pull is not far enough", async () => {
    const merchant = "PullToRefresh TooShort";
    await addExpense(merchant);
    await touch("touchstart", 100);
    await touch("touchmove", 100 + PULL_REFRESH_TRIGGER_PX - 40);
    // Just short of the trigger: a nudge, not a pull.
    await expect(indicator()).toHaveAttribute(
      "data-pull-to-refresh",
      "pulling",
    );
    await touch("touchend", 100 + PULL_REFRESH_TRIGGER_PX - 40);
    await expect(indicator()).toHaveAttribute("data-pull-to-refresh", "idle");
    // And the list was not re-read: the row stays off it. The network going
    // quiet is the signal that the revalidation, had there been one, is over.
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(merchant)).toHaveCount(0);
  });

  it("does nothing when the page is already scrolled", async () => {
    const merchant = "PullToRefresh Scrolled";
    await addExpense(merchant);
    // A page tall enough to scroll, so the pull starts below the top.
    await page.evaluate(() => {
      document.body.style.minHeight = "3000px";
      window.scrollTo(0, 400);
    });
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await touch("touchstart", 100);
    await touch("touchmove", 300);
    // The gesture never began: a pull further down the page is a scroll.
    await expect(indicator()).toHaveAttribute("data-pull-to-refresh", "idle");
    await touch("touchend", 300);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(merchant)).toHaveCount(0);
    await page.evaluate(() => {
      document.body.style.minHeight = "";
      window.scrollTo(0, 0);
    });
  });
});
