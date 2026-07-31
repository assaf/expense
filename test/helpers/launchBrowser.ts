import type { Page } from "playwright";
import { chromium } from "playwright";
import { TEST_PASSWORD, TEST_USERNAME } from "./seedTestData";

/**
 * Navigate to a path on the test server and return a Playwright page.
 * Signs in first through the real /login flow so the session cookie is set
 * in the browser context (subsequent navigations stay authenticated).
 */
export async function goto(path: string): Promise<Page> {
  const baseURL = process.env.TEST_BASE_URL ?? "http://localhost:5199";
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1024, height: 780 },
  });
  const page = await context.newPage();
  await signIn(page, TEST_USERNAME, TEST_PASSWORD);
  await page.goto(path, { waitUntil: "load", timeout: 15_000 });
  // Wait for React Router to hydrate
  await page.waitForFunction(() => "__reactRouterContext" in window, {
    timeout: 10_000,
  });
  await page.waitForTimeout(500);
  return page;
}

/** Submit the login form with the given credentials. */
export async function signIn(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  await page.goto("/login", { waitUntil: "load", timeout: 15_000 });
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => url.pathname === "/", {
    timeout: 15_000,
  });
}
