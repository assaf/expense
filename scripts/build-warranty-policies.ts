/**
 * Builds `app/data/warranty-policies.ts` from `app/data/warranty-policies.yaml`:
 * the curated merchant coverage table a warranty record starts from.
 *
 * The YAML is where a human edits the table (prose, sources, a checked month);
 * the emitted module is what the app imports, which keeps the `yaml` parser
 * out of the client bundle. The emitted file is committed, so a policy change
 * shows up in review as the YAML edit plus its mechanical echo.
 *
 *   pnpm build:policies    # `pnpm check`, `pnpm dev` and `pnpm build` run it too
 *
 * Validation runs before anything is written: an entry with no source or no
 * checked month, an unknown key (a typo like `source:`), or a merchant claimed
 * twice fails here, naming the entry, rather than reaching a record.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import type { MerchantPolicy } from "~/data/content-types";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE = resolve(ROOT, "app/data/warranty-policies.yaml");
const TARGET = resolve(ROOT, "app/data/warranty-policies.ts");

/** The fields an entry may carry; anything else is a typo. */
const FIELDS = new Set(["merchant", "aliases", "terms", "sources", "asOf"]);

function fail(message: string): never {
  console.error(`[policies] ${message}`);
  process.exit(1);
}

/** A required non-empty string field. */
function text(value: unknown, where: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${where}: \`${field}\` must be a non-empty string`);
  }
  return value.trim();
}

/** A required non-empty list of non-empty strings. */
function texts(value: unknown, where: string, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${where}: \`${field}\` must be a non-empty list`);
  }
  return value.map((item, index) => text(item, where, `${field}[${index}]`));
}

/** The table, validated, in the order the YAML lists it. */
function readPolicies(): MerchantPolicy[] {
  const document: unknown = parse(readFileSync(SOURCE, "utf8"));
  if (
    typeof document !== "object" ||
    document === null ||
    Array.isArray(document)
  ) {
    fail(`${SOURCE} must be a mapping with a \`policies\` list`);
  }
  const list = (document as Record<string, unknown>).policies;
  if (!Array.isArray(list) || list.length === 0) {
    fail("`policies` must be a non-empty list");
  }
  /** Match names already claimed, so two entries cannot answer to one name. */
  const claimed = new Map<string, string>();
  return list.map((entry: unknown, index) => {
    const where = `policies[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      fail(`${where} must be a mapping`);
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!FIELDS.has(key)) fail(`${where}: unknown field \`${key}\``);
    }
    const merchant = text(record.merchant, where, "merchant");
    const named = `policies[${index}] (${merchant})`;
    const terms = text(record.terms, named, "terms");
    const sources = texts(record.sources, named, "sources");
    const asOf = text(record.asOf, named, "asOf");
    if (!/^\d{4}-\d{2}$/.test(asOf)) {
      fail(`${named}: \`asOf\` must be "YYYY-MM", got ${JSON.stringify(asOf)}`);
    }
    const aliases =
      record.aliases === undefined
        ? undefined
        : texts(record.aliases, named, "aliases");
    for (const name of [merchant, ...(aliases ?? [])]) {
      const key = name.toLowerCase();
      const other = claimed.get(key);
      if (other !== undefined) {
        fail(`\`${name}\` is claimed by both ${other} and ${merchant}`);
      }
      claimed.set(key, merchant);
    }
    return aliases
      ? { merchant, aliases, terms, sources, asOf }
      : { merchant, terms, sources, asOf };
  });
}

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

const policies = readPolicies();
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
