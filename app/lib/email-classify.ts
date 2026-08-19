/**
 * Local (no-LLM) classification for connected-account email: does this
 * email look like a receipt/order confirmation worth processing?
 *
 * This gate runs on EVERY rule-matched email in the webhook/cron drain —
 * it must stay cheap (regex over subject + plain-text body) so marketing
 * mail is filtered without a model call. The LLM extraction only runs
 * after this says yes; the model's isReceipt verdict remains the backstop
 * for junk that slips through.
 *
 * False negatives are possible (a receipt with neither a receipt-y subject
 * nor a parseable total is skipped) — accepted deliberately: rule-matched
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

export interface EmailClassifyInput {
  subject: string;
  /** Plain text of the body (empty for attachment-only emails). */
  bodyText: string;
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

  // Shipping/tracking notices are order mail but not receipts — unless
  // the body shows money (checked above).
  if (SHIPMENT_SUBJECT_RE.test(subject)) return false;

  if (RECEIPT_SUBJECT_RE.test(subject)) return true;

  // Marketing subject + marketing body and no money anywhere: junk.
  if (MARKETING_SUBJECT_RE.test(subject) || MARKETING_BODY_RE.test(body)) {
    return false;
  }

  return false;
}
