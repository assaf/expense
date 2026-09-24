/**
 * Registers the Vite import suffixes the app uses with Node's module hooks,
 * so a tsx dev script can import a renderer that imports a bundled font:
 *
 *   NODE_OPTIONS=--import=./scripts/lib/vite-assets.mjs tsx scripts/…
 *
 * `register()` is deprecated in favour of the synchronous `registerHooks()`,
 * which cannot be combined with the loader tsx installs, so the deprecated
 * call is the one that works here. See vite-asset-hooks.mjs for the rules.
 */
import { register } from "node:module";

register("./vite-asset-hooks.mjs", import.meta.url);
