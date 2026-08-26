/**
 * Bank transaction-notification senders: which banks send "a transaction
 * was charged" alerts and the subject shape they use. Synced into the
 * notification matcher on import; add a bank here (one entry) to have
 * its charge alerts handled by inbox review, no code changes.
 *
 * The subject pattern is anchored at the start and matched
 * case-insensitively. Keep it to the wording the bank actually uses:
 * too loose a pattern could match a merchant receipt and wrongly gate it.
 */
export interface NotificationSenderSeed {
  /** Matches the domain and any subdomain (capitalone.com covers
   * alerts.capitalone.com). */
  domain: string;
  /** Subject regex source, no flags (the matcher anchors + /i's it). */
  subjectRe: string;
}

export const TRANSACTION_NOTIFICATION_SENDERS: NotificationSenderSeed[] = [
  {
    domain: "capitalone.com",
    subjectRe: "^a new (?:international )?transaction was charged",
  },
];
