import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "~/lib/markdown";

describe("parseInline", () => {
  it("splits bold segments", () => {
    expect(parseInline("You spent **$105.00** in July")).toEqual([
      { text: "You spent ", bold: false },
      { text: "$105.00", bold: true },
      { text: " in July", bold: false },
    ]);
  });

  it("renders an unpaired ** as literal text", () => {
    const segments = parseInline("odd ** marker");
    expect(segments.every((s) => !s.bold)).toBe(true);
    expect(segments.map((s) => s.text).join("")).toContain("**");
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
});
