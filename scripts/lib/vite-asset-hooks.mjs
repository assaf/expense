/**
 * Node module hooks that teach tsx the Vite import suffixes the app uses:
 * `?inline` (a bundled asset as a `data:` URI) and `?raw` (a file's text).
 * Registered by ./vite-assets.mjs; never imported directly.
 *
 * Without this, importing a renderer under tsx dies with
 * `Unknown file extension ".woff2"`, which is why the renderer-taking dev
 * scripts used to stub their images with a 1x1 placeholder. With it they
 * render for real. (`pnpm preview:confirmation` wires this up.)
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
/** A bundled asset (Vite `?inline`, or a bare asset path once tsx has
 * stripped the query) and a raw data file (Vite `?raw`). */
const INLINE_EXT = /\.(woff2?|ttf|otf|png|jpe?g|gif|webp|svg)$/i;
const RAW_EXT = /\.(ya?ml|md|csv)$/i;

/** Which Vite suffix a specifier needs, query or extension. */
function viteKind(specifier) {
  const query = /\?(inline|raw)$/.exec(specifier);
  if (query) {
    return { kind: query[1], target: specifier.slice(0, -query[0].length) };
  }
  if (INLINE_EXT.test(specifier)) return { kind: "inline", target: specifier };
  if (RAW_EXT.test(specifier)) return { kind: "raw", target: specifier };
  return undefined;
}

/** Where a Vite specifier's file lives: the `~/` alias, a path, or a
 * node_modules package. Mirrors the Vite aliases in vite.config.ts. */
function resolveAsset(target) {
  if (target.startsWith("~/")) return join(repoRoot, "app", target.slice(2));
  if (target.startsWith(".") || target.startsWith("/")) {
    return join(process.cwd(), target);
  }
  return require.resolve(target);
}

export async function resolve(specifier, context, next) {
  const match = viteKind(specifier);
  if (!match) return next(specifier, context);
  return {
    url: `vite-asset:${match.kind}:${encodeURIComponent(match.target)}`,
    format: "module",
    shortCircuit: true,
  };
}

export async function load(url, context, next) {
  if (!url.startsWith("vite-asset:")) return next(url, context);
  const rest = url.slice("vite-asset:".length);
  const kind = rest.slice(0, rest.indexOf(":"));
  const target = decodeURIComponent(rest.slice(rest.indexOf(":") + 1));
  const path = resolveAsset(target);
  // `?inline` is a base64 `data:` URI (app/lib/inline-asset.ts decodes it);
  // `?raw` is the file's text.
  const value =
    kind === "inline"
      ? `data:application/octet-stream;base64,${readFileSync(path).toString("base64")}`
      : readFileSync(path, "utf8");
  return {
    format: "module",
    shortCircuit: true,
    source: `export default ${JSON.stringify(value)};`,
  };
}
