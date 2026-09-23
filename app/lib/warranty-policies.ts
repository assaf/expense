import { normalizeMerchant } from "~/lib/duplicates";

/**
 * Merchant coverage terms that ship with the app: a short factual summary of
 * a retailer's own return/warranty policy, its sources, and the month it was
 * last checked. A warranty record for a matched merchant starts with these
 * terms filled in, and stays editable.
 *
 * Why a curated table rather than a fetch: the retailers that publish this
 * kind of program keep it behind bot-gated help centers. A server-side fetch
 * of costco.com's policy paths answers 404, and its help-center hosts answer
 * 401 Unauthorized, so an automatic fetch would silently return nothing.
 * (The document reader in app/lib/warranty-ai.server.ts is a different
 * thing: it reads a document the user supplied.)
 *
 * Entries are deliberately conservative: the summary says what the retailer
 * publicly commits to, and the source line names where it was read from, so
 * a record never reads as though the app invented coverage. Policies change,
 * which is what `asOf` is for: re-check the page and bump it.
 */

export interface MerchantPolicy {
  /** Merchant name as the retailer writes it; matched as whole words. */
  merchant: string;
  /** Other names the retailer trades under ("America's Tire" for Discount
   * Tire), matched exactly like `merchant`. */
  aliases?: readonly string[];
  /** Coverage summary in the record's own voice, a sentence or two. */
  terms: string;
  /** The official pages the summary was taken from. */
  sources: readonly string[];
  /** The month the summary was last checked, "YYYY-MM". */
  asOf: string;
}

const COSTCO: MerchantPolicy = {
  merchant: "Costco",
  terms:
    "Costco's own coverage: returns within 90 days on electronics and major appliances (TVs, projectors, computers, tablets, phones, cameras, and large appliances), and Costco Technical & Warranty Services extends the manufacturer's warranty to a second year on TVs, projectors, computers, and major appliances (tablets excluded), covering repair, replacement, or a refund up to the purchase price.",
  sources: [
    "https://customerservice.costco.com/",
    "https://techsupport.costco.com/",
  ],
  asOf: "2026-09",
};

const SAMS_CLUB: MerchantPolicy = {
  merchant: "Sam's Club",
  terms:
    "Sam's Club's own coverage: a 100% satisfaction guarantee, with most items returnable within 90 days and the manufacturer's warranty behind them. An Allstate protection plan can be added at the Membership Desk or online within 30 days of purchase.",
  sources: [
    "https://help.samsclub.com/app/answers/detail/a_id/4072",
    "https://help.samsclub.com/app/answers/detail/a_id/2577",
  ],
  asOf: "2026-09",
};

const BEST_BUY: MerchantPolicy = {
  merchant: "Best Buy",
  terms:
    "Best Buy's own coverage: 15-day returns on most products, 60 days for My Best Buy Plus and Total members (Marketplace items excluded). Geek Squad Protection can be added within 60 days of purchase, and covers service and accidental damage with a service fee per claim.",
  sources: [
    "https://www.bestbuy.com/site/help-topics/return-exchange-policy/pcmcat260800050014.c?id=pcmcat260800050014",
    "https://www.bestbuy.com/site/geek-squad-protection/geek-squad-protection-faqs/pcmcat748302045943.c?id=pcmcat748302045943",
  ],
  asOf: "2026-09",
};

const HOME_DEPOT: MerchantPolicy = {
  merchant: "Home Depot",
  terms:
    "Home Depot's own coverage: most items can be returned within 90 days, with furniture, major appliances, and consumer electronics often at 30 days. Damage or shortage on a delivered major appliance must be reported within 48 hours.",
  sources: [
    "https://www.homedepot.com/c/Return_Policy",
    "https://www.homedepot.com/hdus/en_US/DTCCOM/HomePage/Header/fragments/ENT_HFS_Body_Overlay_Frg_4A.htm",
  ],
  asOf: "2026-09",
};

const IKEA: MerchantPolicy = {
  merchant: "IKEA",
  terms:
    "IKEA's own coverage: 365-day returns on unopened items and 180 days on opened ones with proof of purchase, plus long guarantees by product line (10 years across much of the furniture and bathroom range, up to 25 years on parts of the kitchen system), repaired or replaced at IKEA's option with proof of purchase.",
  sources: [
    "https://www.ikea.com/us/en/customer-service/returns-claims/return-policy/",
    "https://www.ikea.com/us/en/customer-service/returns-claims/guarantee/",
  ],
  asOf: "2026-09",
};

const APPLE: MerchantPolicy = {
  merchant: "Apple",
  terms:
    "Apple's own coverage: a one-year limited warranty on hardware, and 14-day returns in original condition. AppleCare+ (bought with the device or within 60 days) extends the hardware coverage and adds accidental-damage protection.",
  sources: [
    "https://www.apple.com/shop/help/returns_refund",
    "https://www.apple.com/applecare/",
  ],
  asOf: "2026-09",
};

const AMAZON: MerchantPolicy = {
  merchant: "Amazon",
  terms:
    "Amazon's own coverage: most items can be returned within 30 days of delivery. Amazon Renewed items carry the Renewed Guarantee, a 90-day return window (365 days for Renewed Premium) with repair, replacement, or a refund for defects.",
  sources: [
    "https://www.amazon.com/gp/help/customer/display.html?nodeId=GKM69DUUYKQWKWX7",
    "https://www.amazon.com/gp/help/customer/display.html?nodeId=G4ZAA22U35N373NX",
  ],
  asOf: "2026-09",
};

const WALMART: MerchantPolicy = {
  merchant: "Walmart",
  terms:
    "Walmart's own coverage: a 90-day return window on most items bought in a store or on Walmart.com, with a receipt or order number. Items from Walmart Marketplace sellers follow the seller's own policy.",
  sources: ["https://corporate.walmart.com/policies"],
  asOf: "2026-09",
};

const TARGET: MerchantPolicy = {
  merchant: "Target",
  terms:
    "Target's own coverage: 90 days on most items, 30 days on electronics and entertainment and 14 days on Apple, Beats, and mobile phones, and a one-year window with receipt on Target's own brands. A Target Circle Card adds 30 days to most purchases.",
  sources: [
    "https://www.target.com/help/articles/returns-exchanges/returns",
    "https://www.target.com/help/article/000061982",
  ],
  asOf: "2026-09",
};

const LOWES: MerchantPolicy = {
  merchant: "Lowe's",
  terms:
    "Lowe's own coverage: 90 days on most new, unused merchandise with receipt, and 30 days on TVs and electronics, water heaters, most outdoor power equipment, and special-order items. Lowe's Protection Plans extend coverage after the manufacturer's warranty, up to five years on major appliances.",
  sources: [
    "https://www.lowes.com/l/help/returns-policy",
    "https://www.lowes.com/l/help/lowes-protection-plan",
  ],
  asOf: "2026-09",
};

const REI: MerchantPolicy = {
  merchant: "REI",
  terms:
    "REI's own coverage: a 100% satisfaction guarantee for Co-op members, with most items returnable within a year, some exclusions.",
  sources: ["https://www.rei.com/membership/member-collection"],
  asOf: "2026-09",
};

const COSTCO_TIRE: MerchantPolicy = {
  merchant: "Costco Tire",
  terms:
    "Costco Tire's own coverage: the Road Hazard Warranty covers unrepairable road-hazard damage on tires bought at Costco for 60 months or until 2/32 inch of tread remains, credited pro rata toward a new tire, and the installation package includes lifetime rotations, balancing, and flat repairs.",
  sources: [
    "https://tires.costco.com/CostcoRoadHazardWarranty",
    "https://tires.costco.com/CostcoAdvantage",
  ],
  asOf: "2026-09",
};

const DISCOUNT_TIRE: MerchantPolicy = {
  merchant: "Discount Tire",
  aliases: ["America's Tire"],
  terms:
    "Discount Tire's own coverage: Tire Protection Certificates, added at purchase or within 30 days, cover road hazards and manufacturer defects for three years with more than 3/32 inch of tread, repairing free when the damage is repairable and otherwise replacing the tire or refunding it in full, with no prorating.",
  sources: [
    "https://www.discounttire.com/certificates",
    "https://www.discounttire.com/services/flat-repair",
  ],
  asOf: "2026-09",
};

const MATTRESS_FIRM: MerchantPolicy = {
  merchant: "Mattress Firm",
  terms:
    "Mattress Firm's own coverage: a 120 Night Sleep Trial, one exchange or return per purchase between 30 and 120 days after delivery, with a $249.99 return processing charge. The mattress's manufacturer warranty is separate and lives on its warranty card.",
  sources: [
    "https://www.mattressfirm.com/mattress-returns-exchanges.html",
    "https://www.mattressfirm.com/mattress-warranty.html",
  ],
  asOf: "2026-09",
};

export const MERCHANT_POLICIES: readonly MerchantPolicy[] = [
  COSTCO,
  COSTCO_TIRE,
  SAMS_CLUB,
  BEST_BUY,
  HOME_DEPOT,
  LOWES,
  IKEA,
  TARGET,
  WALMART,
  APPLE,
  AMAZON,
  REI,
  DISCOUNT_TIRE,
  MATTRESS_FIRM,
];

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
