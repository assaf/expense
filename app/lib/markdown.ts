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

/** Split a line into plain and **bold** segments. Separators pair left
 * to right; an odd count leaves the last one unpaired, and it stays
 * literal text. */
export function parseInline(line: string): InlineSegment[] {
  const raw = line.split("**");
  if (raw.length === 1) return [{ text: line, bold: false }];
  const unpaired = (raw.length - 1) % 2 === 1 ? raw.length - 1 : -1;
  const segments: InlineSegment[] = [];
  for (let i = 0; i < raw.length; i++) {
    const text = i === unpaired ? `**${raw[i]}` : raw[i];
    if (text === "") continue;
    segments.push({ text, bold: i % 2 === 1 && i !== unpaired });
  }
  return segments;
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

  const lines = text.trim().split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
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
    const isPipeRow = trimmed.startsWith("|") && trimmed.endsWith("|");
    if (isPipeRow && !table) {
      // A pipe-row opens a table when the NEXT line is also a pipe-row
      // (the `---` separator may be missing from model output): the first
      // row becomes the header. A lone pipe-row is just a paragraph.
      const next = lines[i + 1]?.trim() ?? "";
      const nextIsPipeRow = next.startsWith("|") && next.endsWith("|");
      const nextIsSeparator = TABLE_SEPARATOR.test(next);
      if (!nextIsPipeRow && !nextIsSeparator) {
        flushAll();
        blocks.push({ kind: "paragraph", segments: parseInline(trimmed) });
        continue;
      }
      flushBullets();
      table = { header: splitRow(trimmed), rows: [] };
      continue;
    }
    if (isPipeRow && table) {
      if (TABLE_SEPARATOR.test(trimmed)) continue; // separator row
      table.rows.push(splitRow(trimmed));
      continue;
    }
    flushAll();
    blocks.push({ kind: "paragraph", segments: parseInline(trimmed) });
  }
  flushAll();
  return blocks;
}
