import { describe, expect, it } from "vite-plus/test";
import { GENERAL_EMAIL_RULES, parseEmailRuleCsv } from "~/data/email-rules";

/** The general email-rule seed is hand-edited CSV, so these are about the
 * file as much as the parser: a swapped column, a duplicate, or a stray comma
 * has to fail loudly at boot instead of seeding a rule that never fires. */

describe("parseEmailRuleCsv", () => {
  it("reads the header and one rule per row", () => {
    expect(
      parseEmailRuleCsv("sender,note\napple.com,App Store receipts\n"),
    ).toEqual([{ sender: "apple.com", note: "App Store receipts" }]);
  });

  it("keeps a quoted note whole", () => {
    expect(
      parseEmailRuleCsv(
        'sender,note\na.example,"Ride receipts, one per trip"\n',
      ),
    ).toEqual([{ sender: "a.example", note: "Ride receipts, one per trip" }]);
  });

  it("lowercases a sender, the way the rule store does", () => {
    expect(
      parseEmailRuleCsv("sender,note\ndoorDash.com,Ride receipts\n"),
    ).toEqual([{ sender: "doordash.com", note: "Ride receipts" }]);
  });

  it("accepts an exact-address rule", () => {
    expect(
      parseEmailRuleCsv("sender,note\nreceipts@stripe.com,Stripe receipts\n"),
    ).toEqual([{ sender: "receipts@stripe.com", note: "Stripe receipts" }]);
  });

  it("skips blank lines", () => {
    expect(parseEmailRuleCsv("sender,note\n\napple.com,x\n\n")).toHaveLength(1);
  });

  it("refuses a file without the sender,note header", () => {
    expect(() => parseEmailRuleCsv("apple.com,App Store receipts\n")).toThrow(
      /header row/,
    );
    expect(() => parseEmailRuleCsv("note,sender\nx,apple.com\n")).toThrow(
      /header row/,
    );
  });

  it("refuses a row that is not a sender,note pair", () => {
    expect(() => parseEmailRuleCsv("sender,note\napple.com\n")).toThrow(
      /not a sender,note row/,
    );
    expect(() => parseEmailRuleCsv("sender,note\napple.com,a,b\n")).toThrow(
      /not a sender,note row/,
    );
  });

  it("refuses a sender that is neither an address nor a domain", () => {
    expect(() => parseEmailRuleCsv("sender,note\nnot a rule,x\n")).toThrow(
      /not an address or domain/,
    );
    // A swapped column lands here too: the note is not a domain.
    expect(() =>
      parseEmailRuleCsv("sender,note\nApp Store receipts,apple.com\n"),
    ).toThrow(/not an address or domain/);
  });

  it("refuses a duplicate sender, however it is spelled", () => {
    expect(() =>
      parseEmailRuleCsv("sender,note\napple.com,a\nApple.com,b\n"),
    ).toThrow(/duplicate sender "apple.com"/);
  });

  it("refuses a file with no rules", () => {
    expect(() => parseEmailRuleCsv("sender,note\n")).toThrow(/no rules/);
  });
});

describe("the shipped seed", () => {
  it("documents every rule", () => {
    for (const rule of GENERAL_EMAIL_RULES) {
      expect(rule.note.trim(), rule.sender).not.toBe("");
    }
  });

  it("holds only lowercased domain senders the matcher can fire on", () => {
    for (const rule of GENERAL_EMAIL_RULES) {
      expect(rule.sender, rule.sender).toBe(rule.sender.trim().toLowerCase());
      expect(rule.sender).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
    }
  });
});
