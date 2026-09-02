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
 * rules live in `~/data/parse-categories`, shared with the marketing
 * surfaces so the CSV and the public Schedule C page can't drift.
 */
export const DEFAULT_CATEGORIES: string[] = parseCategoryCsv(categoriesCsv);
