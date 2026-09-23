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
 *
 * Read from the retailer's own pages, September 2026, by one of three
 * routes. Through a headless Chromium: Costco's two documents, Costco Tire,
 * Best Buy, Target, Amazon, Apple, Discount Tire, Mattress Firm, and REI.
 * Through the opencli page reader: Walmart, and IKEA, whose per-line
 * warranty numbers stay hidden until the page's sections are expanded.
 * Through the opencli browser bridge, for the hosts that refuse the reader:
 * Sam's Club, Lowe's (returns and protection plans), and Home Depot.
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
    "Costco's own coverage: a Risk-Free 100% Satisfaction Guarantee, so merchandise can be returned for the purchase price, with exceptions, and the membership fee is refundable at any time. Electronics and major appliances must be returned within 90 days: TVs, projectors, computers, tablets, wearables, cameras, drones, camcorders, MP3 players, phones, and appliances over 10 cu. ft. Costco Technical & Warranty Services extends the manufacturer's warranty for up to 2 years on TVs, projectors, computers, and major appliances (touchscreen tablets excluded), fulfilled at Costco's choosing by repair, replacement, or a refund up to the purchase price, and excluding data and software loss, physical or liquid damage, and commercial use. Adding an Allstate Protection Plan can take qualifying products to 5 years of coverage.",
  sources: [
    "https://customerservice.costco.com/app/answers/detail/a_id/1191",
    "https://techsupport.costco.com/app/answers/detail/a_id/1001211",
  ],
  asOf: "2026-09",
};

const SAMS_CLUB: MerchantPolicy = {
  merchant: "Sam's Club",
  terms:
    "Sam's Club's own coverage: a 100% Satisfaction Guarantee, so a member can get a refund or a replacement at any time, with the day limits landing only on particular categories: 90 days on electronics and major appliances, 30 days on commercial heavy equipment and motorsports items, and 14 days on cell phones. Gift cards, tickets, collectibles, trading cards, custom-made items, and prescriptions cannot be returned at all, while beer, wine and spirits, tires and batteries, tobacco, eyeglasses, and hearing aids are handled at the club's discretion. An Allstate protection plan must be added within 30 days of purchase, at the Membership Desk or online, and the receipt is required to file a claim.",
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
    "Home Depot's own coverage: 90 days on most merchandise with proof of purchase, 30 days on furniture, tractors, framing and roofing compressors, consumer electronics (TVs and computers), paint sprayers, gas-powered trimmers, blowers, chainsaws, mowers and similar equipment, and holiday decor, 7 days on dehumidifiers, gas pressure washers, window and portable air conditioners, gas generators, pumps, portable heaters and portable evaporation, and 365 days on purchases made with a Home Depot consumer credit card, Pro Xtra credit card, or commercial account (except the 48-hour, 7-day and 30-day items). Major appliances must be returned within 48 hours of delivery, unopened ones included, with damage or defects reported in that window, and whole-house and stationary generators are not returnable. Most plants return within 90 days, while perennials, trees, roses and shrubs carry a one-year guarantee paid as store credit.",
  sources: [
    "https://www.homedepot.com/c/Return_Policy",
    "https://www.homedepot.com/hdus/en_US/DTCCOM/HomePage/Header/fragments/ENT_HFS_Body_Overlay_Frg_4A.htm",
  ],
  asOf: "2026-09",
};

const IKEA: MerchantPolicy = {
  merchant: "IKEA",
  terms:
    "IKEA's own coverage: 365-day returns on unopened items, and 180 days on opened ones with proof of purchase for a full refund. Limited warranties are by product line, run from the date of purchase, and need the original receipt to claim: 25 years on SEKTION kitchen cabinet frames, fronts, hinges, drawers, shelves and pre-cut countertops, and on some seating; 10 years on the ENHET kitchen system, bathroom furniture, bath and kitchen faucets, and seating frames and cushions; 15 years of functionality on kitchen knives and uncoated cookware; five years on major appliances, and two years on TILLREDA appliances.",
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
    "Amazon's own coverage: most items can be returned within 30 days of delivery. Amazon Renewed items carry the Renewed Guarantee, a 90-day return window (365 days for Renewed Premium), and select ones add a free 11-month limited warranty on defects in materials and workmanship, serviced by Asurion with no deductible.",
  sources: [
    "https://www.amazon.com/gp/help/customer/display.html?nodeId=GKM69DUUYKQWKWX7",
    "https://www.amazon.com/gp/help/customer/display.html?nodeId=G4ZAA22U35N373NX",
  ],
  asOf: "2026-09",
};

const WALMART: MerchantPolicy = {
  merchant: "Walmart",
  terms:
    "Walmart's own coverage: 90 days after purchase or receipt on most items, 30 days on consumer electronics and on items sold and shipped by a Marketplace seller, and 14 days on wireless phones. Purchases made October 1 through December 31 stay returnable until January 31, and items bought from a dealer or reseller rather than from Walmart directly are not eligible at all.",
  sources: [
    "https://www.walmart.com/help/article/walmart-standard-return-policy/adc0dfb692954e67a4de206fb8d9e03a",
  ],
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
    "Lowe's own coverage: 90 days on most new, unused merchandise with receipt, 30 days on liquid paint, TVs and electronics, water heaters, most outdoor power equipment, custom special-order blinds and window treatments, HVAC systems, and plants, 48 hours on major appliances, air conditioners and evaporative coolers, paint sprayers, generators, pressure washers, chainsaws, utility vehicles, and tile saws, and 365 days on trees, shrubs and perennials and on Commercial Account or business rewards card purchases. Lowe's Outlet locations take major appliances back only for mechanical or electrical damage, within 48 hours of taking possession, and marketplace orders (Instacart, DoorDash, Shipt, Uber) are refunded as in-store credit within 90 days. A Lowe's Protection Plan extends coverage past the limited manufacturer warranty: up to five years on major appliances and up to three years on everything else.",
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
