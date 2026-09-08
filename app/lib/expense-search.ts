import { parseAmount } from "~/lib/money";
import { formatAmount } from "~/lib/format";
import { MILEAGE_TYPE_LABELS } from "~/lib/mileage-rates";
import type { MileageType } from "~/lib/types";

/** The slice of a list row the search box reads. The home page's
 * ExpenseListItem satisfies it structurally. */
export interface SearchableExpense {
  type: "receipt" | "mileage";
  merchant: string;
  mileageType: MileageType;
  locations: { address: string }[];
  description: string;
  category: string;
  amount: string;
  report: string;
}

/** Text fields the search box filters on: the merchant (or "Business
 * mileage" style label with the route addresses for mileage rows),
 * description, category, and the amount formatted as "$x.xx" so a query
 * like "$7" matches "$7.50". */
function searchableText(e: SearchableExpense): string {
  const parts = [
    e.type === "receipt"
      ? e.merchant
      : `${MILEAGE_TYPE_LABELS[e.mileageType]} mileage`,
    e.type === "mileage" ? e.locations.map((l) => l.address).join(" ") : "",
    e.description,
    e.category,
    e.amount ? formatAmount(e.amount) : "",
  ];
  return parts.join(" ").toLowerCase();
}

/** The recognized search operators. */
const FILTER_KEYS = [
  "report",
  "category",
  "merchant",
  "description",
  "amount",
] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

/** Operator aliases, normalized to their canonical key at parse time.
 * Chosen so they read naturally in a query ("from:peet's in:2026 trip")
 * and can't collide with likely free-text tokens: an alias only acts as
 * an operator when it carries a colon ("in:june" filters reports, the
 * bare word "in" is still free text). */
export const OPERATOR_ALIASES: Record<string, FilterKey> = {
  from: "merchant",
  vendor: "merchant",
  store: "merchant",
  seller: "merchant",
  cat: "category",
  in: "report",
  for: "report",
  desc: "description",
  note: "description",
  notes: "description",
};

const OPERATOR_TOKEN = new RegExp(
  `^(${FILTER_KEYS.join("|")}|${Object.keys(OPERATOR_ALIASES).join("|")}):(.*)$`,
);

/** A query split into operator filters and free-text words (see
 * parseQuery). */
interface ParsedQuery {
  filters: Record<FilterKey, string[]>;
  words: string[];
}

/** Parse a search query into operator filters plus free-text words.
 * `report:` / `category:` / `merchant:` set exact filters (case-insensitive);
 * `description:` substring-matches the free text description. Each operator
 * has aliases (from:/vendor:/store:/seller: → merchant, cat: → category,
 * in:/for: → report, desc:/note:/notes: → description) that normalize to
 * the canonical key. An operator's
 * value runs to the next recognized prefix, so spaced values work:
 * `report:2026 business`, `description:printer paper`. Free text (before
 * any operator, or under an unknown prefix) ANDs words against the row's
 * searchable text, as always. Same-key values OR together; keys AND
 * together. An operator with no value is a no-op, and colon-bearing free
 * text ("10:30") is untouched.
 */
export function parseQuery(query: string): ParsedQuery {
  const filters: Record<FilterKey, string[]> = {
    report: [],
    category: [],
    merchant: [],
    description: [],
    amount: [],
  };
  const words: string[] = [];
  let key: FilterKey | null = null;
  let parts: string[] = [];
  const flush = () => {
    if (key && parts.length > 0) filters[key].push(parts.join(" "));
    key = null;
    parts = [];
  };
  for (const token of query.trim().toLowerCase().split(/\s+/)) {
    if (!token) continue;
    const op = OPERATOR_TOKEN.exec(token);
    if (op) {
      flush();
      // Aliases normalize to the canonical key ("from:peet's" is stored
      // as filters.merchant), so matchesSearch and every consumer stay
      // alias-free.
      key = (OPERATOR_ALIASES[op[1]!] ?? op[1]!) as FilterKey;
      if (op[2]) parts.push(op[2]);
    } else if (key) {
      parts.push(token);
    } else {
      words.push(token);
    }
  }
  flush();
  return { filters, words };
}

/** Does the row match an already-parsed query (see parseQuery)? */
export function matchesSearch(
  e: SearchableExpense,
  { filters, words }: ParsedQuery,
): boolean {
  if (
    (filters.report.length > 0 &&
      !filters.report.some((v) => v === e.report.toLowerCase())) ||
    (filters.category.length > 0 &&
      !filters.category.some(
        (v) =>
          v === e.category.toLowerCase() ||
          categorySynonyms(e.category).includes(v),
      )) ||
    (filters.merchant.length > 0 &&
      !filters.merchant.some((v) => v === e.merchant.toLowerCase())) ||
    (filters.description.length > 0 &&
      !filters.description.some((v) =>
        e.description.toLowerCase().includes(v),
      )) ||
    (filters.amount.length > 0 &&
      !filters.amount.some((v) => amountInRange(e.amount, v)))
  ) {
    return false;
  }
  if (words.length === 0) return true;
  const haystack = searchableText(e);
  const category = e.category.toLowerCase();
  // A word that is a built-in synonym of the row's category matches even
  // when no name contains it ("food" → Meals and entertainment).
  return words.every(
    (word) =>
      haystack.includes(word) || categorySynonyms(category).includes(word),
  );
}

// --- Amount ranges ---------------------------------------------------------

/** Parse one bound of an `amount:` value: dollars, at most 2 decimals. */
function parseAmountBound(v: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Does the row's amount fall inside an `amount:` operator value?
 * `100-110` (inclusive range), `100+` / `100-` (at least), `-110` (at
 * most), `42.50` (exact); `$` signs are ignored. Unparseable bounds
 * match nothing rather than everything. */
function amountInRange(rawAmount: string, spec: string): boolean {
  const amount = parseAmount(rawAmount);
  if (amount === null) return false;
  const value = spec.replace(/\$/g, "").trim();
  const range = /^(\d+(?:\.\d{1,2})?)?-(\d+(?:\.\d{1,2})?)?$/.exec(value);
  let min: number | null;
  let max: number | null;
  if (range) {
    min = range[1] ? Number(range[1]) : null;
    max = range[2] ? Number(range[2]) : null;
  } else if (value.endsWith("+")) {
    min = parseAmountBound(value.slice(0, -1));
    max = null;
  } else {
    min = parseAmountBound(value);
    max = min;
  }
  if (min === null && max === null) return false;
  const n = amount.toNumber();
  return (min === null || n >= min) && (max === null || n <= max);
}

// --- Category synonyms -----------------------------------------------------

/** Built-in synonyms for the default Schedule C categories: common words
 * that appear in no category *name* but clearly mean one ("food" → Meals
 * and entertainment). Free-text matching is substring-based, so this list
 * only needs words with no textual overlap. Custom categories get no
 * built-in synonyms. */
const CATEGORY_SYNONYMS: Record<string, string[]> = {
  "Meals and entertainment": [
    "food",
    "dining",
    "restaurant",
    "lunch",
    "dinner",
    "breakfast",
    "coffee",
    "drinks",
    "cafe",
    "catering",
  ],
  "Car and truck expenses": [
    "car",
    "truck",
    "vehicle",
    "auto",
    "gas",
    "fuel",
    "petrol",
    "parking",
    "tolls",
    "driving",
  ],
  Travel: [
    "flight",
    "airline",
    "airfare",
    "hotel",
    "motel",
    "lodging",
    "airbnb",
    "train",
    "taxi",
    "rideshare",
    "uber",
    "lyft",
    "conference",
  ],
  "Office expenses": [
    "office",
    "stationery",
    "paper",
    "printer",
    "software",
    "saas",
    "cloud",
    "apps",
  ],
  Supplies: ["materials"],
  Utilities: [
    "phone",
    "mobile",
    "cell",
    "internet",
    "broadband",
    "wifi",
    "electricity",
    "water",
  ],
  "Insurance (other than health)": ["insurance", "premium"],
  "Legal and professional services": [
    "legal",
    "lawyer",
    "attorney",
    "accounting",
    "accountant",
    "bookkeeping",
    "consulting",
  ],
  Advertising: ["ads", "marketing", "promotion", "sponsorship"],
  "Commissions and fees": [
    "fees",
    "commission",
    "bank fee",
    "transaction",
    "processing",
  ],
  "Rent or lease: other business property": ["rent", "lease"],
  "Rent or lease: vehicles, machinery, and equipment": ["equipment lease"],
  "Repairs and maintenance": ["repair", "maintenance", "fix"],
  "Taxes and licenses": ["tax", "license", "permit", "irs"],
  Wages: ["wage", "salary", "payroll"],
  "Contract labor": ["contractor", "freelancer", "1099"],
  "Other expenses": ["misc"],
};

/** Reverse index: synonym word → categories it means. Built once. */
const SYNONYM_INDEX = new Map<string, string[]>();
for (const [category, synonyms] of Object.entries(CATEGORY_SYNONYMS)) {
  for (const word of synonyms) {
    const categories = SYNONYM_INDEX.get(word) ?? [];
    categories.push(category);
    SYNONYM_INDEX.set(word, categories);
  }
}

/** Canonical category names, lowercase → synonyms (lookups are
 * case-insensitive; keys keep the display spelling for completions). */
const CATEGORY_SYNONYMS_BY_LOWER = new Map<string, string[]>();
for (const [category, synonyms] of Object.entries(CATEGORY_SYNONYMS)) {
  CATEGORY_SYNONYMS_BY_LOWER.set(category.toLowerCase(), synonyms);
}

/** The built-in synonyms of `category` (case-insensitive canonical name;
 * unknown categories have none). */
export function categorySynonyms(category: string): string[] {
  return CATEGORY_SYNONYMS_BY_LOWER.get(category.trim().toLowerCase()) ?? [];
}

/** Categories that the synonym word `word` means (case-insensitive). */
export function categoriesForSynonym(word: string): string[] {
  return SYNONYM_INDEX.get(word.trim().toLowerCase()) ?? [];
}
