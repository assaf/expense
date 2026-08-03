import type { Page } from "playwright";
import { expect } from "playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { goto } from "./helpers/launchBrowser";

/**
 * Mileage map rendering: the light Carto basemap, the cased route (white
 * underlay + blue line) with a gray dashed return leg, the numbered stop
 * bubbles with their invisible hit areas, and — critically — that
 * redrawing the route replaces the old layers instead of accumulating
 * them.
 */
describe("Mileage map rendering", () => {
  let page: Page;

  beforeAll(async () => {
    page = await goto("/");
  });

  /** Mock the route API so geocoding is deterministic and offline. */
  function mockRoute(): void {
    void page.route("**/api/route", async (route) => {
      const body = route.request().postData() ?? "";
      const addresses = JSON.parse(body).locations as { address: string }[];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          locations: addresses.map((l, i) => ({
            address: l.address,
            lat: l.address.trim() ? 34.05 + i * 0.01 : null,
            lng: l.address.trim() ? -118.24 + i * 0.01 : null,
          })),
          distanceMiles: "10.00",
          amount: "7.00",
          coords: [
            [34.05, -118.24],
            [34.06, -118.23],
          ],
          returnCoords: [
            [34.06, -118.23],
            [34.05, -118.24],
          ],
          approximate: false,
        }),
      });
    });
  }

  async function openEditorWithRoute(): Promise<{
    inputs: import("playwright").Locator;
  }> {
    await page.getByText("Add mileage").click();
    await page.waitForURL(/\/expense\/new\?type=mileage$/, {
      timeout: 10_000,
    });
    const inputs = page.locator("input[placeholder='Address']");
    await inputs.first().fill("");
    await inputs.nth(1).fill("");
    await inputs.first().pressSequentially("Wilshire Blvd", { delay: 20 });
    await inputs.nth(1).pressSequentially("Santa Monica Pier", { delay: 20 });
    // Field 1 has focus — blurring it fires the geocode.
    await inputs.nth(1).blur();
    return { inputs };
  }

  it("renders the light basemap with a cased route and stable layers", async () => {
    mockRoute();
    await openEditorWithRoute();

    // The map uses the light Carto basemap, not the busy OSM style.
    await page.waitForFunction(
      () => document.querySelectorAll(".leaflet-tile").length > 0,
      { timeout: 10_000 },
    );
    const tileSrcs = await page
      .locator(".leaflet-tile")
      .evaluateAll((els) => els.map((e) => (e as HTMLImageElement).src));
    expect(tileSrcs.length).toBeGreaterThan(0);
    expect(tileSrcs[0]!).toContain("cartocdn");

    // The route is a white casing + blue line (2 polylines) with a gray
    // dashed return leg, each stop has a numbered bubble and an invisible
    // hit area, and the polylines are drawn underneath the bubbles.
    await expect.poll(() => page.locator(".map-stop-bubble").count()).toBe(2);
    expect(await page.locator(".map-stop-bubble").first().textContent()).toBe(
      "S",
    ); // the start bubble is labeled S
    expect(
      await page.locator(".leaflet-overlay-pane path[fill='#000000']").count(),
    ).toBe(2); // invisible hit areas
    expect(
      await page
        .locator(".leaflet-overlay-pane path[stroke='#2563eb']")
        .count(),
    ).toBe(1); // blue route line
    expect(
      await page
        .locator(".leaflet-overlay-pane path[stroke='#ffffff']")
        .count(),
    ).toBe(1); // white casing
    expect(
      await page
        .locator(".leaflet-overlay-pane path[stroke='#6b7280']")
        .count(),
    ).toBe(1); // gray dashed return leg

    // Redrawing (a second geocode) replaces the layers — the counts must
    // not grow (regression: stop markers used to accumulate).
    await page.goto("/", { waitUntil: "load" });
    const { inputs } = await openEditorWithRoute();
    await inputs.first().blur();
    await expect.poll(() => page.locator(".map-stop-bubble").count()).toBe(2);
    expect(
      await page.locator(".leaflet-overlay-pane path[fill='#000000']").count(),
    ).toBe(2);
    expect(
      await page
        .locator(".leaflet-overlay-pane path[stroke='#2563eb']")
        .count(),
    ).toBe(1);
    expect(
      await page
        .locator(".leaflet-overlay-pane path[stroke='#ffffff']")
        .count(),
    ).toBe(1);
    expect(
      await page
        .locator(".leaflet-overlay-pane path[stroke='#6b7280']")
        .count(),
    ).toBe(1);
    await page.unroute("**/api/route");
  });

  afterAll(async () => {
    await page?.close();
  });
});
