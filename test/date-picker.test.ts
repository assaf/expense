import { expect } from "playwright/test";
import { it, describe } from "vitest";
import { goto } from "./helpers/launchBrowser";
import { TEST_ACCOUNT_ID, testPrisma } from "./helpers/seedTestData";

/** Local-timezone YYYY-MM-DD, matching the app's `todayDate()`. */
function toISO(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** "Friday, August 15, 2026" is the day buttons' accessible-name format. */
function longLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

describe("Date picker", () => {
  it("colors today blue, future dates orange, and past dates black", async () => {
    const page = await goto("/expense/new");
    // Clear the default (today) so today's cell isn't the filled selection.
    await page.getByLabel("Date").fill("");
    await page.getByLabel("Open calendar").click();

    // Today carries aria-current="date" and renders blue.
    const today = page.locator('[aria-current="date"]');
    await expect(today).toHaveClass(/text-blue-600/);

    // Every day in the next month is in the future → orange.
    await page.getByLabel("Next month").click();
    const nextMonthFirst = page.locator("button[data-iso]").first();
    await expect(nextMonthFirst).toHaveClass(/text-orange-600/);

    // A full month before today is in the past → black.
    await page.getByLabel("Previous month").click();
    await page.getByLabel("Previous month").click();
    const prevMonthFirst = page.locator("button[data-iso]").first();
    await expect(prevMonthFirst).toHaveClass(/text-gray-800/);

    await page.keyboard.press("Escape");
    await page.close();
  });

  it("writes a clicked day into the input", async () => {
    const page = await goto("/expense/new");
    const now = new Date();
    const tomorrow = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
    );
    const iso = toISO(tomorrow);

    await page.getByLabel("Open calendar").click();
    // A month-boundary tomorrow needs the view advanced one month.
    if (tomorrow.getMonth() !== now.getMonth()) {
      await page.getByLabel("Next month").click();
    }
    await page.getByRole("button", { name: longLabel(iso) }).click();
    await expect(page.getByLabel("Date")).toHaveValue(iso);
    await page.close();
  });

  it("Escape closes the popover without canceling the editor", async () => {
    const page = await goto("/expense/new");
    await page.getByLabel("Open calendar").click();
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Open calendar")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/expense/new");
    await page.close();
  });

  it("saves a future date chosen from the calendar", async () => {
    const page = await goto("/");
    await page.getByRole("button", { name: "Receipt" }).click();
    await page.waitForURL(/\/expense\/new$/, { timeout: 10_000 });

    const future = new Date();
    future.setMonth(future.getMonth() + 1, 15);
    const iso = toISO(future);

    await page.locator("input[list='merchants']").fill("Calendar Shop");
    await page.locator("input[type='number']").fill("40.00");
    await page.getByLabel("Open calendar").click();
    await page.getByLabel("Next month").click();
    await page.getByRole("button", { name: longLabel(iso) }).click();
    await page.getByText("Save").click();

    await expect(page).toHaveURL(/\/$/);
    const row = await testPrisma.expense.findFirst({
      where: { accountId: TEST_ACCOUNT_ID, merchant: "Calendar Shop" },
    });
    expect(row?.date).toBe(iso);
    await testPrisma.expense.deleteMany({
      where: { accountId: TEST_ACCOUNT_ID, merchant: "Calendar Shop" },
    });
    await page.close();
  });
});
