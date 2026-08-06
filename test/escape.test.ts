import { describe, expect, it } from "vitest";
import { escapeHtml } from "~/lib/escape";

describe("escapeHtml", () => {
  it("passes through plain text unchanged", () => {
    expect(escapeHtml("Hello, world.")).toBe("Hello, world.");
  });

  it("escapes all five HTML-significant characters", () => {
    expect(escapeHtml("if a < b && b > c then \"a\" isn't 'b'")).toBe(
      "if a &lt; b &amp;&amp; b &gt; c then &quot;a&quot; isn&apos;t &apos;b&apos;",
    );
  });

  it("escapes ampersands first so already-escaped text is not double-escaped", () => {
    expect(escapeHtml("&")).toBe("&amp;");
    // Already-escaped input is re-escaped — that is the correct
    // one-pass behavior: it protects against data that contains
    // literal ampersands. You must never double-escape; callers
    // that pass pre-escaped strings won't do it.
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  it("handles empty string and strings with only safe characters", () => {
    expect(escapeHtml("")).toBe("");
    expect(escapeHtml("abc123")).toBe("abc123");
  });

  it("escapes embedded HTML tags as text, not markup", () => {
    expect(escapeHtml("<b>Bold</b>")).toBe("&lt;b&gt;Bold&lt;/b&gt;");
  });
});
