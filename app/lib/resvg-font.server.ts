import type { ResvgRenderOptions } from "@resvg/resvg-js";
import fontInline from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?inline";
import { decodeInlineAsset } from "~/lib/inline-asset";

/**
 * The bundled JetBrains Mono woff2 and the resvg options that rasterize
 * SVG to PNG with it. Shared by the text-receipt renderer
 * (receipt-render.server.ts) and the route-map renderer
 * (route-map.server.ts) so the font bytes, the family name, and the render
 * options live in exactly one place.
 *
 * The woff2 is embedded in the bundle (Vite ?inline), so rendering works on
 * serverless runtimes that have no system fonts.
 */

/** The JetBrains Mono family name, used in SVG markup and resvg. */
export const JETBRAINS_MONO = "JetBrains Mono";

/** The bundled JetBrains Mono woff2, decoded to bytes and embedded as an SVG
 * @font-face data URI and/or passed to resvg's fontdb. */
export const jetbrainsMonoBytes = decodeInlineAsset(fontInline);

/** resvg's font options shape: `fontBuffers` is supported at runtime
 * (resvg fontdb) but not yet in the published type defs, so the options
 * are extended via an intersection. */
export type ResvgFontOptions = ResvgRenderOptions["font"] & {
  fontBuffers?: Buffer[];
};

/** Build resvg render options that load system fonts plus any bundled
 * buffers. Callers pass the bundled font buffer + family (or `{}` to use
 * system fonts only). */
export function resvgFontOptions(
  overrides: ResvgFontOptions = {},
): ResvgRenderOptions & { font?: ResvgFontOptions } {
  return {
    fitTo: { mode: "original" },
    font: { loadSystemFonts: true, ...overrides },
  };
}
