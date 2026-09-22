import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  exceedsBase64Budget,
  MAX_RECEIPT_BYTES,
  MAX_RECEIPT_ENCODED_CHARS,
} from "~/lib/upload-limits";

/**
 * `exceedsBase64Budget` is the pre-decode gate on every base64 receipt
 * (editor paste, MCP capture, inbound attachment): if its arithmetic or its
 * whitespace/`data:` handling drifts, an oversized argument either sneaks
 * through to decode (allocation, the bug the count-in-place loop exists to
 * avoid) or a legitimate MIME-wrapped image is refused. The email side imports
 * this module too, so the number must stay exact.
 */

describe("exceedsBase64Budget", () => {
  it("is exact at the cap", () => {
    const at = "A".repeat(MAX_RECEIPT_ENCODED_CHARS);
    expect(exceedsBase64Budget(at, MAX_RECEIPT_ENCODED_CHARS)).toBe(false);
    expect(exceedsBase64Budget(`${at}A`, MAX_RECEIPT_ENCODED_CHARS)).toBe(true);
  });

  it("derives the encoded cap as four characters per three bytes", () => {
    expect(MAX_RECEIPT_ENCODED_CHARS).toBe(
      Math.floor(MAX_RECEIPT_BYTES / 3) * 4,
    );
  });

  it("accepts a MIME-wrapped legal image (whitespace ignored)", () => {
    const png = readFileSync("test/fixtures/images/blue-bottle.png");
    const wrapped = png.toString("base64").replace(/(.{76})/g, "$1\r\n");
    expect(exceedsBase64Budget(wrapped, MAX_RECEIPT_ENCODED_CHARS)).toBe(false);
  });

  it("counts only non-whitespace characters", () => {
    const body = "A".repeat(50).replace(/(.{10})/g, "$1\n");
    expect(exceedsBase64Budget(body, 50)).toBe(false);
    expect(exceedsBase64Budget(`${body}A`, 50)).toBe(true);
  });

  it("does not count a data: URL prefix", () => {
    const prefix = "data:image/png;base64,";
    expect(exceedsBase64Budget(`${prefix}${"A".repeat(50)}`, 50)).toBe(false);
    expect(exceedsBase64Budget(`${prefix}${"A".repeat(51)}`, 50)).toBe(true);
  });
});
