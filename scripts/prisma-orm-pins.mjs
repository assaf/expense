#!/usr/bin/env node
// The Prisma ORM packages (`@prisma/orm-postgres`, `@prisma/orm-family-sql`)
// must be pinned to the exact `@prisma/orm-toolchain` rc the INSTALLED prisma
// CLI bundles, not to their own `latest`.
//
// Two reasons the registry can't be trusted to line them up:
//   - the orm packages publish ahead of the CLI (2026-11-01: orm rc.22 was
//     `latest` while the newest CLI, 8.0.0-rc.29, bundled rc.21), so
//     `pnpm update --latest` happily installs a pair no CLI accepts;
//   - the CLI validates the packs the project orm package contributes with
//     ITS OWN bundled toolchain copy, so a mismatch is a shape-skew crash at
//     `prisma contract emit` (CONTRACT.PACK_CONTRIBUTION_INVALID) or a
//     contract.d.ts emitted by codecs the CLI does not know.
//
// --check (default): exit 1 when package.json disagrees with the CLI.
// --fix: rewrite the two pins in package.json to the CLI's toolchain.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PINNED = ["@prisma/orm-family-sql", "@prisma/orm-postgres"];

const fix = process.argv.includes("--fix");
const pkgPath = join(process.cwd(), "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const require = createRequire(pathToFileURL(pkgPath).href);
const cli = JSON.parse(
  readFileSync(require.resolve("prisma/package.json"), "utf8"),
);
const expected = cli.dependencies?.["@prisma/orm-toolchain"];

if (typeof expected !== "string") {
  // A CLI that stops naming the toolchain cannot be checked against; say so
  // instead of failing the gate with "must be pinned to undefined".
  console.warn(
    `warning: prisma ${cli.version} declares no @prisma/orm-toolchain; the orm pins could not be verified`,
  );
  process.exit(0);
}

const mismatched = PINNED.filter((name) => pkg.dependencies[name] !== expected);
if (mismatched.length === 0) {
  console.info(`pass: prisma orm packages pinned to ${expected}`);
  process.exit(0);
}

if (fix) {
  for (const name of mismatched) {
    console.info(`${name}: ${pkg.dependencies[name]} -> ${expected}`);
    pkg.dependencies[name] = expected;
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.info("package.json updated: run pnpm install to lock it");
  process.exit(0);
}

console.error(
  `Prisma ORM packages must be pinned to ${expected} (what prisma ${cli.version} bundles), but:`,
);
for (const name of mismatched)
  console.error(`  ${name}: ${pkg.dependencies[name]}`);
console.error(
  "Pin them exactly (no range) or move the CLI to a release bundling the same orm rc.",
);
console.error("Fix: pnpm prisma:pins:fix && pnpm install");
process.exit(1);
