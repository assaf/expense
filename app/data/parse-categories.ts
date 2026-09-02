/**
 * Parser for the single-column default-categories CSV (and any other
 * single-column name list). Blank rows are skipped; a literal first-row
 * `name` (the legacy header) is tolerated but not required. Throws on
 * malformed rows (an unquoted comma, a quote inside a name, an unterminated
 * quoted field) and on duplicate names so a bad edit fails loudly.
 *
 * Lives in `app/data/` (no `.server` suffix) because the marketing surfaces
 * parse the same CSV at build time to render the Schedule C reference page;
 * the parser touches nothing beyond string handling, so it bundles safely.
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
