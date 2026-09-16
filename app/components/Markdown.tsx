import { Link } from "react-router";
import { parseInline, parseMarkdown, type InlineSegment } from "~/lib/markdown";
import { SITE_URL } from "~/lib/seo-content";
import type { DocumentPage } from "~/data/content-types";

/**
 * Renders the small markdown subset (paragraphs, bullets, tables, headings,
 * **bold**, [links](https://…)) as React elements. The parser produces plain
 * strings only, so model output can never inject HTML.
 */

/** The marketing link style, shared with the hand-written links on the
 * marketing pages so a moved link keeps its look. */
const LINK_CLASS =
  "underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500 dark:decoration-gray-600";

export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="space-y-2">
      {blocks.map((block, i) => {
        if (block.kind === "bullets") {
          return (
            <ul key={i} className="list-disc space-y-0.5 pl-5">
              {block.items.map((segments, j) => (
                <li key={j}>{renderInline(segments)}</li>
              ))}
            </ul>
          );
        }
        if (block.kind === "table") {
          return (
            <div key={i} className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    {block.header.map((cell, j) => (
                      <th key={j} scope="col" className="py-1 pr-3 font-medium">
                        {cell}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, j) => (
                    <tr
                      key={j}
                      className="border-b border-gray-100 last:border-0 dark:border-gray-800"
                    >
                      {row.map((cell, k) => (
                        <td key={k} className="py-1 pr-3 tabular-nums">
                          {renderInline(parseInline(cell))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.kind === "heading") {
          const Heading = block.level === 3 ? "h3" : "h2";
          return (
            <Heading key={i} className="font-semibold">
              {renderInline(block.segments)}
            </Heading>
          );
        }
        return <p key={i}>{renderInline(block.segments)}</p>;
      })}
    </div>
  );
}

/** The sections of a prose document (/privacy, /terms, /support): the section
 * heading, then its paragraphs and bullet lists, in file order. */
export function DocumentSections({
  sections,
}: {
  sections: DocumentPage["sections"];
}) {
  return (
    <>
      {sections.map((section) => (
        <section key={section.title}>
          <h2 className="text-2xl font-bold tracking-tight text-ink">
            {section.title}
          </h2>
          {section.blocks.map((block, index) =>
            block.kind === "paragraph" ? (
              <p
                key={index}
                className="mt-3 text-sm leading-relaxed text-gray-600 dark:text-gray-300"
              >
                {renderInline(block.segments)}
              </p>
            ) : (
              <ul
                key={index}
                className="mt-3 list-disc space-y-0.5 pl-5 text-sm leading-relaxed text-gray-600 dark:text-gray-300"
              >
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderInline(item)}</li>
                ))}
              </ul>
            ),
          )}
        </section>
      ))}
    </>
  );
}

/** Prose that carries `**bold**` or `[links](…)` as text, for markup a page
 * owns. */
export function InlineMarkdown({ text }: { text: string }) {
  return renderInline(parseInline(text));
}

function renderInline(segments: InlineSegment[]) {
  return splitSpaceBeforeLinks(segments).map((segment, i) => {
    if (segment.href === undefined) {
      // Plain text stays a text node: wrapping it in an element would change
      // where the browser breaks its glyph runs, and the marketing pages are
      // compared against pixel baselines.
      return segment.bold ? (
        <strong key={i} className="font-semibold">
          {segment.text}
        </strong>
      ) : (
        segment.text
      );
    }
    const label = segment.bold ? (
      <strong className="font-semibold">{segment.text}</strong>
    ) : (
      segment.text
    );
    // A link to this site navigates in the client, the way the hand-written
    // links on these pages do. A mailto hands off to a mail client, so it
    // opens no tab at all; anything else opens in a new one.
    const path = internalPath(segment.href);
    if (path !== null) {
      return (
        <Link key={i} to={path} className={LINK_CLASS}>
          {label}
        </Link>
      );
    }
    if (segment.href.startsWith("mailto:")) {
      return (
        <a key={i} href={segment.href} className={LINK_CLASS}>
          {label}
        </a>
      );
    }
    return (
      <a
        key={i}
        href={segment.href}
        target="_blank"
        rel="noreferrer noopener"
        className={LINK_CLASS}
      >
        {label}
      </a>
    );
  });
}

/** Give the space that sits directly before a link its own text run.
 *
 * A browser measures the whitespace that ends a text run separately from
 * whitespace inside one, so `Label: [text](url)` lays out a hair (1/64px, one
 * layout unit) away from `Label:` + `" "` + the link — enough to move the
 * antialiasing of the rest of the line. The hand-written JSX these content
 * strings replaced always had that space as its own node (`Label:{" "}`),
 * and the marketing pages are compared against pixel baselines, so the
 * renderer reproduces it. */
function splitSpaceBeforeLinks(segments: InlineSegment[]): InlineSegment[] {
  const out: InlineSegment[] = [];
  for (const [index, segment] of segments.entries()) {
    const next = segments[index + 1];
    if (
      segment.href === undefined &&
      next?.href !== undefined &&
      segment.text.endsWith(" ")
    ) {
      out.push({ ...segment, text: segment.text.slice(0, -1) });
      out.push({ text: " ", bold: segment.bold });
      continue;
    }
    out.push(segment);
  }
  return out;
}

/** The site-relative path of an on-site link, or null for an external one. */
function internalPath(href: string): string | null {
  return href.startsWith(`${SITE_URL}/`) ? href.slice(SITE_URL.length) : null;
}
