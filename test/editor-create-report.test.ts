import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { goto } from "./helpers/launchBrowser";
import { TEST_ACCOUNT_ID, testPrisma } from "./helpers/seedTestData";

/**
 * Creating a report from the expense editor. The Report dropdown's
 * "+ New report…" option must make creation simple but deliberate:
 * selecting it only opens an inline name input; nothing is created until
 * the user types a name and confirms with Create (or Enter). Cancel and
 * Escape close the input without side effects. The database is re-seeded
 * before this file, so the fixtures created in beforeAll can stay in place.
 */
describe("Editor: create report", () => {
  let page: Page;

  /** The Report <select>: in the receipt editor (/expense/new) it is the
   * first select on the page (Category renders second), the same convention
   * the existing suite relies on. */
  const reportSelect = (editor: Page) => editor.locator("select").first();

  const reportCount = () =>
    testPrisma.report.count({ where: { accountId: TEST_ACCOUNT_ID } });

  beforeAll(async () => {
    page = await goto("/");
  });

  it("offers + New report… but selecting it creates nothing", async () => {
    const editor = await goto("/expense/new");
    const select = reportSelect(editor);
    // The seeded open reports are there, plus the create-new option.
    await expect(
      select.locator("option", { hasText: "2026 Test" }),
    ).toHaveCount(1);
    await expect(
      select.locator("option", { hasText: "+ New report…" }),
    ).toHaveCount(1);
    // Picking the option opens the inline name input…
    await select.selectOption("__new__");
    const input = editor.getByPlaceholder("New report name");
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    // …but no report exists yet: creation needs the explicit Create click.
    expect(await reportCount()).toBe(2);
    await editor.close();
  });

  it("creates a report from the editor and selects it", async () => {
    const editor = await goto("/expense/new");
    const select = reportSelect(editor);
    await select.selectOption("__new__");
    const input = editor.getByPlaceholder("New report name");
    await input.fill("Editor New");
    await editor.getByRole("button", { name: "Create" }).click();
    // The new report is selected and the inline input is gone.
    await expect(select).toHaveValue("Editor New");
    await expect(input).toHaveCount(0);
    expect(
      await testPrisma.report.findFirst({
        where: { accountId: TEST_ACCOUNT_ID, name: "Editor New" },
      }),
    ).not.toBeNull();
    await editor.close();
  });

  it("Enter creates too", async () => {
    const editor = await goto("/expense/new");
    const select = reportSelect(editor);
    await select.selectOption("__new__");
    const input = editor.getByPlaceholder("New report name");
    await input.fill("Enter Report");
    await input.press("Enter");
    await expect(select).toHaveValue("Enter Report");
    expect(
      await testPrisma.report.findFirst({
        where: { accountId: TEST_ACCOUNT_ID, name: "Enter Report" },
      }),
    ).not.toBeNull();
    await editor.close();
  });

  it("Cancel and Escape revert without creating anything", async () => {
    const editor = await goto("/expense/new");
    const select = reportSelect(editor);
    expect(await reportCount()).toBe(4);
    // Cancel after typing. `.first()`, because the editor's own bottom Cancel
    // button matches the same name.
    await select.selectOption("__new__");
    const input = editor.getByPlaceholder("New report name");
    await input.fill("Never Report");
    await editor.getByRole("button", { name: "Cancel" }).first().click();
    await expect(select).toBeVisible();
    await expect(input).toHaveCount(0);
    // Escape after typing (second attempt).
    await select.selectOption("__new__");
    await editor.getByPlaceholder("New report name").fill("Never Report");
    await editor.getByPlaceholder("New report name").press("Escape");
    await expect(select).toBeVisible();
    await expect(editor.getByPlaceholder("New report name")).toHaveCount(0);
    // Neither attempt created a row.
    expect(await reportCount()).toBe(4);
    await editor.close();
  });

  it("rejects a duplicate name with an inline error", async () => {
    const editor = await goto("/expense/new");
    const select = reportSelect(editor);
    await select.selectOption("__new__");
    const input = editor.getByPlaceholder("New report name");
    await input.fill("2026 Test");
    await editor.getByRole("button", { name: "Create" }).click();
    // The error shows inline and the form stays open; the selection does
    // not silently switch.
    await expect(
      editor.getByText('A report named "2026 Test" already exists.'),
    ).toBeVisible();
    await expect(input).toBeVisible();
    // The Report select is gone; only the Category select remains.
    await expect(editor.locator("select")).toHaveCount(1);
    expect(await reportCount()).toBe(4);
    await editor.close();
  });

  it("assigns the saved expense to the newly created report", async () => {
    const editor = await goto("/expense/new");
    await editor.locator("input[list='merchants']").fill("New Report Shop");
    await editor.locator("input[type='number']").fill("33.33");
    const select = reportSelect(editor);
    await select.selectOption("__new__");
    await editor.getByPlaceholder("New report name").fill("Save Target Report");
    await editor.getByRole("button", { name: "Create" }).click();
    await expect(select).toHaveValue("Save Target Report");
    await editor.getByRole("button", { name: "Save" }).click();
    await editor.waitForURL((url) => url.pathname === "/", {
      timeout: 10_000,
    });
    const row = await testPrisma.expense.findFirst({
      where: {
        accountId: TEST_ACCOUNT_ID,
        merchant: "New Report Shop",
        report: "Save Target Report",
      },
    });
    expect(row).not.toBeNull();
    await editor.close();
  });

  afterAll(async () => {
    await page?.close();
  });
});
