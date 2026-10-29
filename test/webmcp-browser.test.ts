import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { WebMCP } from "@mcp-b/webmcp-polyfill";
import type { Page } from "playwright";
import { describe, expect, it } from "vite-plus/test";
import { freshPage, signIn } from "./helpers/launchBrowser";
import { TEST_EMAIL, TEST_PASSWORD } from "./helpers/seedTestData";

/**
 * The in-page tools in a real browser. No browser here ships WebMCP, so
 * test/webmcp.test.ts can only prove registration against a stub: this file
 * loads the polyfill's standalone build before any page script, which
 * installs a real `document.modelContext` and lets the app's own registration
 * (app/lib/webmcp.ts) run unchanged. Then it calls the tools the way a
 * browser agent would and checks the data that comes back from /api/webmcp/*.
 */

/** The registered tools, sorted by `getTools()` after READ_TOOLS. */
const TOOL_NAMES = ["expense_summary", "list_expenses", "list_reports"];

/** The polyfill's IIFE: it installs on load, so an init script is enough. */
function polyfillScript(): string {
  const require = createRequire(import.meta.url);
  return readFileSync(require.resolve("@mcp-b/webmcp-polyfill/iife"), "utf8");
}

/** A signed-in page whose context installs the polyfill on every navigation. */
async function polyfilledPage(): Promise<Page> {
  const page = await freshPage();
  // Context-level: it runs before every script of each navigation, and a page
  // created before the script is added still receives it on its next one. The
  // login navigation gets it too, which is harmless: registration is gated on
  // a signed-in user.
  await page.context().addInitScript({ content: polyfillScript() });
  await signIn(page, TEST_EMAIL, TEST_PASSWORD);
  return page;
}

async function toolNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const context = (
      document as Document & { modelContext?: WebMCP.ModelContext }
    ).modelContext;
    return context ? (await context.getTools()).map((tool) => tool.name) : [];
  });
}

/** Registration is a mount effect, so poll for it rather than race it. */
async function waitForTools(page: Page): Promise<string[]> {
  const deadline = performance.now() + 15_000;
  let names = await toolNames(page);
  while (names.length < TOOL_NAMES.length && performance.now() < deadline) {
    await page.waitForTimeout(100);
    names = await toolNames(page);
  }
  return names;
}

describe("WebMCP in-page tools (polyfilled browser)", () => {
  it("registers the three read tools, marked read-only", async () => {
    const page = await polyfilledPage();
    expect(await waitForTools(page)).toEqual(TOOL_NAMES);

    const readOnly = await page.evaluate(async () => {
      const context = (
        document as Document & { modelContext?: WebMCP.ModelContext }
      ).modelContext;
      if (!context) throw new Error("no modelContext");
      return (await context.getTools()).map(
        (tool) => tool.annotations?.readOnlyHint,
      );
    });
    expect(readOnly).toEqual([true, true, true]);
  });

  it("serves list_expenses and expense_summary from the session mirror", async () => {
    const page = await polyfilledPage();
    await waitForTools(page);

    const listed = await page.evaluate(async () => {
      const context = (
        document as Document & { modelContext?: WebMCP.ModelContext }
      ).modelContext;
      if (!context) throw new Error("no modelContext");
      const tool = (await context.getTools()).find(
        (candidate) => candidate.name === "list_expenses",
      );
      if (!tool) throw new Error("list_expenses is not registered");
      return JSON.parse(await context.executeTool(tool, { limit: 1 })) as {
        count: number;
        returned: number;
        expenses: unknown[];
      };
    });
    // The page size clamps, and the count over every match survives it.
    expect(listed.returned).toBe(1);
    expect(listed.count).toBeGreaterThan(1);
    expect(listed.expenses).toHaveLength(1);

    const summary = await page.evaluate(async () => {
      const context = (
        document as Document & { modelContext?: WebMCP.ModelContext }
      ).modelContext;
      if (!context) throw new Error("no modelContext");
      const tool = (await context.getTools()).find(
        (candidate) => candidate.name === "expense_summary",
      );
      if (!tool) throw new Error("expense_summary is not registered");
      return JSON.parse(await context.executeTool(tool)) as {
        count: number;
        total: string;
      };
    });
    // Same filters, same totals: the aggregate covers every match, not one.
    expect(summary.count).toBe(listed.count);
    expect(summary.total).toMatch(/^-?\d+\.\d{2}$/);
  });
});
