import type { Page } from "playwright";
import { chromium } from "playwright";
import { TEST_EMAIL, TEST_PASSWORD } from "./seedTestData";
import { FROZEN_MS } from "./frozen-time";

/** Pin the page's clock (per BrowserContext) to the suite-wide pinned instant
 * (see frozen-time.ts / pinned-time.ts). Installs the same pinned-ticking
 * Date override via an init script, so it survives every navigation; native
 * timers are untouched, so debounces and highlight fades fire on schedule.
 *
 * Playwright's own clock (page.clock) is NOT used: setFixedTime patches page
 * timers such that they never fire, and install() doesn't survive full-page
 * navigations — both broke the search debounce and the 3s highlight fade. */
export async function freezePageClock(page: Page): Promise<void> {
  await page.context().addInitScript(
    ({ FROZEN_MS }: { FROZEN_MS: number }) => {
      const RealDate = Date;
      const REAL_START = RealDate.now();
      class PinnedDate extends RealDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) {
            super(FROZEN_MS + (RealDate.now() - REAL_START));
          } else {
            super(...(args as ConstructorParameters<typeof Date>));
          }
        }
        static now(): number {
          return FROZEN_MS + (RealDate.now() - REAL_START);
        }
      }
      globalThis.Date = PinnedDate as unknown as DateConstructor;
    },
    { FROZEN_MS },
  );
}

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
  await freezePageClock(page);
  await signIn(page, TEST_EMAIL, TEST_PASSWORD);
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
  email: string,
  password: string,
): Promise<void> {
  await page.goto("/login", { waitUntil: "load", timeout: 15_000 });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => url.pathname === "/", {
    timeout: 15_000,
  });
}
