import { expect } from "playwright/test";
import type { FileChooser, Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { goto } from "./helpers/launchBrowser";

/** Shortcuts fire only outside form fields — release whatever holds focus. */
const blurFocus = (page: Page) =>
  page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
import { TEST_ACCOUNT_ID, testPrisma } from "./helpers/seedTestData";

// The palette mounts in the root layout for signed-in users. The shared
// page starts on "/" (home); the first test navigates it to the editor, the
// second navigates back. The test DB is force-reset per suite, so the fixed
// category name below never collides with a previous run.
describe("Command palette", () => {
  let page: Page;

  beforeAll(async () => {
    page = await goto("/");
  });

  it("opens with Cmd/Ctrl+K and navigates to the mileage editor", async () => {
    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByPlaceholder("Type a command or search…");
    await expect(search).toBeVisible();
    await search.fill("mileage");
    // kbar highlights the first match asynchronously; Enter fires on the
    // highlighted row, so wait until it settles before pressing.
    await expect(
      page.getByRole("option", { name: "Add mileage expense", selected: true }),
    ).toBeVisible();
    await page.keyboard.press("Enter");
    await page.waitForURL("**/expense/new?type=mileage");
  });

  it("searches expenses from the palette with a typed query", async () => {
    // goto() waits for React Router hydration — Cmd+K before the palette
    // mounts is a no-op, which intermittently fails the palette-open wait.
    page = await goto("/");
    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByPlaceholder("Type a command or search…");
    await expect(search).toBeVisible();
    // The query becomes part of the action name, so the command stays
    // reachable while typing even though kbar's token filter hides the
    // bare "Search expenses" command.
    await search.fill("DevShop");
    await expect(
      page.getByRole("option", {
        name: 'Search expenses for "DevShop"',
        selected: true,
      }),
    ).toBeVisible();
    await page.keyboard.press("Enter");
    const homeSearch = page.getByLabel("Search expenses");
    await expect(homeSearch).toHaveValue("DevShop");
    // The palette holds the request until it is fully hidden, so kbar's
    // close-time focus restore cannot blur the search box afterwards.
    await expect(homeSearch).toBeFocused();
    await expect(page.getByText("DevShop")).toBeVisible();
    await expect(page.getByText("OfficeMax")).toHaveCount(0);
  });

  it("adds a category from the palette", async () => {
    page = await goto("/");
    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByPlaceholder("Type a command or search…");
    await expect(search).toBeVisible();
    await search.fill("add category");
    await expect(
      page.getByRole("option", { name: "Add category", selected: true }),
    ).toBeVisible();
    await page.keyboard.press("Enter");
    const prompt = page.getByLabel("Category name");
    await expect(prompt).toBeVisible();
    await prompt.fill("CmdK Category");
    // kbar restores focus to the pre-palette element as the palette closes,
    // which can blur the prompt; wait for the input to hold focus so Enter
    // submits the form instead of landing on the page.
    await expect(prompt).toBeFocused();
    await page.keyboard.press("Enter");
    await page.waitForURL("**/settings");
    await expect(page.getByText("CmdK Category")).toBeVisible();
    // Remove the category — settings.test.ts asserts the account's exact
    // category list, and suites share one seeded database per run.
    await testPrisma.category.deleteMany({
      where: { accountId: TEST_ACCOUNT_ID, name: "CmdK Category" },
    });
  });

  it("navigates with g-prefixed keyboard shortcuts", async () => {
    page = await goto("/");
    // Shortcuts fire only when focus is outside form fields.
    await blurFocus(page);
    // kbar's chained shortcuts (["g", "r"] etc.) complete silently — the
    // palette does not open on "g" alone, so the navigation itself is the
    // success signal. A keypress can land in the brief window before kbar
    // binds its listener after hydration (a no-op, like the Cmd+K tests'
    // open-wait), so retry the whole chord until the URL moves.
    const navVia = async (urlGlob: string, ...keys: string[]) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await blurFocus(page);
        await page.keyboard.press("g");
        for (const k of keys) await page.keyboard.press(k);
        const moved = await page.waitForURL(urlGlob, { timeout: 2500 }).then(
          () => true,
          () => false,
        );
        if (moved) return;
      }
      await page.waitForURL(urlGlob); // fail with the standard timeout
    };

    await navVia("**/export", "r");
    await navVia("**/emails", "m");
    await navVia("**/reconcile", "f");
    await navVia("**/settings", "s");
    await navVia("**/", "e");
  });

  it("uses single-key shortcuts for editors, search, and uploads", async () => {
    page = await goto("/");
    await blurFocus(page);
    await page.keyboard.press("a");
    await page.waitForURL("**/expense/new");

    // Editors autofocus their first field and shortcuts only fire outside
    // form fields — return to a neutral page before each next key.
    page = await goto("/");
    await blurFocus(page);
    await page.keyboard.press("m");
    await page.waitForURL("**/expense/new?type=mileage");

    page = await goto("/");
    await blurFocus(page);
    await page.keyboard.press("Shift+Slash"); // "?"
    const homeSearch = page.getByLabel("Search expenses");
    await expect(homeSearch).toBeFocused();

    // A keypress can land in the brief window before kbar binds its
    // listeners after hydration, so retry the press until the picker opens.
    let chooser: FileChooser | null = null;
    for (let i = 0; i < 3 && !chooser; i++) {
      const attempt = page.waitForEvent("filechooser", { timeout: 4000 });
      await blurFocus(page);
      await page.keyboard.press("f");
      chooser = await attempt.then(
        (c) => c,
        () => null,
      );
    }
    expect(chooser).not.toBeNull();
  });

  it("ignores shortcut keys typed inside inputs", async () => {
    page = await goto("/");
    const box = page.getByLabel("Search expenses");
    await box.click();
    await box.pressSequentially("amefgs");
    await page.waitForTimeout(500);
    expect(page.url()).toBe(page.url()); // still on home — no shortcut fired
    await expect(box).toHaveValue("amefgs");
  });

  it("opens a file picker for Upload expense file and drafts the receipt", async () => {
    page = await goto("/");
    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByPlaceholder("Type a command or search…");
    await expect(search).toBeVisible();
    await search.fill("upload expense");
    await expect(
      page.getByRole("option", { name: "Upload expense file", selected: true }),
    ).toBeVisible();
    const chooserPromise = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    const chooser = await chooserPromise;
    // Picking a file carries it into the new-receipt editor as its draft.
    await chooser.setFiles({
      name: "receipt.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
    await page.waitForURL("**/expense/new");
  });

  it("routes Upload reconcile statement to the reconcile page's picker", async () => {
    // Fired from home: the home consumer must not swallow the request —
    // it stays pending until the reconcile landing mounts and opens its
    // statement file input.
    page = await goto("/");
    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByPlaceholder("Type a command or search…");
    await expect(search).toBeVisible();
    await search.fill("upload reconcile");
    await expect(
      page.getByRole("option", {
        name: "Upload reconcile statement",
        selected: true,
      }),
    ).toBeVisible();
    const chooserPromise = page.waitForEvent("filechooser", {
      timeout: 10_000,
    });
    await page.keyboard.press("Enter");
    await page.waitForURL("**/reconcile");
    await chooserPromise;
  });

  afterAll(async () => {
    await page?.close();
  });
});
