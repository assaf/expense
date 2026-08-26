import { describe, expect, it } from "vitest";
import {
  isTransactionNotification,
  notificationAmounts,
  looksLikeReceiptEmail,
  hasOwnConfirmationHeader,
} from "~/lib/email-classify";

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
    // Same sender (no_reply@email.apple.com), not a receipt:
    // a TestFlight build-notice. No receipt signal, no money → rejected.
    ["Things 3 3.23 (32300527) for macOS is now available to test.", "", false],
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

describe("hasOwnConfirmationHeader", () => {
  it("matches the app's X-Expense-Confirmation header", () => {
    expect(hasOwnConfirmationHeader({ "X-Expense-Confirmation": "1" })).toBe(
      true,
    );
  });

  it("is case-insensitive on the header name", () => {
    expect(hasOwnConfirmationHeader({ "x-expense-confirmation": "1" })).toBe(
      true,
    );
    expect(hasOwnConfirmationHeader({ "X-EXPENSE-CONFIRMATION": "yes" })).toBe(
      true,
    );
  });

  it("returns false for a real receipt's headers", () => {
    expect(
      hasOwnConfirmationHeader({
        From: "receipts@apple.com",
        Subject: "Your receipt from Apple",
      }),
    ).toBe(false);
  });

  it("returns false for empty headers", () => {
    expect(hasOwnConfirmationHeader({})).toBe(false);
  });
});

describe("isTransactionNotification", () => {
  it("matches CapitalOne charge alerts, domestic and international", () => {
    expect(
      isTransactionNotification(
        "capitalone@service.capitalone.com",
        "A new transaction was charged to your account",
      ),
    ).toBe(true);
    expect(
      isTransactionNotification(
        "capitalone@alerts.capitalone.com",
        "A new international transaction was charged to your account",
      ),
    ).toBe(true);
  });

  it("rejects other subjects from the same sender", () => {
    expect(
      isTransactionNotification(
        "capitalone@service.capitalone.com",
        "Your statement is available",
      ),
    ).toBe(false);
    expect(
      isTransactionNotification(
        "capitalone@service.capitalone.com",
        "Re: A new transaction was charged to your account",
      ),
    ).toBe(false);
  });

  it("rejects the same wording from other senders", () => {
    expect(
      isTransactionNotification(
        "notify@chase.com",
        "A new transaction was charged to your account",
      ),
    ).toBe(false);
  });
});

describe("notificationAmounts", () => {
  it("collects and normalizes every dollar amount", () => {
    expect(
      notificationAmounts(
        "A new transaction was charged to your account.\nAmount: $1,234.56\nAvailable credit: $9.99",
      ),
    ).toEqual(["1234.56", "9.99"]);
  });

  it("is empty without a dollar-marked amount", () => {
    expect(notificationAmounts("Transaction amount: 1500 JPY")).toEqual([]);
  });
});
