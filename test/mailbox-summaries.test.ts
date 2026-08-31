import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * parseEmailSummaries (app/lib/email-connection-mail.server.ts): the
 * Email/get listing boundary for the review scan and the drain. The
 * envelope rules match getEmailMetadata's (EXPENSE-S/X: shape surprises
 * are loud) with one listing-specific exception — a single malformed row
 * is skipped with a warning, because one junk email must not kill a whole
 * mailbox scan. Pure function: no fetch, no session.
 */

import { parseEmailSummaries } from "~/lib/email-connection-mail.server";

afterEach(() => {
  vi.restoreAllMocks();
});

const ROW = {
  id: "Md1",
  receivedAt: "2026-08-31T12:00:00Z",
  subject: "Receipt",
  from: [{ name: "Store", email: "store@example.com" }],
  preview: "Your order total",
};

describe("parseEmailSummaries", () => {
  it("maps rows and formats the first from address", () => {
    expect(
      parseEmailSummaries({ list: [ROW] }, { includePreview: true }),
    ).toEqual([
      {
        id: "Md1",
        receivedAt: "2026-08-31T12:00:00Z",
        subject: "Receipt",
        from: "Store <store@example.com>",
        preview: "Your order total",
      },
    ]);
  });

  it("omits preview unless the query asked for it", () => {
    const [summary] = parseEmailSummaries(
      { list: [ROW] },
      { includePreview: false },
    );
    expect(summary).not.toHaveProperty("preview");
  });

  it("tolerates null names and missing optional headers (RFC 8621)", () => {
    const [summary] = parseEmailSummaries(
      {
        list: [
          {
            id: "Md2",
            receivedAt: null,
            subject: null,
            from: [{ name: null, email: "noreply@store.example" }],
          },
        ],
      },
      { includePreview: false },
    );
    expect(summary!.from).toBe("noreply@store.example");
    expect(summary!.subject).toBe("");
    expect(summary!.receivedAt).toBeTruthy();
  });

  it("skips a malformed row with a warning instead of failing the scan", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const summaries = parseEmailSummaries(
      {
        list: [
          { id: "Md-good", subject: "ok" },
          { id: 42, subject: "junk id" },
          "not an object at all",
        ],
      },
      { includePreview: false },
    );
    expect(summaries.map((s) => s.id)).toEqual(["Md-good"]);
    expect(warn).toHaveBeenCalledWith(
      "[email-connections] skipping malformed Email/get row:",
      "id",
    );
  });

  it("throws loudly when the response is not an Email/get shape at all", () => {
    for (const junk of [undefined, null, "junk", 42]) {
      expect(() =>
        parseEmailSummaries(junk, { includePreview: false }),
      ).toThrowError(/Email\/get response shape mismatch/);
    }
  });

  it("treats a missing list as an empty mailbox, not an error", () => {
    expect(parseEmailSummaries({}, { includePreview: false })).toEqual([]);
  });
});
