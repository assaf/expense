/**
 * Seed for GENERAL email rules — senders whose emails are auto-imported by
 * every connected account. Synced into email_rules (accountId = "") on
 * boot by initStore; edit this list and restart to change the rules.
 *
 * A domain matches the domain and any subdomain (apple.com covers
 * no_reply@email.apple.com). Be conservative: a false positive means a
 * marketing email gets classified (and only trashed when it really parses
 * as a receipt), while a false negative just means manual entry — same as
 * today. Marketing-heavy senders stay OFF this list.
 */

export interface GeneralEmailRuleSeed {
  sender: string;
  note: string;
}

export const GENERAL_EMAIL_RULES: GeneralEmailRuleSeed[] = [
  { sender: "apple.com", note: "App Store + Apple Store receipts" },
  { sender: "amazon.com", note: "Order confirmations and digital receipts" },
  {
    sender: "stripe.com",
    note: "Payment receipts from Stripe-billed merchants",
  },
  { sender: "paypal.com", note: "Payment receipts" },
  { sender: "uber.com", note: "Ride receipts" },
  { sender: "lyft.com", note: "Ride receipts" },
  { sender: "doorDash.com", note: "Order receipts" },
  { sender: "grubhub.com", note: "Order receipts" },
  { sender: "instacart.com", note: "Order receipts" },
  { sender: "squareup.com", note: "Square receipts" },
  // Recurring billers — invoices/statements with an Amount-due line. The
  // local gate keeps them (money total rescues the bland "bill" subject);
  // marketing mail from the same senders is rejected (no money).
  { sender: "shopify.com", note: "Shopify subscription bills" },
  { sender: "conservice.com", note: "Conservice utility statements" },
  { sender: "spectrum.com", note: "Spectrum internet/cable bills" },
  { sender: "verizonwireless.com", note: "Verizon Wireless phone bills" },
];
