import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { expect as pwExpect } from "playwright/test";
import type { Page } from "playwright";
import { appendExchange, startNewConversation } from "~/lib/db/insights-chat";
import {
  freshPage,
  goto,
  signIn,
  waitForHydration,
} from "./helpers/launchBrowser";
import {
  TEST_ACCOUNT_ID,
  TEST_EMAIL,
  TEST_PASSWORD,
} from "./helpers/seedTestData";

/**
 * The /insights composer on a phone: the field keeps its geometry (16px, no
 * zoom shift when the button's label changes), sending is optimistic and
 * never dead (Stop while waiting, Ask again the moment the user types), a
 * failure lands inline in the composer instead of replacing the page with an
 * error boundary, and a growing answer does not yank a reader who scrolled
 * away from the bottom.
 *
 * Questions are answered with a real failure envelope captured from the
 * action (see answerWithFailure): the spawned test server runs
 * `NODE_ENV=production`, so its outbound network guard is off and it would
 * otherwise call the live provider — slow, paid, and unavailable in CI.
 */

/** The seeded transcript user (see seedTestData: user_test1). */
const USER_ID = "user_test1";

/** Uncaught errors in the page, checked after every case. The composer
 * submits imperatively and re-renders synchronously, and a mistake there
 * surfaces as a thrown TypeError that no assertion has to fail for. */
const pageErrors: string[] = [];

function watch(page: Page): Page {
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  return page;
}

afterEach(() => {
  expect(pageErrors).toEqual([]);
  pageErrors.length = 0;
});

const QUESTION = "does coffee beat software?";
/** Deliberately not one of the "Try:" chips, so a card locator for it is
 * unambiguous. */
const SECOND = "double espresso";
/** What every answer in this file says (see answerWithFailure). */
const FAILURE = "The AI service didn't answer. Try again in a moment.";

beforeAll(async () => {
  // A long conversation, so the transcript scrolls and the cards are
  // addressable. Written through the module's own path, not a hand-built row.
  await startNewConversation(USER_ID, TEST_ACCOUNT_ID);
  for (let i = 1; i <= 6; i += 1) {
    await appendExchange(USER_ID, TEST_ACCOUNT_ID, {
      question: `seeded question ${i}`,
      answer: `seeded answer ${i} `.repeat(20).trim(),
      chart: false,
      shape: "monthly-totals",
      query: "",
      months: 12,
      title: "",
    });
  }
});

/** One real failure envelope from the action, captured once per run: a
 * translate with no question, which the action answers without touching the
 * provider. Its message text is swapped for the one a transport failure
 * produces, so the assertions read like the user's experience; the wire
 * shape (a single-fetch turbo-stream of `{ok, error}`) is the server's own. */
let envelope: { contentType: string; body: string } | null = null;

async function answerWithFailure(page: Page, holdMs = 0): Promise<void> {
  if (!envelope) {
    const captured = await page.evaluate(async () => {
      const res = await fetch("/insights.data", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ intent: "translate", text: "" }).toString(),
      });
      return {
        contentType: res.headers.get("content-type") ?? "application/json",
        body: await res.text(),
      };
    });
    envelope = {
      contentType: captured.contentType,
      body: captured.body.replace("Type a question first.", FAILURE),
    };
  }
  const answer = envelope;
  await page.route(
    (url) => url.pathname === "/insights.data",
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      // A real delay on the platform clock is the point: the assertions are
      // about what the user sees while the request is still open.
      if (holdMs > 0) {
        const held = Promise.withResolvers<void>();
        setTimeout(held.resolve, holdMs);
        await held.promise;
      }
      await route.fulfill({
        status: 200,
        headers: { "content-type": answer.contentType },
        body: answer.body,
      });
    },
  );
}

/** The transcript's scroll region, holding the exchange cards. */
function transcript(page: Page) {
  return page.locator("#main-content > div").first();
}

describe("insights composer", () => {
  it("keeps the field at 16px with fixed geometry on a phone", async () => {
    const page = watch(
      await freshPage({ viewport: { width: 390, height: 844 } }),
    );
    await signIn(page, TEST_EMAIL, TEST_PASSWORD);
    await page.goto("/insights", { waitUntil: "load" });
    await waitForHydration(page);

    const field = page.locator("#insights-ask");
    const ask = page.getByRole("button", { name: "Ask" });
    // 16px: below that, mobile Safari zooms the page on focus.
    expect(await field.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
      "16px",
    );
    // The field rests at least at the 44px touch target the button shares,
    // and hides nothing: on a phone the hint wraps to two lines, and the
    // field fits it rather than clipping a sliver of the second line.
    expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(
      await field.evaluate((el) => el.scrollHeight <= el.clientHeight),
    ).toBe(true);
    expect((await ask.boundingBox())?.height).toBe(44);
    // A phone keyboard that capitalizes a question and an autofill overlay
    // both make the composer worse; the Return key says what it does.
    expect(await field.getAttribute("autocapitalize")).toBe("off");
    expect(await field.getAttribute("autocomplete")).toBe("off");
    expect(await field.getAttribute("enterkeyhint")).toBe("send");
    // The zoom that needs undoing is the browser's own, so the viewport stays
    // user-scalable.
    const viewport = (await page
      .locator('meta[name="viewport"]')
      .getAttribute("content")) as string;
    expect(viewport).toContain("width=device-width");
    expect(viewport).not.toContain("maximum-scale");
    await page.close();
  });

  it("sends optimistically: Stop is up before the answer lands", async () => {
    const page = watch(await goto("/insights"));
    await answerWithFailure(page, 1500);
    await page.fill("#insights-ask", QUESTION);
    await page.getByRole("button", { name: "Ask" }).click();

    // The field clears and the button flips in the same paint as the click,
    // while the transcript still shows the placeholder: the swap did not wait
    // for the round trip.
    expect(await page.inputValue("#insights-ask")).toBe("");
    await pwExpect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await pwExpect(page.getByText("Thinking…", { exact: true })).toBeVisible();
  });

  it("stays usable while a question is in flight", async () => {
    const page = watch(await goto("/insights"));
    await answerWithFailure(page, 1500);
    await page.fill("#insights-ask", QUESTION);
    await page.getByRole("button", { name: "Ask" }).click();

    const field = page.locator("#insights-ask");
    await page.fill("#insights-ask", SECOND);
    await pwExpect(field).toBeEnabled();
    expect(await page.inputValue("#insights-ask")).toBe(SECOND);
    // Typing the next question turns the button back into Ask.
    await pwExpect(page.getByRole("button", { name: "Ask" })).toBeVisible();
  });

  it("interrupts the in-flight question when the next one is sent", async () => {
    const page = watch(await goto("/insights"));
    await answerWithFailure(page, 1500);
    await page.fill("#insights-ask", QUESTION);
    await page.getByRole("button", { name: "Ask" }).click();
    await pwExpect(page.getByRole("button", { name: "Stop" })).toBeVisible();

    await page.fill("#insights-ask", SECOND);
    await page.getByRole("button", { name: "Ask" }).click();

    const cards = transcript(page);
    // The interrupted question is recorded as stopped, once.
    await pwExpect(cards.getByText("Stopped.", { exact: true })).toHaveCount(1);
    // The new question ran: its own card carries an answer. A barge-in that
    // aborted the second submission instead of the first would leave its card
    // pending, reading "No answer recorded."
    const second = cards
      .locator(":scope > div > div")
      .filter({ has: page.getByText(SECOND, { exact: true }) });
    await pwExpect(second).toHaveCount(1);
    await pwExpect(second.getByText(FAILURE)).toBeVisible();
    // Only that card: the stopped one never got an answer.
    await pwExpect(cards.getByText(FAILURE)).toHaveCount(1);
  });

  it("grows with a long question, up to five lines", async () => {
    const page = watch(await goto("/insights"));
    const field = page.locator("#insights-ask");
    const ask = page.getByRole("button", { name: "Ask" });
    const box = await field.evaluate((el) => {
      const styles = getComputedStyle(el);
      return {
        lineHeight: Number.parseFloat(styles.lineHeight),
        padding:
          Number.parseFloat(styles.paddingTop) +
          Number.parseFloat(styles.paddingBottom),
        border:
          Number.parseFloat(styles.borderTopWidth) +
          Number.parseFloat(styles.borderBottomWidth),
      };
    });
    const linesNeeded = () =>
      field.evaluate((el) => {
        const styles = getComputedStyle(el);
        return (
          (el.scrollHeight - Number.parseFloat(styles.paddingTop)) /
          Number.parseFloat(styles.lineHeight)
        );
      });
    // One line at rest: the 44px touch target the button shares.
    expect((await field.boundingBox())!.height).toBe(44);

    // A wrapped question is taller by exactly the lines it wraps to.
    await page.fill("#insights-ask", "wrapping question ".repeat(10).trim());
    const wrapped = Math.round(await linesNeeded());
    expect(wrapped).toBeGreaterThan(1);
    expect((await field.boundingBox())!.height).toBe(
      box.lineHeight * wrapped + box.padding + box.border,
    );
    // The button does not move with it.
    expect((await ask.boundingBox())!.height).toBe(44);

    // Past the cap the field stops growing and scrolls instead.
    await page.fill("#insights-ask", "wrapping question ".repeat(40).trim());
    expect(Math.round(await linesNeeded())).toBeGreaterThan(5);
    expect((await field.boundingBox())!.height).toBe(
      box.lineHeight * 5 + box.padding + box.border,
    );
    expect(
      await field.evaluate((el) => el.scrollHeight > el.clientHeight),
    ).toBe(true);
    await page.close();
  });

  it("sends on Enter and takes a newline on Shift+Enter", async () => {
    const page = watch(await goto("/insights"));
    // Held, so the in-flight state after Enter is observable.
    await answerWithFailure(page, 1500);
    const field = page.locator("#insights-ask");
    const rest = (await field.boundingBox())!.height;

    await page.fill("#insights-ask", "one line");
    await field.press("Shift+Enter");
    await field.pressSequentially("second line");
    // Shift+Enter is a newline, not a send: the question is still here.
    expect(await field.inputValue()).toBe("one line\nsecond line");
    expect((await field.boundingBox())!.height).toBeGreaterThan(rest);

    await field.press("Enter");
    // Enter sent it: the field clears and collapses, and the question is in
    // flight.
    await pwExpect.poll(() => field.inputValue()).toBe("");
    await pwExpect
      .poll(async () => (await field.boundingBox())!.height)
      .toBe(rest);
    await pwExpect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    // Both lines reached the transcript, in order.
    const asked = transcript(page).locator(":scope > div > div").last();
    await pwExpect(asked).toContainText("one line");
    await pwExpect(asked).toContainText("second line");
  });

  it("stops on demand and hands the question back", async () => {
    const page = watch(await goto("/insights"));
    await answerWithFailure(page, 1500);
    await page.fill("#insights-ask", QUESTION);
    await page.getByRole("button", { name: "Ask" }).click();
    await pwExpect(page.getByRole("button", { name: "Stop" })).toBeVisible();

    await page.getByRole("button", { name: "Stop" }).click();

    // The stopped question comes back to the field, so it can be re-sent.
    expect(await page.inputValue("#insights-ask")).toBe(QUESTION);
    await pwExpect(page.getByRole("button", { name: "Ask" })).toBeVisible();
    const cards = transcript(page);
    await pwExpect(cards.getByText("Stopped.", { exact: true })).toHaveCount(1);
    await pwExpect(cards.getByText(FAILURE)).toHaveCount(0);
  });

  it("reports a failure inline instead of replacing the page", async () => {
    const page = watch(await goto("/insights"));
    await answerWithFailure(page);
    await page.fill("#insights-ask", QUESTION);
    await page.getByRole("button", { name: "Ask" }).click();

    const composer = page.locator("form:has(#insights-ask)");
    await pwExpect(composer.getByRole("alert")).toHaveText(FAILURE);
    // The composer is still there: nothing fell through to the error
    // boundary, and nothing floated a notification either.
    await pwExpect(page.locator("#insights-ask")).toBeVisible();
    await pwExpect(page.getByRole("alert")).toHaveCount(1);
  });

  it("does not yank a reader who scrolled away from the bottom", async () => {
    const page = watch(
      await freshPage({ viewport: { width: 390, height: 844 } }),
    );
    await signIn(page, TEST_EMAIL, TEST_PASSWORD);
    await page.goto("/insights", { waitUntil: "load" });
    await waitForHydration(page);
    await answerWithFailure(page, 1500);

    await page.fill("#insights-ask", QUESTION);
    await page.getByRole("button", { name: "Ask" }).click();

    const region = transcript(page);
    // Asking scrolled to the answer, and the seeded history overflows: the
    // region has somewhere to not be the bottom.
    await pwExpect(region).not.toHaveJSProperty("scrollTop", 0);
    await region.evaluate((el) => {
      el.scrollTop = 0;
    });

    // The answer's last words only render when the reveal has run to the end,
    // so waiting for them waits out the whole arrival. Scoped to the
    // transcript, because the composer's alert carries the same sentence from
    // the moment the reply lands.
    await pwExpect(region.getByText(/Try again in a moment\./)).toBeVisible();
    expect(await region.evaluate((el) => el.scrollTop)).toBe(0);
    await page.close();
  });
});
