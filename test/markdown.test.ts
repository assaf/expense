import { describe, expect, it } from "vite-plus/test";
import {
  parseInline,
  parseMarkdown,
  plainText,
  splitSections,
} from "~/lib/markdown";

describe("parseInline", () => {
  it("splits bold segments", () => {
    expect(parseInline("You spent **$105.00** in July")).toEqual([
      { text: "You spent ", bold: false },
      { text: "$105.00", bold: true },
      { text: " in July", bold: false },
    ]);
  });

  it("pairs ** at the start of the line", () => {
    // Model answers open with bold: "**August (this month): $185.44** ..."
    expect(parseInline("**August: $185.44** across 14 expenses")).toEqual([
      { text: "August: $185.44", bold: true },
      { text: " across 14 expenses", bold: false },
    ]);
  });

  it("keeps a trailing odd ** literal", () => {
    const segments = parseInline("total **$12** plus ** 3 more");
    expect(segments[segments.length - 1].text).toBe("** 3 more");
  });

  it("renders an unpaired ** as literal text", () => {
    const segments = parseInline("odd ** marker");
    expect(segments.every((s) => !s.bold)).toBe(true);
    expect(segments.map((s) => s.text).join("")).toContain("**");
  });

  it("turns an absolute https link into a segment carrying its href", () => {
    expect(
      parseInline("See [the FAQ](https://expense.labnotes.org/faq) now"),
    ).toEqual([
      { text: "See ", bold: false },
      {
        text: "the FAQ",
        bold: false,
        href: "https://expense.labnotes.org/faq",
      },
      { text: " now", bold: false },
    ]);
  });

  it("turns a mailto link into a segment carrying its href", () => {
    expect(
      parseInline("Write to [assaf@labnotes.org](mailto:assaf@labnotes.org)"),
    ).toEqual([
      { text: "Write to ", bold: false },
      {
        text: "assaf@labnotes.org",
        bold: false,
        href: "mailto:assaf@labnotes.org",
      },
    ]);
  });

  it("keeps a script scheme or a relative href literal", () => {
    const line = "Open [this](javascript:alert(1)) and [that](/faq)";
    expect(parseInline(line)).toEqual([{ text: line, bold: false }]);
  });

  it("keeps a link inside a bold run, and bold inside link text, literal", () => {
    // Bold wraps a whole link: the link is found inside the bold segment, so
    // the label renders bold and the href still navigates.
    expect(parseInline("**[the FAQ](https://x.test)**")).toEqual([
      { text: "the FAQ", bold: true, href: "https://x.test" },
    ]);
    // A `**` inside link text is not a bold marker.
    expect(parseInline("[**bold**](https://x.test)")).toEqual([
      { text: "[", bold: false },
      { text: "bold", bold: true },
      { text: "](https://x.test)", bold: false },
    ]);
  });
});

describe("parseMarkdown", () => {
  it("splits paragraphs on blank lines", () => {
    const blocks = parseMarkdown("First paragraph.\n\nSecond one.");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      segments: [{ text: "First paragraph.", bold: false }],
    });
  });

  it("groups - lines into a bullet list", () => {
    const blocks = parseMarkdown("Intro:\n- Z.ai $80\n- DeepSeek $25");
    expect(blocks).toEqual([
      {
        kind: "paragraph",
        segments: [{ text: "Intro:", bold: false }],
      },
      {
        kind: "bullets",
        items: [
          [{ text: "Z.ai $80", bold: false }],
          [{ text: "DeepSeek $25", bold: false }],
        ],
      },
    ]);
  });

  it("parses a gfm table with its separator row", () => {
    const blocks = parseMarkdown(
      "| Month | Total |\n|---|---|\n| July | $105.00 |\n| June | $95.00 |",
    );
    expect(blocks).toEqual([
      {
        kind: "table",
        header: ["Month", "Total"],
        rows: [
          ["July", "$105.00"],
          ["June", "$95.00"],
        ],
      },
    ]);
  });

  it("opens a table without a separator row (lenient for model output)", () => {
    const blocks = parseMarkdown(
      "| Merchant | Amount |\n| Z.ai | $80.00 |\n| DeepSeek | $25.00 |",
    );
    expect(blocks).toEqual([
      {
        kind: "table",
        header: ["Merchant", "Amount"],
        rows: [
          ["Z.ai", "$80.00"],
          ["DeepSeek", "$25.00"],
        ],
      },
    ]);
  });

  it("keeps a lone pipe-row as a paragraph", () => {
    const blocks = parseMarkdown("| just text |");
    expect(blocks).toEqual([
      {
        kind: "paragraph",
        segments: [{ text: "| just text |", bold: false }],
      },
    ]);
  });

  it("keeps inline bold inside table cells", () => {
    const blocks = parseMarkdown(
      "| Key | Value |\n|---|---|\n| Total | **$105** |",
    );
    expect(blocks[0]).toEqual({
      kind: "table",
      header: ["Key", "Value"],
      rows: [["Total", "**$105**"]],
    });
  });

  it("treats model text with html as plain text (no injection surface)", () => {
    const blocks = parseMarkdown("<script>alert(1)</script>");
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      segments: [{ text: "<script>alert(1)</script>", bold: false }],
    });
  });

  it("flushes a bullet list when a paragraph follows", () => {
    const blocks = parseMarkdown("- a\n- b\nDone.");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.kind).toBe("bullets");
    expect(blocks[1]!.kind).toBe("paragraph");
  });

  it("parses headings of one to three hashes", () => {
    expect(parseMarkdown("# One\n\n## Two\n\n### Three")).toEqual([
      { kind: "heading", level: 1, segments: [{ text: "One", bold: false }] },
      { kind: "heading", level: 2, segments: [{ text: "Two", bold: false }] },
      { kind: "heading", level: 3, segments: [{ text: "Three", bold: false }] },
    ]);
  });

  it("keeps a # that does not open a line as text", () => {
    for (const line of ["costs #1 a mile", "#hashtag", "#### four"]) {
      expect(parseMarkdown(line)).toEqual([
        { kind: "paragraph", segments: [{ text: line, bold: false }] },
      ]);
    }
  });
});

describe("splitSections", () => {
  it("groups blocks at level-2 headings, keeping a level-3 heading in its section", () => {
    const { intro, sections } = splitSections(
      parseMarkdown(
        "Intro text.\n\n## First\n\nOne.\n\n### Detail\n\nTwo.\n\n## Second\n\nThree.",
      ),
    );
    expect(intro).toEqual([
      { kind: "paragraph", segments: [{ text: "Intro text.", bold: false }] },
    ]);
    expect(sections.map((section) => section.title)).toEqual([
      "First",
      "Second",
    ]);
    expect(sections[0]!.blocks.map((block) => block.kind)).toEqual([
      "paragraph",
      "heading",
      "paragraph",
    ]);
    expect(sections[1]!.blocks).toEqual([
      { kind: "paragraph", segments: [{ text: "Three.", bold: false }] },
    ]);
  });

  it("returns everything as intro when there is no level-2 heading", () => {
    const { intro, sections } = splitSections(parseMarkdown("Just prose."));
    expect(sections).toEqual([]);
    expect(intro).toHaveLength(1);
  });
});

describe("plainText", () => {
  it("strips bold and rewrites a link as its label and URL", () => {
    expect(
      plainText(
        "**Yes.** See [the full table](https://expense.labnotes.org/mileage-rates).",
      ),
    ).toBe(
      "Yes. See the full table (https://expense.labnotes.org/mileage-rates).",
    );
  });

  it("leaves a line without markdown alone", () => {
    const line = "The rate is $0.76 per mile for 2026.";
    expect(plainText(line)).toBe(line);
  });
});
