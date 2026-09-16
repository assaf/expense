/**
 * CSV parsing, one implementation for the whole app: the statement reader
 * (`app/lib/reconcile.server.ts`) and the hand-edited seeds under `app/data/`
 * both come through here, so a quoted field behaves the same on both sides.
 *
 * Deliberately plain: RFC 4180-ish, no dependency, no dialect guessing. It
 * returns cells only; deciding what the columns mean (a statement's
 * debit/credit split, a seed's sender/note) belongs to the caller, which is
 * also where a bad shape should be reported. A *single*-column list with no
 * second column at all is better served by `~/data/parse-categories`, which
 * treats a comma as an editing mistake instead of a field separator.
 */

/** Parse CSV text (RFC 4180-ish: quotes, doubled quotes, CRLF). Rows whose
 * cells are all blank are dropped, so trailing newlines and blank lines
 * between entries are harmless. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}
