import { normalizeMerchant } from "~/lib/duplicates";
import type { MerchantPolicy } from "~/data/content-types";
import { MERCHANT_POLICIES } from "~/data/warranty-policies";

/**
 * The curated merchant coverage table's matching and rendering: which entry a
 * record's merchant name picks, and the terms text a record starts with.
 *
 * The table itself — each retailer's summary, the pages it was read from, and
 * the month it was last checked — lives in `app/data/warranty-policies.yaml`.
 * That is the file to edit; `pnpm build:policies` emits
 * `app/data/warranty-policies.ts` from it, which is what this module imports,
 * so a YAML parser never reaches the client bundle. (`app/lib/warranty-ai.server.ts`
 * is a different thing: it reads a document the user supplied.)
 */

export { MERCHANT_POLICIES };
export type { MerchantPolicy };

/** Lowercased, apostrophe- and punctuation-free merchant text: "Sam's Club
 * #412" and "Sams Club 412" both reduce to "sams club 412", so the two
 * spellings match the same entry. */
function matchKey(name: string): string {
  return normalizeMerchant(name)
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** One compiled whole-word matcher per name, built once at import: the key
 * must appear as a run of whole words, so "Apple" matches "Apple Inc." and
 * "Apple #123" but not "Applebee's" or "applesauce". `matchKey` reduces a
 * name to [a-z0-9 ]+, so the key never needs regex escaping. */
const MATCHERS: ReadonlyArray<{
  policy: MerchantPolicy;
  key: string;
  pattern: RegExp;
}> = MERCHANT_POLICIES.flatMap((policy) =>
  [policy.merchant, ...(policy.aliases ?? [])].map((name) => {
    const key = matchKey(name);
    return { policy, key, pattern: new RegExp(`(^| )${key}( |$)`) };
  }),
);

/** The curated policy for a merchant name, when one matches. Spelling- and
 * punctuation-tolerant ("COSTCO #1234", "Sam's Club", "Sams Club"). When
 * more than one entry matches, the longest key wins, so a specific entry
 * (say "Amazon Pharmacy") overrides a general one ("Amazon"). */
export function merchantPolicy(merchant: string): MerchantPolicy | undefined {
  const key = matchKey(merchant);
  if (!key) return undefined;
  let best: { policy: MerchantPolicy; length: number } | undefined;
  for (const matcher of MATCHERS) {
    if (!matcher.pattern.test(key)) continue;
    if (!best || matcher.key.length > best.length) {
      best = { policy: matcher.policy, length: matcher.key.length };
    }
  }
  return best?.policy;
}

/** The text a policy puts in a record's terms: the summary, then where it
 * came from and when it was checked. Plain text (the field is a textarea). */
export function policyTermsText(policy: MerchantPolicy): string {
  return `${policy.terms}\n\nFrom ${policy.sources.join(" and ")}, checked ${policy.asOf}.`;
}

/** The terms to file for a merchant when nothing better is known: the curated
 * policy's text, or "" when no policy matches. Used where a warranty is
 * created without the user typing terms (a dropped document, an expense that
 * prefills the merchant). */
export function termsForMerchant(merchant: string): string {
  const policy = merchantPolicy(merchant);
  return policy ? policyTermsText(policy) : "";
}
