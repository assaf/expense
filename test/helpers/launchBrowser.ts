import type { Page } from "playwright";
import { chromium } from "playwright";

/** Navigate to a path on the test server and return a Playwright page. */
export async function goto(path: string): Promise<Page> {
  const baseURL = process.env.TEST_BASE_URL ?? "http://localhost:5199";
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1024, height: 780 },
  });
  const page = await context.newPage();
  await page.goto(path, { waitUntil: "load", timeout: 15_000 });
  // Wait for React Router to hydrate
  await page.waitForFunction(() => "__reactRouterContext" in window, {
    timeout: 10_000,
  });
  await page.waitForTimeout(500);
  return page;
}
