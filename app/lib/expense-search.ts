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

/** A parsed amount comparison: the bare tokens >100, >=100, <50, <=50.
 * Comparisons AND together (">100 <=110" is a range) and AND with
 * `amount:` specs. */
interface AmountComparison {
  op: ">" | ">=" | "<" | "<=";
  value: number;
}

/** A query split into operator filters and free-text words (see
 * parseQuery). */
interface ParsedQuery {
  filters: Record<FilterKey, string[]>;
  comparisons: AmountComparison[];
  words: string[];
}

/** Parse a search query into operator filters plus free-text words.
 * `report:` / `category:` / `merchant:` set exact filters (case-insensitive);
 * `description:` substring-matches the free text description. Each operator
 * has aliases (from:/vendor:/store:/seller: → merchant, cat: → category,
 * in:/for: → report, desc:/note:/notes: → description) that normalize to
 * the canonical key. An operator's
 * value runs to the next recognized prefix, so spaced values work:
 * `report:2026 business`, `description:printer paper`. Amount comparisons
 * are bare tokens (">100", "<=50.5" — `$` signs allowed) that AND
 * together and with `amount:` specs. Free text (before
 * any operator, or under an unknown prefix) ANDs words against the row's
 * searchable text, as always. Same-key values OR together; keys AND
 * together. An operator with no value is a no-op, and colon-bearing free
 * text ("10:30") is untouched. */
export function parseQuery(query: string): ParsedQuery {
  const filters: Record<FilterKey, string[]> = {
    report: [],
    category: [],
    merchant: [],
    description: [],
    amount: [],
  };
  const comparisons: AmountComparison[] = [];
  const words: string[] = [];
  let key: FilterKey | null = null;
  let parts: string[] = [];
  const flush = () => {
    if (key && parts.length > 0) filters[key].push(parts.join(" "));
    key = null;
    parts = [];
  };
  // "> 200" / "<=   50": collapse the space between a comparison symbol
  // and its number so the whitespace tokenizer sees one token. Only
  // symbol+space+number sequences are touched, never other text.
  const normalized = query
    .trim()
    .toLowerCase()
    .replace(/([<>]=?)\s+(\$?\d+(?:\.\d{1,2})?)/g, "$1$2");
  for (const token of normalized.split(/\s+/)) {
    if (!token) continue;
    const cmp = /^([<>]=?)\$?(\d+(?:\.\d{1,2})?)$/.exec(token);
    if (cmp) {
      // A bare amount comparison parses ANYWHERE — even after an
      // operator ("merchant:z.ai >100 <=110" is the natural way to write
      // a range against one merchant) — and ANDs with everything.
      comparisons.push({
        op: cmp[1] as AmountComparison["op"],
        value: Number(cmp[2]),
      });
      continue;
    }
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
  return { filters, comparisons, words };
}

/** Does the row match an already-parsed query (see parseQuery)? */
export function matchesSearch(
  e: SearchableExpense,
  { filters, comparisons, words }: ParsedQuery,
): boolean {
  const hasAmount = filters.amount.length > 0 || comparisons.length > 0;
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
    (hasAmount && !amountMatches(e.amount, filters.amount, comparisons))
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

/** OR across `amount:` specs, AND across bare comparisons, ANDed with
 * everything else. Rows without a usable amount never match. */
function amountMatches(
  rawAmount: string,
  specs: string[],
  comparisons: AmountComparison[],
): boolean {
  const amount = parseAmount(rawAmount);
  if (amount === null) return false;
  const specOk =
    specs.length === 0 || specs.some((v) => amountInRange(rawAmount, v));
  const cmpOk = comparisons.every((c) => amountCompare(rawAmount, c));
  return specOk && cmpOk;
}

// --- Amount ranges ---------------------------------------------------------

/** Parse one bound of an `amount:` value: dollars, at most 2 decimals. */
function parseAmountBound(v: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Parse an `amount:` operator value or bare comparison token into
 * inclusive-exclusive bounds: `100-110` (range), `100+` / `100-` (at
 * least), `-110` (at most), `42.50` (exact), `>100` / `>=100` (more
 * than / at least), `<50` / `<=50` (fewer than / at most). `$` signs
 * are ignored. Returns null when nothing numeric remains (the spec
 * matches nothing rather than everything). */
function parseAmountSpec(spec: string): {
  min: number | null;
  max: number | null;
  minIncl: boolean;
  maxIncl: boolean;
} | null {
  const v = spec.replace(/\$/g, "").trim();
  const cmp = /^([<>]=?)\s*(\d+(?:\.\d{1,2})?)$/.exec(v);
  if (cmp) {
    const n = Number(cmp[2]);
    if (!Number.isFinite(n)) return null;
    return cmp[1] === ">" || cmp[1] === ">="
      ? { min: n, max: null, minIncl: cmp[1] === ">=", maxIncl: false }
      : { min: null, max: n, minIncl: false, maxIncl: cmp[1] === "<=" };
  }
  const range = /^(\d+(?:\.\d{1,2})?)?-(\d+(?:\.\d{1,2})?)?$/.exec(v);
  if (range) {
    return {
      min: range[1] ? Number(range[1]) : null,
      max: range[2] ? Number(range[2]) : null,
      minIncl: true,
      maxIncl: true,
    };
  }
  if (v.endsWith("+")) {
    const min = parseAmountBound(v.slice(0, -1));
    return min === null
      ? null
      : { min, max: null, minIncl: true, maxIncl: false };
  }
  const exact = parseAmountBound(v);
  return exact === null
    ? null
    : { min: exact, max: exact, minIncl: true, maxIncl: true };
}

function amountInRange(rawAmount: string, spec: string): boolean {
  const amount = parseAmount(rawAmount);
  if (amount === null) return false;
  const bounds = parseAmountSpec(spec);
  if (bounds === null) return false;
  const n = amount.toNumber();
  if (
    bounds.min !== null &&
    !(n > bounds.min || (bounds.minIncl && n === bounds.min))
  ) {
    return false;
  }
  return !(
    bounds.max !== null &&
    !(n < bounds.max || (bounds.maxIncl && n === bounds.max))
  );
}

/** Does the row's amount satisfy one bare comparison (">100" & co)? */
function amountCompare(
  rawAmount: string,
  comparison: AmountComparison,
): boolean {
  const amount = parseAmount(rawAmount);
  if (amount === null) return false;
  const n = amount.toNumber();
  switch (comparison.op) {
    case ">":
      return n > comparison.value;
    case ">=":
      return n >= comparison.value;
    case "<":
      return n < comparison.value;
    case "<=":
      return n <= comparison.value;
  }
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
