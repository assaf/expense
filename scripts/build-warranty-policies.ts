/**
 * Builds `app/data/warranty-policies.ts` from `app/data/warranty-policies.yaml`:
 * the curated merchant coverage table a warranty record starts from.
 *
 * The YAML is where a human edits the table (prose, sources, a checked month);
 * the emitted module is what the app imports, which keeps the `yaml` parser
 * out of the client bundle. The emitted file is committed, so a policy change
 * shows up in review as the YAML edit plus its mechanical echo. Validation and
 * parsing live in `app/data/parse-warranty-policies.ts`, where they are tested.
 *
 *   pnpm build:policies    # `pnpm check`, `pnpm dev` and `pnpm build` run it too
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MerchantPolicy } from "~/data/content-types";
import { parsePolicies } from "~/data/parse-warranty-policies";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE = resolve(ROOT, "app/data/warranty-policies.yaml");
const TARGET = resolve(ROOT, "app/data/warranty-policies.ts");

/** The emitted module: mechanical, one field per line, strings JSON-quoted so
 * a colon, an apostrophe or a URL never needs escaping by hand. */
function emit(policies: readonly MerchantPolicy[]): string {
  const lines = [
    "/**",
    " * Generated from `app/data/warranty-policies.yaml` by",
    " * `scripts/build-warranty-policies.ts` — edit the YAML, not this file, then",
    " * run `pnpm build:policies`. Committed so a reviewer sees the table the app",
    " * ships; excluded from formatting because it is mechanical.",
    " */",
    'import type { MerchantPolicy } from "~/data/content-types";',
    "",
    "/** The curated merchant coverage table, in the order the YAML lists it. */",
    "export const MERCHANT_POLICIES: readonly MerchantPolicy[] = [",
  ];
  for (const policy of policies) {
    lines.push("  {", `    merchant: ${JSON.stringify(policy.merchant)},`);
    if (policy.aliases) {
      lines.push("    aliases: [");
      for (const alias of policy.aliases) {
        lines.push(`      ${JSON.stringify(alias)},`);
      }
      lines.push("    ],");
    }
    lines.push(`    terms: ${JSON.stringify(policy.terms)},`);
    lines.push("    sources: [");
    for (const source of policy.sources) {
      lines.push(`      ${JSON.stringify(source)},`);
    }
    lines.push("    ],", `    asOf: ${JSON.stringify(policy.asOf)},`, "  },");
  }
  lines.push("];", "");
  return lines.join("\n");
}

let policies: MerchantPolicy[];
try {
  policies = parsePolicies(readFileSync(SOURCE, "utf8"));
} catch (error) {
  console.error(
    `[policies] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

const emitted = emit(policies);
const current = existsSync(TARGET) ? readFileSync(TARGET, "utf8") : "";
if (current === emitted) {
  console.info(
    `[policies] ${policies.length} entries, ${TARGET} already current`,
  );
} else {
  writeFileSync(TARGET, emitted);
  console.info(`[policies] wrote ${policies.length} entries to ${TARGET}`);
}
