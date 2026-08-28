import { TRANSACTION_NOTIFICATION_SENDERS } from "~/data/notification-senders";
/**
 * Local (no-LLM) classification for connected-account email: does this
 * email look like a receipt/order confirmation worth processing?
 *
 * This gate runs on EVERY rule-matched email in the webhook/cron drain:
 * it must stay cheap (regex over subject + plain-text body) so marketing
 * mail is filtered without a model call. The LLM extraction only runs
 * after this says yes; the model's isReceipt verdict remains the backstop
 * for junk that slips through.
 *
 * False negatives are possible (a receipt with neither a receipt-y subject
 * nor a parseable total is skipped), accepted deliberately: rule-matched
 * senders' receipts virtually always carry one of these signals, and the
 * user still has the email in their Inbox to add manually.
 */

const RECEIPT_SUBJECT_RE =
  /(receipt|invoice|order (confirmation|summary|details|#)|your order|payment (confirmation|received)|purchase (confirmation|receipt)|thank(s| you) for your (order|purchase)|booking (confirmation|receipt)|ride (receipt|summary)|transaction (receipt|confirmation)|you paid|paid successfully)/i;

/** "Your order has shipped" and friends: order-related, but not money. */
const SHIPMENT_SUBJECT_RE =
  /(has shipped|shipping (confirmation|update|notice)|shipment (confirmation|update)|tracking (number|info)|out for delivery|delivery (update|confirmation|scheduled)|on its way|order (update|confirmed))/i;

const MARKETING_SUBJECT_RE =
  /(newsletter|digest|special offer|sale|deal|coupon|promo(tion)?|unsubscribe|% off|new (products|arrivals|features)|limited time|webinar|event invitation|black friday|holiday (sale|gift))/i;

const MARKETING_BODY_RE =
  /(unsubscribe|view in browser|manage (your )?(email )?preferences|you (are|'re) receiving this (e-?mail|message) because|advertis(e|ing|ement)|shop (now|the)|buy now|limited time offer|free shipping on orders)/i;

/** A money amount near a total-ish keyword, or any $X.XX amount. */
const TOTAL_BODY_RE =
  /((?:grand |order |amount |total )?total|amount paid|paid|charged|balance due|due)[:\s]{0,20}(?:usd|eur|gbp|cad|aud)?\s?[€£$]?\s?\d+(?:[.,]\d{2})|[€£$]\s?\d+(?:[.,]\d{2})/i;

/** The app's own outbound mail carries this header (set by
 * buildRfc822Message) so the inbound pipelines can recognize it and never
 * reprocess it (the loop guard). Header-based (not subject-based) so it's a
 * stable signal that survives subject-wording changes and can't be spoofed
 * by a real receipt (no real sender sets our custom header). */
export function hasOwnConfirmationHeader(
  headers: Record<string, string>,
): boolean {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "x-expense-confirmation") return true;
  }
  return false;
}

/** Senders whose "a transaction was charged" mail is a bank notification,
 * not a merchant receipt: the seed table in app/data/notification-senders.ts
 * (a domain + its subject pattern per bank). Compiled once here, per
 * entry, so adding a bank is a data edit. */
const TRANSACTION_NOTIFICATION_SUBJECT_RES =
  TRANSACTION_NOTIFICATION_SENDERS.map(
    (seed) => new RegExp(seed.subjectRe, "i"),
  );

/**
 * Is this a bank transaction notification ("A new transaction was charged
 * to your account")? These are indistinguishable from each other by
 * content: the same email is noise when the merchant also sends a receipt
 * (the z.ai case) and the only record when they don't (self-storage and
 * other card-only charges). So the email alone can never decide; callers
 * check it against already-imported expenses (same amount, same date)
 * and supersede it when a real receipt covers the charge.
 */
/** Is this sender a bank's notification address (the seed domains in
 * notification-senders.ts)? Bank notification mail is never a merchant
 * receipt: charge alerts are handled by inbox review (supersede + charges
 * feed), and every other account alert should stay in the Inbox untouched.
 * The auto-drain skips these; review mode still lets the user decide. */
export function isBankNotificationSender(fromAddress: string): boolean {
  const domain = fromAddress.split("@")[1] ?? "";
  return TRANSACTION_NOTIFICATION_SENDERS.some(
    (seed) => domain === seed.domain || domain.endsWith(`.${seed.domain}`),
  );
}

type ReceiptEmailVerdict = "receipt" | "not-receipt" | "uncertain";

export interface ReceiptEmailClassification {
  verdict: ReceiptEmailVerdict;
  reason: string;
}

/**
 * Precision-first classification for the auto-drain. A "receipt" verdict
 * must NEVER fire for non-receipt mail, even when the body mentions an
 * amount: bank alerts, payment-status notices, and newsletters with
 * prices have all been misimported this way. "uncertain" means the rules
 * can't tell — the auto-drain skips these and leaves the email in the
 * Inbox for review (the corpus shows they are newsletters and account
 * notices); an LLM fallback can be wired here later if recall suffers.
 */
export function classifyReceiptEmail(input: {
  fromAddress: string;
  subject: string;
  bodyText: string;
}): ReceiptEmailClassification {
  const subject = input.subject.trim();

  // Bank notification senders: charge alerts are handled by inbox review
  // (supersede + charges feed); every other account alert stays in the
  // Inbox untouched. Their subjects often mention amounts — not receipts.
  if (isBankNotificationSender(input.fromAddress)) {
    return { verdict: "not-receipt", reason: "bank notification sender" };
  }

  // Money-adjacent account status notices, never purchases: payment
  // received/processing, upcoming invoice, purchase approved, statement
  // credit, duplicate-charge warnings.
  if (
    /(payment (has been )?(received|processing)|payment is processing|upcoming[^.]{0,30}invoice|purchase (was )?approved|statement credit|(you were |was )?charged twice|fraud(ulent)? (charge|alert))/i.test(
      subject,
    )
  ) {
    return { verdict: "not-receipt", reason: "payment status notice" };
  }

  // Receipt-signal subjects: order/receipt/invoice confirmations.
  if (hasReceiptSubjectSignal(subject)) {
    return { verdict: "receipt", reason: "receipt-signal subject" };
  }

  // Anything else is uncertain even with an amount in the body: the
  // amount alone never promotes non-receipt mail into an expense.
  return { verdict: "uncertain", reason: "no receipt signal" };
}

export function isTransactionNotification(
  fromAddress: string,
  subject: string,
): boolean {
  const domain = fromAddress.split("@")[1] ?? "";
  const senderIndex = TRANSACTION_NOTIFICATION_SENDERS.findIndex(
    (seed) => domain === seed.domain || domain.endsWith(`.${seed.domain}`),
  );
  return (
    senderIndex >= 0 &&
    TRANSACTION_NOTIFICATION_SUBJECT_RES[senderIndex]!.test(subject.trim())
  );
}

/**
 * The charge amount off a notification's "Amount: $9.99" line, normalized
 * to a plain decimal. The international variant quotes the foreign amount
 * too ("Transaction amount: 1,500 JPY"), but only the $-marked card-
 * currency line is the charge as it lands on the statement, and only that
 * can match the merchant receipt's amount. Null when no such line exists;
 * the caller then treats the notification as uncoverable (it stays on
 * the review list).
 */
export function notificationChargeAmount(bodyText: string): string | null {
  const match = bodyText.match(
    /amount[^:\n]*:\s*\$([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i,
  );
  return match ? match[1]!.replace(/,/g, "") : null;
}

export interface EmailClassifyInput {
  subject: string;
  /** Plain text of the body (empty for attachment-only emails). */
  bodyText: string;
}

/**
 * Does the SUBJECT alone signal a receipt/invoice/order confirmation?
 * The auto-drain requires this on top of looksLikeReceiptEmail: a money
 * amount in the body rescued bank alerts and newsletters with prices into
 * junk expenses. Review mode doesn't use it (the user's explicit choice
 * is the gate).
 */
function hasReceiptSubjectSignal(subject: string): boolean {
  return RECEIPT_SUBJECT_RE.test(subject.trim());
}

/**
 * Does this email look like a receipt/invoice/order confirmation?
 * Subject signals dominate; a money amount in the body rescues emails
 * with bland subjects; shipping notices are excluded unless they carry
 * a total; pure marketing is rejected.
 */
export function looksLikeReceiptEmail(input: EmailClassifyInput): boolean {
  const subject = input.subject;
  const body = input.bodyText;

  // A parseable total anywhere in the body is the strongest signal.
  if (TOTAL_BODY_RE.test(body)) return true;

  // Shipping/tracking notices are order mail but not receipts, unless
  // the body shows money (checked above).
  if (SHIPMENT_SUBJECT_RE.test(subject)) return false;

  if (RECEIPT_SUBJECT_RE.test(subject)) return true;

  // Marketing subject + marketing body and no money anywhere: junk.
  if (MARKETING_SUBJECT_RE.test(subject) || MARKETING_BODY_RE.test(body)) {
    return false;
  }

  return false;
}
