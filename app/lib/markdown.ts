/**
 * A deliberately small markdown subset for LLM answers: paragraphs,
 * `-` bullet lists, GFM tables (`| a | b |` with a `|---|` separator
 * row), and inline `**bold**`. Everything else renders as plain text —
 * importantly, the parser produces plain strings and structure only, so
 * the React renderer can build text nodes without ever injecting HTML
 * from model output.
 */

export type InlineSegment = { text: string; bold: boolean };

export type Block =
  | { kind: "paragraph"; segments: InlineSegment[] }
  | { kind: "bullets"; items: InlineSegment[][] }
  | { kind: "table"; header: string[]; rows: string[][] };

/** Split a line into plain and **bold** segments. Unmatched `**` stays
 * literal text. */
export function parseInline(line: string): InlineSegment[] {
  const parts = line.split(/\*\*/).filter((part) => part !== "");
  if (parts.length === 0) return [{ text: "", bold: false }];
  // An odd number of `**` separators leaves the last one unpaired: the
  // whole line is literal text (even part count).
  // An unpaired separator (even part count) renders literally: rejoin
  // the parts with the ** back.
  if (parts.length % 2 === 0) {
    return parts.map((part, i) => ({
      text: i === 0 ? part : `**${part}`,
      bold: false,
    }));
  }
  return parts.map((part, i) => ({
    text: part,
    bold: i % 2 === 1,
  }));
}

const TABLE_SEPARATOR = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;

/** Parse the markdown subset into blocks. */
export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  let bullets: InlineSegment[][] | null = null;
  let table: { header: string[]; rows: string[][] } | null = null;

  const flushBullets = () => {
    if (bullets && bullets.length > 0) {
      blocks.push({ kind: "bullets", items: bullets });
    }
    bullets = null;
  };
  const flushTable = () => {
    if (table && table.rows.length > 0) {
      blocks.push({ kind: "table", ...table });
    }
    table = null;
  };
  const flushAll = () => {
    flushBullets();
    flushTable();
  };

  const splitRow = (line: string): string[] =>
    line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());

  for (const line of text.trim().split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushAll();
      continue;
    }
    if (/^-\s+/.test(trimmed)) {
      flushTable();
      bullets ??= [];
      bullets.push(parseInline(trimmed.replace(/^-\s+/, "")));
      continue;
    }
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const cells = splitRow(trimmed);
      if (TABLE_SEPARATOR.test(trimmed)) continue; // separator row
      if (table) {
        table.rows.push(cells);
      } else {
        table = { header: cells, rows: [] };
      }
      continue;
    }
    flushAll();
    blocks.push({ kind: "paragraph", segments: parseInline(trimmed) });
  }
  flushAll();
  return blocks;
}
