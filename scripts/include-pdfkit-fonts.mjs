/**
 * Post-build step: add pdfkit's standard fonts to the Vercel function file
 * map. React Router's Vercel integration writes .vercel/output/functions/
 * *.func/.vc-config.json with a filePathMap of every traced file, and that
 * map is exactly what gets packaged into the serverless function. pdfkit
 * lazy-loads its fonts through #standard-fonts/* alias requires that the
 * tracer can't follow, so they never make the map and PDF renders die with
 * MODULE_NOT_FOUND in production (the full node_modules masks this
 * locally). This resolves the installed pdfkit package and adds its
 * js/standard-fonts files (the .cjs variants pdfkit's runtime require
 * loads). No-op when the Vercel output doesn't exist (plain local builds).
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

const FUNCTIONS_DIR = ".vercel/output/functions";

function findFontFiles() {
  if (!existsSync("node_modules/pdfkit")) return [];
  const fontsDir = join(
    realpathSync("node_modules/pdfkit"),
    "js/standard-fonts",
  );
  if (!existsSync(fontsDir)) return [];
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (name.endsWith(".cjs")) files.push(full);
      else if (existsSync(full) && !name.includes(".")) walk(full);
    }
  };
  walk(fontsDir);
  return files;
}

const fontFiles = findFontFiles();
if (fontFiles.length === 0) {
  console.error(
    "[include-pdfkit-fonts] no standard-font .cjs files found in installed pdfkit",
  );
  process.exit(1);
}

if (!existsSync(FUNCTIONS_DIR)) {
  // Plain local build (no Vercel output yet); nothing to patch.
  process.exit(0);
}

let patched = 0;
for (const funcName of readdirSync(FUNCTIONS_DIR)) {
  const configPath = join(FUNCTIONS_DIR, funcName, ".vc-config.json");
  if (!existsSync(configPath)) continue;
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (!config.filePathMap || typeof config.filePathMap !== "object") {
    console.error(`[include-pdfkit-fonts] no filePathMap in ${configPath}`);
    process.exit(1);
  }
  const root = process.cwd();
  for (const file of fontFiles) {
    const key = relative(root, file);
    config.filePathMap[key] ??= key;
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  patched += 1;
}

console.error(
  `[include-pdfkit-fonts] added ${fontFiles.length} font files to ${patched} function(s)`,
);
