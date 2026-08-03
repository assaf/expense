import categoriesCsv from "~/data/default-categories.csv?raw";

/**
 * Default categories seeded for every new account. These mirror the expense
 * categories on IRS Schedule C (Form 1040), Part II, lines 8–27a, so
 * receipts can be tagged with the same buckets used on the tax return.
 * Users can rename, add, or remove categories later in Settings.
 *
 * The list lives in `app/data/default-categories.csv` (one name per row,
 * `name` header; fields containing commas are wrapped in double quotes) so
 * it can be edited without touching code. Loaded at build time via Vite's
 * `?raw` import, so the file is bundled into the server output.
 */
export const DEFAULT_CATEGORIES: string[] = parseCategoryCsv(categoriesCsv);

const CSV_PATH = "app/data/default-categories.csv";

/**
 * Parse the single-column default-categories CSV. Blank rows are skipped and
 * the `name` header row is ignored. Throws on malformed rows (an unquoted
 * comma, a quote inside a name, an unterminated quoted field) and on
 * duplicate names so a bad edit fails loudly instead of silently changing
 * what every new account gets seeded with.
 */
function parseCategoryCsv(csv: string): string[] {
  const rows: string[] = [];
  let field = "";
  let quoted = false;

  const endRow = () => {
    rows.push(field);
    field = "";
    quoted = false;
  };

  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    if (quoted) {
      if (char === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      if (field.trim().length > 0) {
        throw new Error(
          `Invalid ${CSV_PATH}: quote inside a name — wrap the whole name in double quotes`,
        );
      }
      quoted = true;
      continue;
    }
    if (char === ",") {
      throw new Error(
        `Invalid ${CSV_PATH}: unquoted comma — wrap names containing commas in double quotes`,
      );
    }
    if (char === "\n" || char === "\r") {
      endRow();
      continue;
    }
    field += char;
  }
  if (quoted) {
    throw new Error(`Invalid ${CSV_PATH}: unterminated quoted field`);
  }
  endRow();

  const names: string[] = [];
  for (const [index, row] of rows.entries()) {
    const name = row.trim();
    if (name === "" || (index === 0 && name.toLowerCase() === "name")) {
      continue;
    }
    if (names.includes(name)) {
      throw new Error(`Invalid ${CSV_PATH}: duplicate name "${name}"`);
    }
    names.push(name);
  }
  return names;
}
