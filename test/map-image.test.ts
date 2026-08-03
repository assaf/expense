import sharp from "sharp";
import { describe, it, expect } from "vitest";
import { hasInk } from "~/lib/receipt-render.server";
import { renderRouteMap } from "~/lib/map-image.server";
import type { Location } from "~/lib/types";

/** A real-looking LA route (matches the seeded mileage trip). */
const LA_ROUTE: Location[] = [
  { address: "123 Test St, Testing, CA", lat: 34.0522, lng: -118.2437 },
  { address: "456 Dev Ave, Coding, CA", lat: 34.0622, lng: -118.2537 },
  { address: "789 Loop Rd, Around, CA", lat: 34.0722, lng: -118.2337 },
];

describe("route map rendering", () => {
  it("renders a PNG with the route line and stop markers", async () => {
    const png = await renderRouteMap(LA_ROUTE);

    // PNG magic bytes + the renderer's white canvas size.
    expect(
      png
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe(true);
    const { width, height, channels } = await sharp(png).metadata();
    expect(width).toBe(700);
    expect(height).toBe(380);
    const ch = channels ?? 3;

    // Not a blank image (the fallback chain refuses blank renders anyway).
    expect(await hasInk(png)).toBe(true);

    // The blue route polyline (#2563eb) and amber stop markers (#fbbf24)
    // must actually be painted — a broken font/layout would drop them.
    const raw = await sharp(png).raw().toBuffer();
    let blue = 0;
    let amber = 0;
    for (let i = 0; i < raw.length; i += ch) {
      const r = raw[i]!;
      const g = raw[i + 1]!;
      const b = raw[i + 2]!;
      if (b > 200 && r < 120 && g < 140) blue++; // #2563eb-ish
      if (r > 230 && g > 170 && g < 215 && b < 100) amber++; // #fbbf24-ish
    }
    expect(blue).toBeGreaterThan(200); // the polyline spans the canvas
    expect(amber).toBeGreaterThan(30); // one filled circle per stop
  });

  it("centers a single stop without a polyline", async () => {
    const png = await renderRouteMap([
      { address: "123 Test St, Testing, CA", lat: 34.0522, lng: -118.2437 },
    ]);
    expect(await hasInk(png)).toBe(true);
  });
});
