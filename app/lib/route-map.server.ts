import { Resvg, type ResvgRenderOptions } from "@resvg/resvg-js";
import { decodeInlineAsset } from "~/lib/inline-asset";
import { geocodedLocations, type MileageExpense } from "~/lib/types";
import fontInline from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?inline";

/**
 * Render a schematic route map for a mileage trip, embedded in the report
 * PDF (and the MCP export) so the export shows the route the mileage was
 * calculated from.
 *
 * Draws the saved driving geometry — the outbound polyline solid, the
 * return leg dashed — with numbered stop markers, onto a small canvas.
 * Trips saved before route geometry was persisted (or computed while OSRM
 * was down) have no geometry: fall back to straight lines between the
 * geocoded stops. Rasterized with resvg + the bundled JetBrains Mono so it
 * works on serverless runtimes with no system fonts.
 *
 * Returns null when there is nothing drawable (no geometry, fewer than two
 * geocoded stops) — callers skip the map then. Never throws on degenerate
 * input.
 */

const WIDTH = 460;
const HEIGHT = 220;
const PAD = 26;
const FONT = "JetBrains Mono";
const MARKER_R = 9;

/** The rendered map size in points — the PDF embeds it at this size. */
export const ROUTE_MAP_WIDTH = WIDTH;
export const ROUTE_MAP_HEIGHT = HEIGHT;

const fontBytes = decodeInlineAsset(fontInline);

export async function renderRouteMap(
  e: MileageExpense,
): Promise<Buffer | null> {
  const stops = geocodedLocations(e.locations);
  // Outbound: saved geometry when present, else straight lines between the
  // stops (in trip order).
  const outbound: [number, number][] =
    e.route.coords.length >= 2 ? e.route.coords : [];
  let ret: [number, number][] =
    e.route.returnCoords.length >= 2 ? e.route.returnCoords : [];
  if (outbound.length === 0 && stops.length >= 2) {
    for (const s of stops) outbound.push([s.lat, s.lng]);
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    ret = [
      [last.lat, last.lng],
      [first.lat, first.lng],
    ];
  }
  const all = [...outbound, ...ret];
  if (all.length === 0) return null;

  // Equirectangular projection centered on the trip's bounding box; the
  // longitude span is scaled by cos(lat) so the shape isn't stretched.
  const lats = all.map((p) => p[0]);
  const lngs = all.map((p) => p[1]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const midLat = (minLat + maxLat) / 2;
  const midLng = (minLng + maxLng) / 2;
  const cos = Math.cos((midLat * Math.PI) / 180) || 1e-9;
  const spanX = Math.max(maxLng - minLng, 1e-9) * cos;
  const spanY = Math.max(maxLat - minLat, 1e-9);
  const scale = Math.min((WIDTH - 2 * PAD) / spanX, (HEIGHT - 2 * PAD) / spanY);
  const x = (lng: number) => WIDTH / 2 + (lng - midLng) * cos * scale;
  const y = (lat: number) => HEIGHT / 2 - (lat - midLat) * scale;

  const points = (line: [number, number][]) =>
    line.map(([la, ln]) => `${x(ln).toFixed(1)},${y(la).toFixed(1)}`).join(" ");

  const markers = stops
    .map((s, i) => {
      const cx = x(s.lng).toFixed(1);
      const cy = y(s.lat).toFixed(1);
      const label = i === 0 ? "S" : String(i);
      // Baseline offset (~half the 11px cap height) centers the label.
      return `<g>
        <circle cx="${cx}" cy="${cy}" r="${MARKER_R}" fill="#ffffff" stroke="#2563eb" stroke-width="2"/>
        <text x="${cx}" y="${Number(cy) + 4}" font-family="${FONT}" font-size="11" font-weight="700" text-anchor="middle" fill="#1d4ed8">${label}</text>
      </g>`;
    })
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#f8fafc"/>
  <rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" fill="none" stroke="#e2e8f0"/>
  <polyline points="${points(outbound)}" fill="none" stroke="#2563eb" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  ${
    ret.length >= 2
      ? `<polyline points="${points(ret)}" fill="none" stroke="#94a3b8" stroke-width="2.5" stroke-dasharray="6,5" stroke-linecap="round" stroke-linejoin="round"/>`
      : ""
  }
  ${markers}
</svg>`;

  try {
    type FontOptions = ResvgRenderOptions["font"] & {
      fontBuffers?: Buffer[];
    };
    const options: ResvgRenderOptions & { font?: FontOptions } = {
      fitTo: { mode: "original" },
      font: {
        loadSystemFonts: true,
        fontBuffers: [fontBytes],
        defaultFontFamily: FONT,
      },
    };
    return Buffer.from(new Resvg(svg, options).render().asPng());
  } catch {
    return null;
  }
}
