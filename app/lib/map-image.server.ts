import sharp from "sharp";
import { Resvg, type ResvgRenderOptions } from "@resvg/resvg-js";
import { escapeHtml } from "~/lib/escape";
import { decodeInlineAsset } from "~/lib/inline-asset";
import { hasInk } from "~/lib/receipt-render.server";
import { geocodedLocations, type Location } from "~/lib/types";
import fontInline from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?inline";

/**
 * Render a mileage route as a PNG map for the report PDF export — no tiles,
 * no external service: the stops are projected onto a flat canvas
 * (equirectangular around the route bounds) with a polyline and labeled
 * markers. Rasterized through the same chain as the text receipt renderer
 * (sharp/librsvg with the bundled font embedded, resvg as fallback), so it
 * works on serverless runtimes that have no system fonts.
 */

const MAP_WIDTH = 700;
const MAP_HEIGHT = 380;
const PAD = 48;
const FONT_FAMILY = "JetBrains Mono";

const fontBytes = decodeInlineAsset(fontInline);

/** Cap a stop address so labels don't overflow the map. */
function shorten(address: string, max = 26): string {
  return address.length > max ? `${address.slice(0, max - 1)}…` : address;
}

/** Build the SVG for a route map: the stops in order joined by a closed
 * polyline (Home → … → Home) with a labeled marker per stop. */
function buildRouteMapSvg(locations: Location[]): string {
  const stops = geocodedLocations(locations).filter(
    (l) => l.address.trim() !== "",
  );
  let minLat = Infinity,
    maxLat = -Infinity,
    minLng = Infinity,
    maxLng = -Infinity;
  for (const s of stops) {
    minLat = Math.min(minLat, s.lat);
    maxLat = Math.max(maxLat, s.lat);
    minLng = Math.min(minLng, s.lng);
    maxLng = Math.max(maxLng, s.lng);
  }
  if (stops.length === 0) {
    minLat = minLng = 0;
    maxLat = maxLng = 0;
  }
  // A single point (or an identical cluster) still gets a centered, usable
  // map instead of a zero-size projection.
  if (maxLat - minLat < 0.004) {
    const c = (minLat + maxLat) / 2;
    minLat = c - 0.002;
    maxLat = c + 0.002;
  }
  if (maxLng - minLng < 0.004) {
    const c = (minLng + maxLng) / 2;
    minLng = c - 0.002;
    maxLng = c + 0.002;
  }
  const W = MAP_WIDTH - PAD * 2;
  const H = MAP_HEIGHT - PAD * 2;
  const x = (lng: number) => PAD + ((lng - minLng) / (maxLng - minLng)) * W;
  const y = (lat: number) => PAD + ((maxLat - lat) / (maxLat - minLat)) * H;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MAP_WIDTH}" height="${MAP_HEIGHT}">`,
    `<rect width="${MAP_WIDTH}" height="${MAP_HEIGHT}" fill="#ffffff"/>`,
    `<rect x="1" y="1" width="${MAP_WIDTH - 2}" height="${MAP_HEIGHT - 2}" fill="none" stroke="#e5e7eb" stroke-width="1"/>`,
    `<g font-family="${FONT_FAMILY}">`,
  ];

  // The route runs Home → … → Home, so the polyline closes back to the
  // first stop when there are 2+ geocoded stops.
  if (stops.length >= 2) {
    const loop = [...stops, stops[0]];
    const points = loop
      .map((s) => `${x(s.lng).toFixed(1)},${y(s.lat).toFixed(1)}`)
      .join(" ");
    parts.push(
      `<polyline points="${points}" fill="none" stroke="#2563eb" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
  }

  for (const [i, s] of stops.entries()) {
    const cx = x(s.lng).toFixed(1);
    const cy = y(s.lat).toFixed(1);
    const label = i === 0 ? "Start" : `Stop ${i}`;
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="7" fill="#fbbf24" stroke="#111827" stroke-width="2"/>`,
      `<text x="${cx}" y="${(Number(cy) - 12).toFixed(1)}" font-size="13" font-weight="700" fill="#111827" text-anchor="middle">${escapeHtml(label)}</text>`,
      `<text x="${cx}" y="${(Number(cy) + 24).toFixed(1)}" font-size="10" fill="#6b7280" text-anchor="middle">${escapeHtml(shorten(s.address))}</text>`,
    );
  }

  parts.push("</g>", "</svg>");
  return parts.join("");
}

/** The SVG with the bundled font embedded as a data-URI @font-face
 * (serverless runtimes have no system fonts). */
function embedFontFace(svg: string): string {
  const style = `<style>@font-face{font-family:'${FONT_FAMILY}';src:url(data:font/woff2;base64,${fontBytes.toString("base64")}) format('woff2')}</style>`;
  return svg.replace(/(<svg[^>]*>)/, `$1<defs>${style}</defs>`);
}

/**
 * Rasterize a route map to a PNG buffer — sharp (librsvg) first, resvg as
 * fallback, mirroring the receipt renderer's chain. Throws when nothing
 * produces a non-blank image; callers fall back to the text summary rather
 * than embedding a broken/blank map.
 */
export async function renderRouteMap(locations: Location[]): Promise<Buffer> {
  const svg = buildRouteMapSvg(locations);
  const failures: string[] = [];

  try {
    const png = await sharp(Buffer.from(embedFontFace(svg)))
      .png()
      .toBuffer();
    if (await hasInk(png)) return png;
    failures.push("sharp svg render came back blank");
  } catch (err) {
    failures.push(
      `sharp svg render failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // fontBuffers is supported at runtime (resvg fontdb) but not yet in the
  // published type defs — extend the options shape via an intersection.
  type ResvgFontOptions = ResvgRenderOptions["font"] & {
    fontBuffers?: Buffer[];
  };
  try {
    const png = new Resvg(svg, {
      fitTo: { mode: "original" },
      font: {
        loadSystemFonts: true,
        fontBuffers: [fontBytes],
        defaultFontFamily: FONT_FAMILY,
      } as ResvgFontOptions,
    })
      .render()
      .asPng();
    if (await hasInk(png)) return png;
    failures.push("resvg render came back blank");
  } catch (err) {
    failures.push(
      `resvg render failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  throw new Error(`Unable to render route map (${failures.join("; ")})`);
}
