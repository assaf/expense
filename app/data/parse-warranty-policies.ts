import { parse } from "yaml";
import type { MerchantPolicy } from "~/data/content-types";

/**
 * `app/data/warranty-policies.yaml` as the app's table: parse it and validate
 * every entry, so an editing mistake fails the build naming the entry it is
 * in, rather than reaching a warranty record.
 *
 * Build-time only. This module imports the yaml parser, so no app module may
 * import it, or the parser lands in the client bundle: the app imports the
 * emitted `app/data/warranty-policies.ts` instead (see
 * `scripts/build-warranty-policies.ts`).
 */

/** The fields an entry may carry; anything else is a typo. */
const FIELDS = new Set(["merchant", "aliases", "terms", "sources", "asOf"]);

/** Every rejection is an Error whose message names the entry and the field,
 * because the person reading it is mid-edit in the YAML. */
function fail(message: string): never {
  throw new Error(message);
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
export function parsePolicies(text_: string): MerchantPolicy[] {
  const document: unknown = parse(text_);
  if (
    typeof document !== "object" ||
    document === null ||
    Array.isArray(document)
  ) {
    fail("the file must be a mapping with a `policies` list");
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
