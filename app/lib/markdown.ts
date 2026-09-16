/**
 * A deliberately small markdown subset, shared by the LLM answers on the
 * Insights page and the public content files under `app/data/`:
 * paragraphs, `-` bullet lists, GFM tables (`| a | b |` with a `|---|`
 * separator row), `#`/`##`/`###` headings, and inline `**bold**` and
 * `[text](https://…)` links.
 *
 * Everything else renders as plain text — importantly, the parser produces
 * plain strings and structure only, so the React renderer can build text
 * nodes without ever injecting HTML from model output. Only absolute
 * http(s) hrefs become links: `javascript:`, `mailto:`, and relative hrefs
 * stay literal `[text](url)` text, so no host or model can put a hostile
 * scheme into an `href`. Bold and links do not nest, so a `**` inside link
 * text stays literal.
 *
 * Each line is one block: a paragraph is a single line, never a soft-wrapped
 * run of lines. Blank lines separate blocks, and a table separator row is
 * optional (model output often omits it).
 */

export type InlineSegment = { text: string; bold: boolean; href?: string };

export type Block =
  | { kind: "paragraph"; segments: InlineSegment[] }
  | { kind: "bullets"; items: InlineSegment[][] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "heading"; level: 1 | 2 | 3; segments: InlineSegment[] };

/** One `[text](https://…)` link, absolute and http(s) only. */
const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/;

/** The same link, for a global replace (never used with `exec`). */
const LINK_ALL = new RegExp(LINK.source, "g");

const HEADING = /^(#{1,3})\s+(.+)$/;

/** Split one run of text into plain/link segments. */
function withLinks(text: string, bold: boolean): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let rest = text;
  for (;;) {
    const match = LINK.exec(rest);
    if (!match) break;
    const at = match.index;
    if (at > 0) segments.push({ text: rest.slice(0, at), bold });
    segments.push({ text: match[1]!, bold, href: match[2]! });
    rest = rest.slice(at + match[0].length);
  }
  if (rest !== "" || segments.length === 0) segments.push({ text: rest, bold });
  return segments;
}

/** Split a line into plain and **bold** segments, then into links.
 * Bold separators pair left to right; an odd count leaves the last one
 * unpaired, and it stays literal text. */
export function parseInline(line: string): InlineSegment[] {
  const raw = line.split("**");
  if (raw.length === 1) return withLinks(line, false);
  const unpaired = (raw.length - 1) % 2 === 1 ? raw.length - 1 : -1;
  const segments: InlineSegment[] = [];
  for (let i = 0; i < raw.length; i++) {
    const text = i === unpaired ? `**${raw[i]}` : raw[i]!;
    if (text === "") continue;
    segments.push(...withLinks(text, i % 2 === 1 && i !== unpaired));
  }
  return segments;
}

/** The plain text of an inline segment list: markdown syntax removed, so it
 * is safe inside JSON-LD answer text. */
export function plainText(text: string): string {
  return text
    .replace(
      LINK_ALL,
      (_match, label: string, href: string) => `${label} (${href})`,
    )
    .replaceAll("**", "");
}

function segmentText(segments: InlineSegment[]): string {
  return segments.map((segment) => segment.text).join("");
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
    const heading = HEADING.exec(trimmed);
    if (heading) {
      flushAll();
      blocks.push({
        kind: "heading",
        level: heading[1]!.length as 1 | 2 | 3,
        segments: parseInline(heading[2]!),
      });
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

/** A document split at its level-2 headings: the blocks before the first
 * `## ` are `intro`, and each section's title carries its own blocks
 * (level-1 and level-3 headings stay inside the section). */
export function splitSections(blocks: Block[]): {
  intro: Block[];
  sections: Array<{ title: string; blocks: Block[] }>;
} {
  const intro: Block[] = [];
  const sections: Array<{ title: string; blocks: Block[] }> = [];
  for (const block of blocks) {
    if (block.kind === "heading" && block.level === 2) {
      sections.push({ title: segmentText(block.segments), blocks: [] });
      continue;
    }
    const current = sections.at(-1);
    if (current) current.blocks.push(block);
    else intro.push(block);
  }
  return { intro, sections };
}
