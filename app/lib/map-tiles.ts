/**
 * The basemap both maps draw on: the mileage editor's Leaflet map
 * (`app/components/MapView.tsx`) and the server-side stitcher behind the
 * report PDF (`app/lib/route-map.server.ts`).
 *
 * Esri's keyless light-gray pair, not a keyed provider. Carto's Positron
 * served these maps until it started answering every tile with a 2 KB
 * watermark reading "API KEY REQUIRED" (same fix as epical-web, which
 * dropped Carto for the same reason). The base carries the streets, the
 * reference layer the labels; overlaid in that order they read like the
 * single minimal basemap the editor used to draw, so the route and markers
 * still stand out instead of competing with a busy street map.
 *
 * Leaflet substitutes `{z}/{y}/{x}` itself and the stitcher substitutes the
 * same tokens by hand, so one template serves both.
 */
export const TILE_BASE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}";

export const TILE_LABELS_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}";

/** Esri's required credit, as HTML for Leaflet's attribution control. */
export const TILE_ATTRIBUTION =
  'Tiles &copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** The same credit as plain text, for the SVG the report map is drawn in. */
export const TILE_ATTRIBUTION_TEXT =
  "© Esri, HERE, Garmin, © OpenStreetMap contributors";

/**
 * The Canvas light/dark gray services answer every zoom above 16 with the
 * same z=16 tile (measured: z17, z18 and z19 come back byte-identical), so
 * neither map asks for more. A deeper keyless layer exists on the same host
 * (World_Street_Map, World_Topo_Map serve z18), but both are busier than
 * this app's minimal look.
 */
export const TILE_MAX_ZOOM = 16;
