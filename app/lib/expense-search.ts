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
const FILTER_KEYS = ["report", "category", "merchant", "description"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

/** A query split into operator filters and free-text words (see
 * parseQuery). */
interface ParsedQuery {
  filters: Record<FilterKey, string[]>;
  words: string[];
}

/**
 * Parse a search query into operator filters plus free-text words.
 * `report:` / `category:` / `merchant:` set exact filters (case-insensitive);
 * `description:` substring-matches the free text description. An operator's
 * value runs to the next recognized prefix, so spaced values work:
 * `report:2026 business`, `description:printer paper`. Free text (before
 * any operator, or under an unknown prefix) ANDs words against the row's
 * searchable text, as always. Same-key values OR together; keys AND
 * together. An operator with no value is a no-op, and colon-bearing free
 * text ("10:30") is untouched.
 *
 * Parse once per query change and feed `matchesSearch` per row: the filter
 * runs on every keystroke across the whole list.
 */
export function parseQuery(query: string): ParsedQuery {
  const filters: Record<FilterKey, string[]> = {
    report: [],
    category: [],
    merchant: [],
    description: [],
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
    const op = /^(report|category|merchant|description):(.*)$/.exec(token);
    if (op && (FILTER_KEYS as readonly string[]).includes(op[1])) {
      flush();
      key = op[1] as FilterKey;
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
      !filters.category.some((v) => v === e.category.toLowerCase())) ||
    (filters.merchant.length > 0 &&
      !filters.merchant.some((v) => v === e.merchant.toLowerCase())) ||
    (filters.description.length > 0 &&
      !filters.description.some((v) => e.description.toLowerCase().includes(v)))
  ) {
    return false;
  }
  if (words.length === 0) return true;
  const haystack = searchableText(e);
  return words.every((word) => haystack.includes(word));
}
