import rulesCsv from "~/data/email-rules.csv?raw";
import { parseCsv } from "~/lib/csv";
import { normalizeRuleSender } from "~/lib/validation";

/**
 * Seed for GENERAL email rules: senders whose emails are auto-imported by
 * every connected account. The list lives in `app/data/email-rules.csv` (a
 * `sender,note` header and one rule per row) so it can be edited without
 * touching code; `syncGeneralEmailRules` (`~/lib/db/seed.ts`) diffs it into
 * the `email_rules` table (accountId = "") on boot, so edit the file and
 * restart.
 *
 * A sender is either a domain ("apple.com", which matches the domain and any
 * subdomain, so it covers no_reply@email.apple.com) or a full address
 * ("receipts@stripe.com", matched exactly). Case does not matter (the parser
 * lowercases, the way the rule store does); a note containing a comma goes in
 * double quotes. The `note` column is documentation for whoever edits this
 * list next: nothing reads it.
 *
 * Be conservative. A false positive means a marketing email gets classified
 * (and only trashed when it really parses as a receipt), while a false
 * negative just means manual entry, same as today. Marketing-heavy senders
 * stay OFF this list. Recurring billers (Shopify, Conservice, Spectrum,
 * Verizon Wireless) are on it because an invoice or statement carries an
 * Amount-due line, which is what rescues the bland "bill" subject at the local
 * gate; the same senders' marketing mail carries no money and is rejected.
 *
 * A malformed row throws at boot, rather than seeding a rule that can never
 * match.
 */

interface GeneralEmailRuleSeed {
  sender: string;
  note: string;
}

const CSV_PATH = "app/data/email-rules.csv";

/** Parse the seed CSV into rules: the header, then one `sender,note` per row. */
export function parseEmailRuleCsv(csv: string): GeneralEmailRuleSeed[] {
  const [header, ...rows] = parseCsv(csv);
  if (
    header?.length !== 2 ||
    header[0]?.trim().toLowerCase() !== "sender" ||
    header[1]?.trim().toLowerCase() !== "note"
  ) {
    throw new Error(`${CSV_PATH}: expected the header row "sender,note"`);
  }
  const rules: GeneralEmailRuleSeed[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.length !== 2) {
      throw new Error(
        `${CSV_PATH}: "${row.join(",")}" is not a sender,note row`,
      );
    }
    const sender = normalizeRuleSender(row[0]!);
    if (sender === null) {
      throw new Error(`${CSV_PATH}: "${row[0]}" is not an address or domain`);
    }
    if (seen.has(sender)) {
      throw new Error(`${CSV_PATH}: duplicate sender "${sender}"`);
    }
    seen.add(sender);
    rules.push({ sender, note: row[1]!.trim() });
  }
  if (rules.length === 0) throw new Error(`${CSV_PATH}: no rules`);
  return rules;
}

export const GENERAL_EMAIL_RULES: GeneralEmailRuleSeed[] =
  parseEmailRuleCsv(rulesCsv);
