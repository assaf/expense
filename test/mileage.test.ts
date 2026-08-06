import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { goto } from "./helpers/launchBrowser";
import { TEST_ACCOUNT_ID, testPrisma } from "./helpers/seedTestData";

/** Local-date string (YYYY-MM-DD) — matches the app's `todayDate()`. */
function todayLocal(): string {
  const now = new Date();
  const tz = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - tz).toISOString().slice(0, 10);
}

describe("Mileage expense", () => {
  let page: Page;

  beforeAll(async () => {
    page = await goto("/");
  });

  it("opens the mileage editor without writing a row", async () => {
    const before = await testPrisma.expense.count({
      where: { accountId: TEST_ACCOUNT_ID },
    });
    await page.getByText("Add mileage").click();
    await page.waitForURL(/\/expense\/new\?type=mileage$/, {
      timeout: 10_000,
    });
    await expect(page.getByText("Mileage expense")).toBeVisible();
    // The editor is a draft — nothing is persisted until Save.
    expect(
      await testPrisma.expense.count({
        where: { accountId: TEST_ACCOUNT_ID },
      }),
    ).toBe(before);
  });

  it("saves a new mileage expense", async () => {
    const before = await testPrisma.expense.count({
      where: { accountId: TEST_ACCOUNT_ID },
    });
    await page.goto("/", { waitUntil: "load" });
    await page.getByText("Add mileage").click();
    await page.waitForURL(/\/expense\/new\?type=mileage$/, {
      timeout: 10_000,
    });
    // A new mileage expense starts with today's date too.
    await expect(page.locator("input[type='date']")).toHaveValue(todayLocal());
    await page.getByText("Save").click();
    await page.waitForURL((url) => url.pathname === "/", {
      timeout: 15_000,
    });
    expect(
      await testPrisma.expense.count({
        where: { accountId: TEST_ACCOUNT_ID },
      }),
    ).toBe(before + 1);
  });

  it("opens and views the seeded mileage expense", async () => {
    // Navigate to the seeded mileage (amount 22.40)
    await page.goto("/", { waitUntil: "load" });
    await page.getByRole("link", { name: /22\.40/ }).click();
    await page.waitForURL(/\/expense\//, { timeout: 10_000 });
    await expect(page.getByText("Mileage expense")).toBeVisible();
    const amountInput = page.locator("input[type='number']");
    await expect(amountInput).toHaveValue("22.40");
  });

  it("shows the mileage in the list", async () => {
    await page.goto("/", { waitUntil: "load" });
    await expect(page.getByRole("link", { name: /22\.40/ })).toBeVisible();
  });

  it("recomputes the amount when the type or date changes the rate", async () => {
    await page.goto("/", { waitUntil: "load" });
    await page.getByText("Add mileage").click();
    await page.waitForURL(/\/expense\/new\?type=mileage$/, {
      timeout: 10_000,
    });

    // A new mileage expense defaults to the business type and today's date.
    await expect(page.getByLabel("Type")).toHaveValue("business");

    // Mock the route API: 10.00 mi regardless of the stops.
    await page.route("**/api/route", async (route) => {
      const body = route.request().postData() ?? "";
      const addresses = JSON.parse(body).locations as { address: string }[];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          locations: addresses.map((l) =>
            l.address.trim()
              ? { address: l.address, lat: 34.05, lng: -118.24 }
              : { address: l.address, lat: null, lng: null },
          ),
          distanceMiles: "10.00",
          amount: "7.60", // 10 × $0.76 — whatever the route returns, the
          // type/date changes below recompute from the IRS rate.
          coords: [
            [34.05, -118.24],
            [34.06, -118.23],
          ],
          returnCoords: [],
          approximate: false,
        }),
      });
    });

    const inputs = page.locator("input[placeholder='Address']");
    await inputs.first().fill("");
    await inputs.nth(1).fill("");
    await inputs.first().pressSequentially("1600 Amphitheatre Pkwy", {
      delay: 10,
    });
    await inputs.nth(1).pressSequentially("456 Dev Ave", { delay: 10 });
    await inputs.nth(1).blur();
    await expect(page.locator("input[type='number']")).toHaveValue("7.60");

    // Changing the type picks the new IRS rate and recomputes the amount
    // from the distance: 10.00 mi × $0.14 (charity, every year) = $1.40.
    await page.getByLabel("Type").selectOption("charity");
    await expect(page.locator("input[type='number']")).toHaveValue("1.40");
    await expect(page.getByText("Charity · $0.14/mi")).toBeVisible();

    // Medical: 10.00 × $0.235 (2026 H2) = $2.35.
    await page.getByLabel("Type").selectOption("medical");
    await expect(page.locator("input[type='number']")).toHaveValue("2.35");
    await expect(page.getByText("Medical · $0.235/mi")).toBeVisible();

    // Changing the date can move the trip into a different IRS period:
    // business was $0.725/mi in 2026 H1 → 10.00 × 0.725 = $7.25.
    await page.getByLabel("Type").selectOption("business");
    await page.locator("input[type='date']").fill("2026-03-15");
    await expect(page.locator("input[type='number']")).toHaveValue("7.25");
    await expect(page.getByText("Business · $0.725/mi")).toBeVisible();

    // A date with no published rate clears the amount (never $0.00) and
    // the footer says why.
    await page.locator("input[type='date']").fill("2010-06-01");
    await expect(page.locator("input[type='number']")).toHaveValue("");
    await expect(page.getByText("No rate for this date/type")).toBeVisible();
    await page.unroute("**/api/route");
  });

  it("only geocodes and updates the map when an address field loses focus", async () => {
    await page.goto("/", { waitUntil: "load" });
    await page.getByText("Add mileage").click();
    await page.waitForURL(/\/expense\/new\?type=mileage$/, {
      timeout: 10_000,
    });
    const first = page.locator("input[placeholder='Address']").first();
    await first.fill("");

    const calls: string[] = [];
    await page.route("**/api/route", async (route) => {
      const body = route.request().postData() ?? "";
      calls.push(body);
      const addresses = JSON.parse(body).locations as {
        address: string;
      }[];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          locations: addresses.map((l) => ({
            address: l.address,
            lat: l.address.trim() ? 34.05 : null,
            lng: l.address.trim() ? -118.24 : null,
          })),
          distanceMiles: "10.00",
          amount: "7.00",
          coords: [[34.05, -118.24]],
          approximate: false,
        }),
      });
    });

    // Typing must NOT fire a route request — the map only updates after
    // the field loses focus and the address geocodes successfully.
    await first.pressSequentially("1600 Amphitheatre Pkwy", { delay: 20 });
    await page.waitForTimeout(800);
    expect(calls.length).toBe(0);
    expect(await first.inputValue()).toBe("1600 Amphitheatre Pkwy");

    // Blurring geocodes: exactly one request, carrying the typed address;
    // the recomputed amount lands in the amount field; the text field keeps
    // exactly what was typed (it is never rewritten to an older value).
    await first.blur();
    await expect.poll(() => calls.length).toBe(1);
    expect(
      (JSON.parse(calls[0]!).locations as { address: string }[])[0]!.address,
    ).toBe("1600 Amphitheatre Pkwy");
    expect(await first.inputValue()).toBe("1600 Amphitheatre Pkwy");
    await expect(page.locator("input[type='number']")).toHaveValue("7.00");
    await page.unroute("**/api/route");
  });

  it("defaults a new mileage expense to Travel when that category exists", async () => {
    await testPrisma.category.create({
      data: { name: "Travel", accountId: TEST_ACCOUNT_ID },
    });
    try {
      await page.goto("/", { waitUntil: "load" });
      await page.getByText("Add mileage").click();
      await page.waitForURL(/\/expense\/new\?type=mileage$/, {
        timeout: 10_000,
      });
      // Report + Category selects; the category is the second one.
      await expect(page.getByLabel("Category")).toHaveValue("Travel");
    } finally {
      await testPrisma.category.deleteMany({
        where: { name: "Travel", accountId: TEST_ACCOUNT_ID },
      });
    }
  });

  it("leaves the category unset when no Travel category exists", async () => {
    // The seeded categories have no Travel — the editor starts unset.
    await page.goto("/", { waitUntil: "load" });
    await page.getByText("Add mileage").click();
    await page.waitForURL(/\/expense\/new\?type=mileage$/, {
      timeout: 10_000,
    });
    await expect(page.getByLabel("Category")).toHaveValue("");
  });

  it("always keeps a start and a first stop; extra stops can be removed", async () => {
    await page.goto("/", { waitUntil: "load" });
    await page.getByText("Add mileage").click();
    await page.waitForURL(/\/expense\/new\?type=mileage$/, {
      timeout: 10_000,
    });

    // A new mileage starts with Start/end + Stop 1 and no remove buttons.
    const inputs = page.locator("input[placeholder='Address']");
    await expect(inputs).toHaveCount(2);
    await expect(page.getByText("Start / end", { exact: true })).toBeVisible();
    await expect(page.getByText("Stop 1", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove stop" })).toHaveCount(
      0,
    );

    // Adding stops gives them a remove button; the start + first stop stay
    // protected.
    await page.getByRole("button", { name: "Add stop" }).click();
    await expect(inputs).toHaveCount(3);
    await expect(page.getByText("Stop 2", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove stop" })).toHaveCount(
      1,
    );

    // The extra stop can be removed; the required two cannot.
    await page.getByRole("button", { name: "Remove stop" }).click();
    await expect(inputs).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Remove stop" })).toHaveCount(
      0,
    );
  });

  it("updates the field to the geocoded address on blur, or shows an error", async () => {
    await page.goto("/", { waitUntil: "load" });
    await page.getByText("Add mileage").click();
    await page.waitForURL(/\/expense\/new\?type=mileage$/, {
      timeout: 10_000,
    });
    const first = page.locator("input[placeholder='Address']").first();
    await first.fill("");

    let fail = false;
    await page.route("**/api/route", async (route) => {
      const body = route.request().postData() ?? "";
      const addresses = JSON.parse(body).locations as { address: string }[];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          locations: addresses.map((l) =>
            fail || !l.address.trim()
              ? { address: l.address, lat: null, lng: null }
              : {
                  address: `${l.address}, Mountain View, CA, USA`,
                  lat: 34.05,
                  lng: -118.24,
                },
          ),
          distanceMiles: "10.00",
          amount: "7.00",
          coords: [[34.05, -118.24]],
          approximate: false,
        }),
      });
    });

    // Successful geocode → the field is updated to the geocoded address.
    await first.pressSequentially("1600 Amphitheatre Pkwy", { delay: 20 });
    await first.blur();
    await expect
      .poll(() => first.inputValue())
      .toBe("1600 Amphitheatre Pkwy, Mountain View, CA, USA");

    // Failed geocode → an error under the field; the typed text is kept
    // (never guessed at).
    fail = true;
    await first.fill("Nowhere Lane ZZ");
    await first.blur();
    await expect(page.getByText("Couldn't find that address")).toBeVisible();
    expect(await first.inputValue()).toBe("Nowhere Lane ZZ");

    // Editing the field clears the error (it will be retried on blur).
    await first.fill("1600 Amphitheatre Pkwy");
    await expect(page.getByText("Couldn't find that address")).toHaveCount(0);
    await page.unroute("**/api/route");
  });

  it("shows a geocoding indicator while the address is being geocoded", async () => {
    await page.goto("/", { waitUntil: "load" });
    await page.getByText("Add mileage").click();
    await page.waitForURL(/\/expense\/new\?type=mileage$/, {
      timeout: 10_000,
    });
    const first = page.locator("input[placeholder='Address']").first();
    await first.fill("");

    // Hold every route response so the geocode stays in flight on demand.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await page.route("**/api/route", async (route) => {
      await gate;
      const body = route.request().postData() ?? "";
      const addresses = JSON.parse(body).locations as { address: string }[];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          locations: addresses.map((l) =>
            l.address.trim()
              ? {
                  address: `${l.address}, Mountain View, CA, USA`,
                  lat: 34.05,
                  lng: -118.24,
                }
              : { address: l.address, lat: null, lng: null },
          ),
          distanceMiles: "10.00",
          amount: "7.00",
          coords: [[34.05, -118.24]],
          approximate: false,
        }),
      });
    });

    const spinner = page.getByLabel("Geocoding address");
    await first.pressSequentially("1600 Amphitheatre Pkwy", { delay: 20 });
    await first.blur();

    // The per-field spinner is visible while the geocode is in flight…
    await expect(spinner).toBeVisible();
    // …and so is the "Calculating route…" pill over the map (geocoding +
    // OSRM can take a couple of seconds — the pill is the feedback).
    await expect(page.getByText("Calculating route…")).toBeVisible();
    // …and once it resolves, the field shows the geocoded address, the
    // spinner is gone, and the pill disappears.
    release();
    await expect
      .poll(() => first.inputValue())
      .toBe("1600 Amphitheatre Pkwy, Mountain View, CA, USA");
    await expect(spinner).toHaveCount(0);
    await expect(page.getByText("Calculating route…")).toHaveCount(0);
    await page.unroute("**/api/route");
  });

  it("drops empty addresses when saving", async () => {
    await page.goto("/", { waitUntil: "load" });
    await page.getByText("Add mileage").click();
    await page.waitForURL(/\/expense\/new\?type=mileage$/, {
      timeout: 10_000,
    });
    // The Start/end is prefilled with the seeded home address; Stop 1 is left
    // blank. Saving must persist only the real address.
    const inputs = page.locator("input[placeholder='Address']");
    await expect(inputs).toHaveCount(2);
    await inputs.nth(1).fill("");

    await page.getByText("Save").click();
    await page.waitForURL((url) => url.pathname === "/", {
      timeout: 15_000,
    });

    const saved = await testPrisma.expense.findFirst({
      where: { accountId: TEST_ACCOUNT_ID, type: "mileage" },
      orderBy: { createdAt: "desc" },
    });
    const locations = saved?.locations as { address: string }[];
    expect(locations.length).toBe(1);
    expect(locations[0]!.address).toBe("123 Test St, Testing, CA");
    // The blank stop is not persisted even as a placeholder.
    expect(locations.some((l) => l.address.trim() === "")).toBe(false);
  });

  it("recomputes the route without a location when its field is emptied", async () => {
    await page.goto("/", { waitUntil: "load" });
    await page.getByText("Add mileage").click();
    await page.waitForURL(/\/expense\/new\?type=mileage$/, {
      timeout: 10_000,
    });
    const inputs = page.locator("input[placeholder='Address']");
    const calls: string[] = [];
    await page.route("**/api/route", async (route) => {
      const body = route.request().postData() ?? "";
      calls.push(body);
      const addresses = JSON.parse(body).locations as { address: string }[];
      const filled = addresses.filter((l) => l.address.trim() !== "");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          locations: addresses.map((l) =>
            l.address.trim()
              ? { address: l.address, lat: 34.05, lng: -118.24 }
              : { address: l.address, lat: null, lng: null },
          ),
          // Distance/amount scale with how many stops remain in the trip.
          distanceMiles: String(filled.length * 10),
          amount: String(filled.length * 7),
          coords: filled.map(() => [34.05, -118.24]),
          returnCoords: [],
          approximate: false,
        }),
      });
    });

    // Two stops → blurring the second geocodes the trip (2 × $7).
    await inputs.first().fill("1600 Amphitheatre Pkwy");
    await inputs.nth(1).fill("456 Dev Ave");
    await inputs.nth(1).blur();
    await expect(page.locator("input[type='number']")).toHaveValue("14");

    // Emptying a stop and blurring recomputes the trip without it — the
    // latest request carries the blank address (the server drops it) and
    // the amount reflects the single remaining stop.
    await inputs.nth(1).fill("");
    await inputs.nth(1).blur();
    await expect(page.locator("input[type='number']")).toHaveValue("7");
    const sent = JSON.parse(calls[calls.length - 1]!) as {
      locations: { address: string }[];
    };
    expect(sent.locations[1]!.address.trim()).toBe("");
    await page.unroute("**/api/route");
  });

  it("shows the stop address (street, city) in the map tooltip", async () => {
    await page.goto("/", { waitUntil: "load" });
    await page.getByText("Add mileage").click();
    await page.waitForURL(/\/expense\/new\?type=mileage$/, {
      timeout: 10_000,
    });
    const inputs = page.locator("input[placeholder='Address']");
    // Mock the route API BEFORE typing so no real geocode ever fires.
    await page.route("**/api/route", async (route) => {
      const body = route.request().postData() ?? "";
      const addresses = JSON.parse(body).locations as { address: string }[];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          // Contains HTML-ish text on purpose: tooltip content is rendered
          // as HTML by Leaflet, so it must arrive escaped.
          locations: addresses.map((l, i) => ({
            address: l.address.trim()
              ? "1600 <b>Amphitheatre</b> Parkway, Mountain View, CA"
              : l.address,
            lat: l.address.trim() ? 34.05 + i * 0.01 : null,
            lng: l.address.trim() ? -118.24 + i * 0.01 : null,
          })),
          distanceMiles: "10.00",
          amount: "7.00",
          coords: [
            [34.05, -118.24],
            [34.06, -118.23],
          ],
          approximate: false,
        }),
      });
    });
    await inputs.first().fill("");
    await inputs.nth(1).fill("");
    await inputs.first().pressSequentially("1600 Amphitheatre Pkwy", {
      delay: 20,
    });
    await inputs.nth(1).pressSequentially("456 Dev Ave", { delay: 20 });
    // Blur the focused field to fire the geocode, then hover the first
    // stop bubble (numbered; the casing/line are drawn underneath).
    await inputs.nth(1).blur();
    const marker = page.locator(".map-stop-bubble");
    await expect.poll(() => marker.count()).toBe(2);
    // Hover ~12px from the marker's center — just inside the invisible 14px
    // hit area but well outside the small visible dot — proving the bigger
    // target, not just a hover dead-center on the marker.
    const box = (await marker.first().boundingBox())!;
    await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2);
    const tooltip = page.locator(".leaflet-tooltip");
    await expect(tooltip).toBeVisible();
    // Street + city only — the state is left off the tooltip.
    await expect(tooltip).toContainText("Start / end — 1600");
    await expect(tooltip).not.toContainText("Mountain View, CA");
    // The address's HTML-like text is escaped — it shows literally as text,
    // never as a real <b> element.
    await expect(tooltip).toContainText("<b>Amphitheatre</b>");
    await expect(tooltip.locator("b")).toHaveCount(0);
    await page.unroute("**/api/route");
  });

  it("geocodes un-blurred addresses when saving", async () => {
    // Typing addresses and hitting Save without blurring the fields must
    // still geocode the trip, so the saved expense keeps its route,
    // distance, and amount.
    await page.goto("/", { waitUntil: "load" });
    await page.getByText("Add mileage").click();
    await page.waitForURL(/\/expense\/new\?type=mileage$/, {
      timeout: 10_000,
    });
    const inputs = page.locator("input[placeholder='Address']");
    await inputs.first().fill("");
    await inputs.nth(1).fill("");
    await inputs.first().pressSequentially("1600 Amphitheatre Pkwy", {
      delay: 10,
    });
    await inputs.nth(1).pressSequentially("456 Dev Ave", { delay: 10 });

    let calls = 0;
    await page.route("**/api/route", async (route) => {
      calls++;
      const body = route.request().postData() ?? "";
      const addresses = JSON.parse(body).locations as { address: string }[];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          locations: addresses.map((l) => ({
            address: l.address,
            lat: l.address.trim() ? 34.05 : null,
            lng: l.address.trim() ? -118.24 : null,
          })),
          distanceMiles: "10.00",
          amount: "7.00",
          coords: [
            [34.05, -118.24],
            [34.06, -118.25],
          ],
          approximate: false,
        }),
      });
    });

    await page.getByText("Save").click();
    await page.waitForURL((url) => url.pathname === "/", {
      timeout: 15_000,
    });
    expect(calls).toBeGreaterThan(0);

    const saved = await testPrisma.expense.findFirst({
      where: { accountId: TEST_ACCOUNT_ID, type: "mileage" },
      orderBy: { createdAt: "desc" },
    });
    expect(saved?.distanceMiles?.toFixed(2)).toBe("10.00");
    expect(saved?.amount?.toFixed(2)).toBe("7.00");
    const locations = saved?.locations as {
      address: string;
      lat: number | null;
    }[];
    expect(locations[0]?.lat).toBe(34.05);
    expect(locations[1]?.lat).toBe(34.05);
    // The computed route geometry is persisted with the expense, so every
    // map shows the driving route — not straight point-to-point lines.
    const route = saved?.route as {
      coords: [number, number][];
      returnCoords: [number, number][];
    } | null;
    expect(route?.coords).toEqual([
      [34.05, -118.24],
      [34.06, -118.25],
    ]);

    // Reopening the saved expense renders that saved route on load (the
    // blue line draws from the stored geometry, no recompute needed).
    await page.goto(`/expense/${saved!.id}`, { waitUntil: "load" });
    await expect
      .poll(() =>
        page.locator(".leaflet-overlay-pane path[stroke='#2563eb']").count(),
      )
      .toBe(1);
    await page.unroute("**/api/route");
  });

  it("shows a route error when the API returns 500 and still allows saving", async () => {
    await page.goto("/", { waitUntil: "load" });
    await page.getByText("Add mileage").click();
    await page.waitForURL(/\/expense\/new\?type=mileage$/, {
      timeout: 10_000,
    });
    const inputs = page.locator("input[placeholder='Address']");
    await inputs.first().fill("");
    await inputs.nth(1).fill("");

    await page.route("**/api/route", async (route) => {
      await route.fulfill({ status: 500, body: "boom" });
    });

    await inputs.first().pressSequentially("1600 Amphitheatre Pkwy", {
      delay: 10,
    });
    await inputs.first().blur();

    // The error is surfaced under the geocoded field.
    await expect(page.getByText(/route unavailable/i)).toBeVisible({
      timeout: 15_000,
    });
    // The amount stays empty — no stale value from a previous geocode.
    await expect(page.locator("input[type='number']")).toHaveValue("");
    // The "Calculating route…" pill disappears (doesn't spin forever).
    await expect(page.getByText("Calculating route…")).toHaveCount(0);

    // Saving still works — the expense is saved without a route or amount.
    await page.getByText("Save").click();
    await page.waitForURL((url) => url.pathname === "/", {
      timeout: 15_000,
    });
    const saved = await testPrisma.expense.findFirst({
      where: { accountId: TEST_ACCOUNT_ID, type: "mileage" },
      orderBy: { createdAt: "desc" },
    });
    expect(saved).not.toBeNull();
    // No distance, no amount — but the expense still exists.
    expect(saved!.distanceMiles).toBeFalsy();
    expect(saved!.amount).toBeFalsy();
    await page.unroute("**/api/route");
  });

  it("keeps the typed addresses and shows an error when geocoding fails to match", async () => {
    await page.goto("/", { waitUntil: "load" });
    await page.getByText("Add mileage").click();
    await page.waitForURL(/\/expense\/new\?type=mileage$/, {
      timeout: 10_000,
    });
    const first = page.locator("input[placeholder='Address']").first();
    await first.fill("");

    await page.route("**/api/route", async (route) => {
      const body = route.request().postData() ?? "";
      const addresses = JSON.parse(body).locations as { address: string }[];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          locations: addresses.map((l) => ({
            address: l.address,
            lat: null,
            lng: null,
          })),
          distanceMiles: "",
          amount: "",
          coords: [],
          approximate: false,
        }),
      });
    });

    await first.pressSequentially("Nowhere Lane ZZ", { delay: 10 });
    await first.blur();
    // The typed text is kept — never replaced with a guess.
    expect(await first.inputValue()).toBe("Nowhere Lane ZZ");
    await expect(page.getByText(/couldn't find that address/i)).toBeVisible({
      timeout: 15_000,
    });
    await page.unroute("**/api/route");
  });

  afterAll(async () => {
    await page?.close();
  });
});
