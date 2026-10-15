import categoriesCsv from "~/data/default-categories.csv?raw";
import { parseCategoryCsv } from "~/data/parse-categories";

/**
 * Default categories seeded for every new account. These mirror the expense
 * categories on IRS Schedule C (Form 1040), Part II, lines 8–27a, so
 * receipts can be tagged with the same buckets used on the tax return.
 * Users can rename, add, or remove categories later in Settings.
 *
 * The list lives in `app/data/default-categories.csv` (one name per row,
 * no header; fields containing commas are wrapped in double quotes) so
 * it can be edited without touching code. Loaded at build time via Vite's
 * `?raw` import, so the file is bundled into the server output. The parsing
 * rules live in `~/data/parse-categories`; `~/lib/content.server` reads the
 * same list for the public Schedule C page, so the CSV, the categories new
 * accounts get, and that page can't drift.
 */
export const DEFAULT_CATEGORIES: string[] = parseCategoryCsv(categoriesCsv);

/** The name the seeded list gives the driving bucket: IRS Schedule C line 9,
 * the line the standard mileage rate and fuel costs are claimed on (see
 * `app/data/schedule-c-categories.yaml`). `test/default-categories.test.ts`
 * pins it to the CSV row. */
export const MILEAGE_CATEGORY = "Car and truck expenses";

/** What accounts call that bucket once they have renamed their categories.
 * "vehicle" is deliberately absent: the seeded list has "Rent or lease:
 * vehicles, machinery, and equipment", which is not where fuel goes. */
const MILEAGE_FAMILY = /\bmileage\b|\bfuel\b|car and truck/;

/** Category names compare loosely: lower case, and no fuss over the spacing
 * around a separator, so "Fuel / Mileage" and "Fuel/Mileage" are the same
 * bucket to a person and to this match. */
function normaliseCategory(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*([/&])\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The bucket a new mileage defaults to, resolved against the account's own
 * list. Every new account is seeded with `MILEAGE_CATEGORY`, but accounts
 * rename their categories (real ones read "Fuel / Mileage" and
 * "Fuel/Mileage"), and a default matching one literal name silently does
 * nothing on a renamed list — which is what it did. So: that row when it
 * exists, otherwise the first category named for fuel, mileage or
 * car-and-truck driving.
 *
 * Deliberately not "Travel": that is the Schedule C line for travel away from
 * home, and local driving is the car bucket.
 *
 * Returns "" when the account has neither, so a mileage files with no category
 * — the behaviour before this default existed, and never a category the
 * account does not own.
 *
 * Every path that files a trip reads this: the create form preselects it, and
 * the MCP `log_mileage` tool and the insights chat's confirmed trip fill it in
 * when no category was given.
 */
export function mileageCategory(names: string[]): string {
  const wanted = normaliseCategory(MILEAGE_CATEGORY);
  const exact = names.find((name) => normaliseCategory(name) === wanted);
  if (exact) return exact;
  return names.find((name) => isMileageCategoryName(name)) ?? "";
}

/** Whether a name is the driving bucket under any of its spellings, so a
 * caller echoing an old one ("Fuel / Mileage") can still be resolved. */
export function isMileageCategoryName(name: string): boolean {
  return MILEAGE_FAMILY.test(normaliseCategory(name));
}
