import { Resvg } from "@resvg/resvg-js";
import {
  JETBRAINS_MONO,
  jetbrainsMonoBytes,
  resvgFontOptions,
} from "~/lib/resvg-font.server";
import { MAP_USER_AGENT } from "~/lib/maps.server";
import { geocodedLocations, type MileageExpense } from "~/lib/types";

/**
 * Render a real map of a mileage trip for the report PDF — the same look
 * as the mileage editor's Leaflet map: Carto Positron light tiles with the
 * measured route drawn on top (white-cased blue outbound line, dashed gray
 * return leg, numbered stop bubbles).
 *
 * The tiles are fetched server-side (with a descriptive User-Agent and a
 * small in-process cache so trips in the same city share tiles), stitched
 * into an SVG as data URIs, and rasterized with resvg + the bundled
 * JetBrains Mono — no system fonts needed on serverless runtimes.
 *
 * If the tile server is unreachable (offline/blocked), the map falls back
 * to a schematic rendering (route drawn on a plain background) so an export
 * never fails over a map. Returns null only when there is nothing drawable
 * (no geometry, fewer than two geocoded stops).
 */

const WIDTH = 460;
const HEIGHT = 220;
const TILE = 256;
const PAD = 28;
const TILE_SUBDOMAINS = ["a", "b", "c", "d"] as const;
const TILE_CACHE_MAX = 200;

/** The tile fetcher signature — injectable so tests stay offline. */
type TileFetcher = (z: number, x: number, y: number) => Promise<Buffer>;

/** In-memory tile cache (a promise per key): trips in the same city share
 * tiles and concurrent renders dedupe. Evicts the oldest past the cap. */
const tileCache = new Map<string, Promise<Buffer>>();

/** Fetch one Carto Positron light tile — the same basemap the editor's
 * Leaflet map uses (attribution is drawn on every rendered map). */
async function fetchTile(z: number, x: number, y: number): Promise<Buffer> {
  const key = `${z}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached) return cached;
  const promise = (async () => {
    const sub = TILE_SUBDOMAINS[(x + y) % TILE_SUBDOMAINS.length];
    const res = await fetch(
      `https://${sub}.basemaps.cartocdn.com/light_all/${key}.png`,
      {
        headers: { "User-Agent": MAP_USER_AGENT, Accept: "image/png" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) throw new Error(`tile ${key}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  })();
  tileCache.set(key, promise);
  if (tileCache.size > TILE_CACHE_MAX) {
    const oldest = tileCache.keys().next().value;
    if (oldest !== undefined) tileCache.delete(oldest);
  }
  try {
    return await promise;
  } catch (err) {
    tileCache.delete(key);
    throw err;
  }
}

/** Web-Mercator world pixel position at zoom z (256px tiles) — the same
 * projection Leaflet uses, so the route lands exactly where the editor's
 * map draws it. */
function worldX(lon: number, z: number): number {
  return ((lon + 180) / 360) * TILE * 2 ** z;
}

function worldY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
    TILE *
    2 ** z
  );
}

/** The highest zoom at which the route bounds fit the canvas with padding. */
function pickZoom(
  minLon: number,
  maxLon: number,
  minLat: number,
  maxLat: number,
): number {
  for (let z = 19; z >= 2; z--) {
    const w = worldX(maxLon, z) - worldX(minLon, z);
    const h = worldY(minLat, z) - worldY(maxLat, z);
    if (w <= WIDTH - 2 * PAD && h <= HEIGHT - 2 * PAD) {
      return z;
    }
  }
  return 2;
}

/** The trip's drawable geometry: outbound + return polylines ([lat, lng])
 * and the geocoded stops. */
interface TripGeometry {
  outbound: [number, number][];
  ret: [number, number][];
  stops: { lat: number; lng: number }[];
}

/** The trip's drawable geometry for the current expense, or null when there
 * is nothing to draw. Trips without saved route geometry fall back to
 * straight lines between stops. */
function tripGeometry(e: MileageExpense): TripGeometry | null {
  const stops = geocodedLocations(e.locations);
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
  if (outbound.length === 0 && ret.length === 0) return null;
  return { outbound, ret, stops };
}

/** The route's bounding box (and midpoint) on the canvas. */
function routeBounds(geo: TripGeometry): {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
  midLon: number;
  midLat: number;
} {
  const all = [...geo.outbound, ...geo.ret];
  const lons = all.map((p) => p[1]);
  const lats = all.map((p) => p[0]);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  return {
    minLon,
    maxLon,
    minLat,
    maxLat,
    midLon: (minLon + maxLon) / 2,
    midLat: (minLat + maxLat) / 2,
  };
}

/** The route drawing shared by the tiled map and the schematic fallback —
 * dashed gray return under a white-cased blue outbound line with numbered
 * stop bubbles, the same visual language as the editor's map. */
function routeSvg(
  geo: TripGeometry,
  px: (lon: number, lat: number) => { x: number; y: number },
): string {
  const pts = (line: [number, number][]) =>
    line
      .map(([la, ln]) => {
        const p = px(ln, la);
        return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      })
      .join(" ");
  return `
  ${
    geo.ret.length >= 2
      ? `<polyline points="${pts(geo.ret)}" fill="none" stroke="#6b7280" stroke-width="3" stroke-dasharray="6,6" stroke-linecap="round" stroke-linejoin="round"/>`
      : ""
  }
  <polyline points="${pts(geo.outbound)}" fill="none" stroke="#ffffff" stroke-width="8" opacity="0.95" stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="${pts(geo.outbound)}" fill="none" stroke="#2563eb" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  ${markersSvg(geo.stops, px)}`;
}

/**
 * Render the trip map: real tiles when reachable, schematic otherwise.
 * Never throws — a tile failure falls back to the plain drawing.
 */
export async function renderRouteMap(
  e: MileageExpense,
  opts: { tileFetcher?: TileFetcher } = {},
): Promise<Buffer | null> {
  const geo = tripGeometry(e);
  if (!geo) return null;
  const fetcher = opts.tileFetcher ?? fetchTile;
  try {
    return await renderTiled(geo, fetcher);
  } catch (err) {
    console.warn(
      "[route-map] tile render failed, falling back to schematic: %s",
      err instanceof Error ? err.message : String(err),
    );
    return renderSchematic(geo);
  }
}

/** The real map: Carto light tiles with the route and markers on top. */
async function renderTiled(
  geo: TripGeometry,
  fetcher: TileFetcher,
): Promise<Buffer> {
  const { minLon, maxLon, minLat, maxLat, midLon, midLat } = routeBounds(geo);
  const z = pickZoom(minLon, maxLon, minLat, maxLat);
  const ox = worldX(midLon, z) - WIDTH / 2;
  const oy = worldY(midLat, z) - HEIGHT / 2;

  const minTx = Math.floor(ox / TILE);
  const maxTx = Math.floor((ox + WIDTH) / TILE);
  const minTy = Math.floor(oy / TILE);
  const maxTy = Math.floor((oy + HEIGHT) / TILE);

  const tiles: { tx: number; ty: number; href: string }[] = [];
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      const buf = await fetcher(z, tx, ty);
      const href = `data:image/png;base64,${buf.toString("base64")}`;
      tiles.push({ tx, ty, href });
    }
  }

  const px = (lon: number, lat: number) => ({
    x: worldX(lon, z) - ox,
    y: worldY(lat, z) - oy,
  });

  return renderSvg(
    wrapSvg(
      `${tiles
        .map(
          (t) =>
            `<image href="${t.href}" x="${(t.tx * TILE - ox).toFixed(1)}" y="${(t.ty * TILE - oy).toFixed(1)}" width="${TILE}" height="${TILE}"/>`,
        )
        .join("")}${routeSvg(geo, px)}`,
    ),
  );
}

/** The schematic fallback: the same route over a plain background. */
function renderSchematic(geo: TripGeometry): Buffer {
  const { midLon, midLat, minLon, maxLon, minLat, maxLat } = routeBounds(geo);
  const cos = Math.cos((midLat * Math.PI) / 180) || 1e-9;
  const spanX = Math.max(maxLon - minLon, 1e-9) * cos;
  const spanY = Math.max(maxLat - minLat, 1e-9);
  const scale = Math.min((WIDTH - 2 * PAD) / spanX, (HEIGHT - 2 * PAD) / spanY);
  const px = (lon: number, lat: number) => ({
    x: WIDTH / 2 + (lon - midLon) * cos * scale,
    y: HEIGHT / 2 - (lat - midLat) * scale,
  });
  return renderSvg(
    wrapSvg(routeSvg(geo, px), { background: "#f8fafc", border: true }),
  );
}

/** Numbered stop bubbles matching the editor's .map-stop-bubble style. */
function markersSvg(
  stops: { lat: number; lng: number }[],
  px: (lon: number, lat: number) => { x: number; y: number },
): string {
  return stops
    .map((s, i) => {
      const p = px(s.lng, s.lat);
      const cx = p.x.toFixed(1);
      const cy = p.y.toFixed(1);
      const label = i === 0 ? "S" : String(i);
      // Baseline offset (~half the 10px cap height) centers the label.
      return `<g>
        <circle cx="${cx}" cy="${cy}" r="10" fill="#ffffff" stroke="#2563eb" stroke-width="2"/>
        <text x="${cx}" y="${(p.y + 3.5).toFixed(1)}" font-family="${JETBRAINS_MONO}" font-size="10" font-weight="700" text-anchor="middle" fill="#2563eb">${label}</text>
      </g>`;
    })
    .join("");
}

/** The SVG shell: light background, optional border, and the required
 * basemap attribution (Carto's tile terms). */
function wrapSvg(
  inner: string,
  opts: { background?: string; border?: boolean } = {},
): string {
  const background = opts.background ?? "#f8fafc";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${background}"/>
  ${opts.border ? `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" fill="none" stroke="#e2e8f0"/>` : ""}
  ${inner}
  <text x="8" y="${HEIGHT - 8}" font-family="${JETBRAINS_MONO}" font-size="8" fill="#475569">© OpenStreetMap contributors © CARTO</text>
</svg>`;
}

function renderSvg(svg: string): Buffer {
  const options = resvgFontOptions({
    fontBuffers: [jetbrainsMonoBytes],
    defaultFontFamily: JETBRAINS_MONO,
  });
  return Buffer.from(new Resvg(svg, options).render().asPng());
}
