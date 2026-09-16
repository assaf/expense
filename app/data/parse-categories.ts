/**
 * Parser for the single-column default-categories CSV (and any other
 * single-column name list). Blank rows are skipped; a literal first-row
 * `name` (the legacy header) is tolerated but not required. Throws on
 * malformed rows (an unquoted comma, a quote inside a name, an unterminated
 * quoted field) and on duplicate names so a bad edit fails loudly.
 *
 * Deliberately narrower than the statement reader (`parseCsv` in
 * `app/lib/reconcile.server.ts`): a name list has no second column, so a comma
 * or a quote is an editing mistake to report, not a field to parse. A plain
 * module, no Node or DB access, so either side can read the CSV.
 *
 * The seeder (`app/lib/default-categories.server.ts`) and the public Schedule C
 * page (through `app/lib/content.server.ts`) both go through here, so the
 * categories new accounts get and the page's table can't drift.
 */

const CSV_PATH = "app/data/default-categories.csv";

export function parseCategoryCsv(csv: string): string[] {
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
