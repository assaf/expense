import { parseInline, parseMarkdown } from "~/lib/markdown";

/**
 * Renders the small markdown subset the AI answers use (paragraphs,
 * bullets, tables, **bold**) as React elements. The parser produces
 * plain strings only, so model output can never inject HTML.
 */
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
        return <p key={i}>{renderInline(block.segments)}</p>;
      })}
    </div>
  );
}

function renderInline(segments: { text: string; bold: boolean }[]) {
  return segments.map((segment, i) =>
    segment.bold ? (
      <strong key={i} className="font-semibold">
        {segment.text}
      </strong>
    ) : (
      <span key={i}>{segment.text}</span>
    ),
  );
}
