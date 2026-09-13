import { describe, it, expect } from "vitest";
import { renderRouteMap } from "~/lib/route-map.server";
import sharp from "sharp";
import type { MileageExpense } from "~/lib/types";

const makeMileage = (
  overrides: Partial<MileageExpense> = {},
): MileageExpense => ({
  id: "test2",
  type: "mileage",
  mileageType: "business",
  date: "2026-03-10",
  report: "2026 Test",
  category: "Travel",
  description: "",
  amount: "22.40",
  locations: [
    { address: "A", lat: 34.05, lng: -118.24 },
    { address: "B", lat: 34.06, lng: -118.25 },
  ],
  distanceMiles: "32.00",
  roundTrip: true,
  route: { coords: [], returnCoords: [] },
  reconciledAt: "",
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

describe("route map rendering (report PDF)", () => {
  /** Count pixels within `tol` of a target RGB triple. */
  async function countPixels(
    png: Buffer,
    target: [number, number, number],
    tol = 24,
  ): Promise<number> {
    const { data, info } = await sharp(png)
      .raw()
      .toBuffer({ resolveWithObject: true });
    let n = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if (
        Math.abs(data[i]! - target[0]) <= tol &&
        Math.abs(data[i + 1]! - target[1]) <= tol &&
        Math.abs(data[i + 2]! - target[2]) <= tol
      )
        n++;
    }
    return n;
  }

  /** A solid 256×256 tile so tests stay offline (the renderer is given a
   * fake tile fetcher; the real one hits the Carto basemap). Violet: no
   * color in the schematic fallback or the route is anywhere near it, so
   * tile pixels are unambiguous. */
  async function tilePng(): Promise<Buffer> {
    return sharp({
      create: { width: 256, height: 256, channels: 3, background: "#7c3aed" },
    })
      .png()
      .toBuffer();
  }

  const blue: [number, number, number] = [37, 99, 235]; // route line (#2563eb)
  const tile: [number, number, number] = [124, 58, 237]; // fake tile (#7c3aed)

  it("renders a real map: tiles with the route drawn on top", async () => {
    const calls: [number, number, number][] = [];
    const trip = makeMileage({
      route: {
        coords: [
          [34.05, -118.24],
          [34.06, -118.25],
          [34.04, -118.27],
        ],
        returnCoords: [
          [34.04, -118.27],
          [34.05, -118.24],
        ],
      },
    });
    const png = await renderRouteMap(trip, {
      tileFetcher: async (z, x, y) => {
        calls.push([z, x, y]);
        return tilePng();
      },
    });
    expect(png).not.toBeNull();
    const meta = await sharp(png!).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(460);
    expect(meta.height).toBe(220);
    // Tiles were requested at a sane zoom and actually embedded (the fake
    // tile color covers most of the canvas).
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([z]) => z >= 2 && z <= 19)).toBe(true);
    expect(await countPixels(png!, tile)).toBeGreaterThan(1000);
    // The route is drawn on top of the tiles.
    expect(await countPixels(png!, blue)).toBeGreaterThan(200);
  });

  it("renders straight-line trips (no saved geometry) over tiles", async () => {
    // The makeMileage fixture has two geocoded stops and no route geometry.
    const png = await renderRouteMap(makeMileage(), {
      tileFetcher: async () => tilePng(),
    });
    expect(png).not.toBeNull();
    expect(await countPixels(png!, tile)).toBeGreaterThan(1000);
    expect(await countPixels(png!, blue)).toBeGreaterThan(200);
  });

  it("falls back to the schematic when the tile server is unreachable", async () => {
    const trip = makeMileage({
      route: {
        coords: [
          [34.05, -118.24],
          [34.06, -118.25],
        ],
        returnCoords: [
          [34.06, -118.25],
          [34.05, -118.24],
        ],
      },
    });
    const png = await renderRouteMap(trip, {
      tileFetcher: async () => {
        throw new Error("offline");
      },
    });
    expect(png).not.toBeNull();
    // No tile pixels, but the blue route is still drawn.
    expect(await countPixels(png!, tile)).toBe(0);
    expect(await countPixels(png!, blue)).toBeGreaterThan(200);
  });

  it("returns null when there is nothing drawable", async () => {
    const trip = makeMileage({
      locations: [{ address: "Lone stop", lat: null, lng: null }],
      route: { coords: [], returnCoords: [] },
    });
    expect(
      await renderRouteMap(trip, { tileFetcher: async () => tilePng() }),
    ).toBeNull();
  });
});
