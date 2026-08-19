import { describe, expect, it } from "vitest";
import { looksLikeReceiptEmail } from "~/lib/email-classify";

/** The local (no-LLM) gate that decides whether extraction runs at all. */
describe("looksLikeReceiptEmail", () => {
  const cases: Array<[subject: string, body: string, expected: boolean]> = [
    // Receipts: subject signals.
    ["Your receipt from Apple", "", true],
    ["Invoice #1234", "", true],
    ["Your order #W123456", "", true],
    ["Order confirmation", "", true],
    ["Payment received — thanks!", "", true],
    ["Thanks for your purchase", "", true],
    [
      "Your Amazon.com order with FREE Prime shipping has shipped…",
      "Tracking: 1Z999",
      false,
    ],
    // Receipts: money in the body rescues a bland subject.
    ["Your subscription", "Thanks for renewing. Total: $9.99", true],
    ["June statement", "Amount paid $42.50", true],
    ["Thanks", "Order total: EUR 12,00", true],
    // Marketing: subject or body signals, no money.
    ["Weekly digest", "Here's what you missed.", false],
    ["Check out our new products!", "The new line is here.", false],
    ["Big sale this weekend", "Everything must go.", false],
    [
      "Our newsletter",
      "You are receiving this email because you signed up. Unsubscribe here.",
      false,
    ],
    [
      "Important update to your account",
      "We updated our privacy policy. Manage your preferences.",
      false,
    ],
    // Marketing body WITH money still passes (total dominates).
    ["Holiday sale", "Order total: $10.00 in credits inside!", true],
    // Shipping notices without money.
    ["Your package is out for delivery", "Track your package.", false],
    ["Delivery update", "Arriving Tuesday.", false],
  ];

  it.each(cases)("%s / %s -> %s", (subject, body, expected) => {
    expect(looksLikeReceiptEmail({ subject, bodyText: body })).toBe(expected);
  });

  it("ignores nothing on empty input", () => {
    expect(looksLikeReceiptEmail({ subject: "", bodyText: "" })).toBe(false);
  });
});
