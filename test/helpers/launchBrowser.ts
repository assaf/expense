import type { Browser, BrowserContext, Page } from "playwright";
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

// The session cookie set by app/lib/auth.server.ts (SESSION_COOKIE). Kept in
// sync manually — importing that module here would drag the server's Prisma
// client into every test-process fork.
const SESSION_COOKIE = "expense_session";

// One browser + one signed-in context per test file (each file runs in its
// own vitest fork, so this state never crosses files). goto() used to launch
// a fresh Chromium and re-log-in on every call; sharing them saves the
// launch + login on every call after the first. Files that need a
// logged-out or multi-account session drive their own browser directly.
let sharedBrowser: Browser | undefined;
let sharedContext: BrowserContext | undefined;

async function getSharedContext(): Promise<BrowserContext> {
  if (!sharedBrowser) {
    sharedBrowser = await chromium.launch({ headless: true });
  }
  if (!sharedContext) {
    sharedContext = await sharedBrowser.newContext({
      baseURL: "http://localhost:5199",
      viewport: { width: 1024, height: 780 },
    });
  }
  return sharedContext;
}

/** Close the per-file browser, if any. Registered in testSuiteSetup's
 * afterAll so browsers don't outlive their test file. */
export async function closeBrowser(): Promise<void> {
  await sharedBrowser?.close();
  sharedBrowser = undefined;
  sharedContext = undefined;
}

/**
 * Navigate to a path on the test server and return a Playwright page.
 * Signs in through the real /login flow when the shared context has no
 * session cookie (first call per file, or after a test cleared cookies);
 * already-signed-in calls skip straight to the navigation. The clock-freeze
 * init script is installed once per context and inherited by later pages.
 */
export async function goto(path: string): Promise<Page> {
  const context = await getSharedContext();
  const page = await context.newPage();
  const cookies = await context.cookies();
  const isSignedIn = cookies.some((c) => c.name === SESSION_COOKIE);
  if (!isSignedIn) {
    await freezePageClock(page);
    await signIn(page, TEST_EMAIL, TEST_PASSWORD);
  }
  await page.goto(path, { waitUntil: "load", timeout: 15_000 });
  // Wait for React Router to hydrate
  await page.waitForFunction(() => "__reactRouterContext" in window, {
    timeout: 10_000,
  });
  await page.waitForTimeout(150);
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
