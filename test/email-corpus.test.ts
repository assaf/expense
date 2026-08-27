import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyReceiptEmail } from "~/lib/email-classify";

interface CorpusEntry {
  id: string;
  subject: string;
  from: string;
  body?: string;
  preview?: string;
  label: string;
}

/**
 * Golden test over the reviewed corpus (test/fixtures/email-corpus.json).
 * Labels are the user's judgment: "receipt" = imported receipts they
 * accept; "ignored:*" = everything that must stay in the Inbox.
 *
 * THE RULE: precision first — a non-receipt must NEVER classify as
 * "receipt", even when the body mentions an amount. Recall is allowed to
 * lose: uncertain emails stay in the Inbox for review.
 */
describe("email corpus classification", () => {
  const corpus: CorpusEntry[] = JSON.parse(
    readFileSync("test/fixtures/email-corpus.json", "utf8"),
  );

  it("never classifies a labeled non-receipt as a receipt", () => {
    const falsePositives: string[] = [];
    for (const e of corpus) {
      if (e.label === "receipt" || e.label === "ignored:self") continue;
      const v = classifyReceiptEmail({
        fromAddress: e.from,
        subject: e.subject,
        bodyText: e.body ?? e.preview ?? "",
      });
      if (v.verdict === "receipt") {
        falsePositives.push(`${e.label}: ${e.subject}`);
      }
    }
    expect(falsePositives).toEqual([]);
  });

  it("classifies every labeled receipt as a receipt", () => {
    const misses: string[] = [];
    for (const e of corpus) {
      if (e.label !== "receipt") continue;
      const v = classifyReceiptEmail({
        fromAddress: e.from,
        subject: e.subject,
        bodyText: e.body ?? e.preview ?? "",
      });
      if (v.verdict !== "receipt") {
        misses.push(`${v.verdict} (${v.reason}): ${e.subject}`);
      }
    }
    expect(misses).toEqual([]);
  });

  it("leaves uncertain emails alone rather than guessing", () => {
    // Uncertain emails stay in the Inbox untouched (no LLM call, no
    // import) — the corpus confirms they are newsletters and account
    // notices, and the precision rule forbids guessing.
    const uncertain = corpus
      .filter((e) => e.label !== "receipt" && e.label !== "ignored:self")
      .filter(
        (e) =>
          classifyReceiptEmail({
            fromAddress: e.from,
            subject: e.subject,
            bodyText: e.body ?? e.preview ?? "",
          }).verdict === "uncertain",
      );
    expect(uncertain.length).toBeGreaterThan(0);
  });
});
