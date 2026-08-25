import { jmapCall, jmapSessionForToken } from "~/lib/jmap.server";
import { looksLikeReceiptEmail } from "~/lib/email-classify";

/**
 * Infer candidate GENERAL email rules from a connected inbox: senders whose
 * mail consistently looks like receipts. Read-only: it never mutates the
 * mailbox; the script (scripts/infer-email-rules.ts) decides what to apply.
 *
 * NOT wired into any cron or webhook on purpose: general rules apply to
 * every user, so an operator reviews the candidates and applies them
 * deliberately (`--apply`). Everything here must stay offline-cheap:
 * subject + preview regex only, no LLM, no full-body fetches.
 */

/** Mail domains that must never become rules (personal mail providers;
 * rules on them would import half the internet's forwarded mail). Exported
 * for the review flow's sender-acceptance (same policy: a rule is the
 * domain, or the exact address for freemail senders). */
export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "me.com",
  "live.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "yandex.com",
]);

/** A domain whose mail looks receipt-like. */
interface RuleCandidate {
  sender: string;
  total: number;
  receiptLike: number;
  ratio: number;
}

export interface InferOptions {
  /** Lookback window (default 90 days). */
  lookbackMs?: number;
  /** Max emails scanned (default 500). */
  maxEmails?: number;
  /** Min receipt-like emails for a candidate (default 2). */
  minReceiptLike?: number;
  /** Min receipt-like ratio for a candidate (default 0.5). */
  minRatio?: number;
}

export interface InferResult {
  scanned: number;
  candidates: RuleCandidate[];
}

interface EmailEntry {
  from?: Array<{ name?: string; email?: string }>;
  subject?: string;
  preview?: string;
}

async function inboxMailboxId(token: string): Promise<string> {
  const responses = await jmapCall(token, [
    [
      "Mailbox/get",
      {
        accountId: (await jmapSessionForToken(token)).mailAccountId,
        ids: null,
        properties: ["id", "role"],
      },
      "m0",
    ],
  ]);
  const list =
    (responses[0]![1] as { list?: Array<{ id: string; role?: string }> })
      .list ?? [];
  const inbox = list.find((b) => b.role === "inbox");
  if (!inbox) throw new Error('No mailbox with role "inbox"');
  return inbox.id;
}

function domainOf(address: string): string | null {
  const domain = address.split("@")[1]?.toLowerCase();
  return domain && domain.includes(".") ? domain : null;
}

/**
 * Scan the Inbox's recent mail and score senders by receipt-likeness.
 * Uses Email/query (Inbox, after the lookback) + Email/get with `preview`
 * (the first ~50 words of the body), enough signal for the local
 * classifier without downloading full messages.
 */
export async function inferRuleCandidates(
  token: string,
  connectionAddress: string,
  options: InferOptions = {},
): Promise<InferResult> {
  const lookbackMs = options.lookbackMs ?? 90 * 24 * 60 * 60 * 1000;
  const maxEmails = options.maxEmails ?? 500;
  const minReceiptLike = options.minReceiptLike ?? 2;
  const minRatio = options.minRatio ?? 0.5;
  const selfDomains = new Set(
    [domainOf(connectionAddress)].filter((d): d is string => d !== null),
  );

  const afterIso = new Date(Date.now() - lookbackMs).toISOString();
  const accountId = (await jmapSessionForToken(token)).mailAccountId;
  const query = await jmapCall(token, [
    [
      "Email/query",
      {
        accountId,
        filter: { inMailbox: await inboxMailboxId(token), after: afterIso },
        sort: [{ property: "receivedAt", isAscending: false }],
        limit: maxEmails,
      },
      "m0",
    ],
  ]);
  const ids = (query[0]![1] as { ids?: string[] }).ids ?? [];
  if (ids.length === 0) return { scanned: 0, candidates: [] };

  const got = await jmapCall(token, [
    [
      "Email/get",
      { accountId, ids, properties: ["from", "subject", "preview"] },
      "m0",
    ],
  ]);
  const list = (got[0]![1] as { list?: EmailEntry[] }).list ?? [];

  const stats = new Map<string, { total: number; receiptLike: number }>();
  for (const email of list) {
    const address = email.from?.[0]?.email?.toLowerCase() ?? "";
    const domain = domainOf(address);
    if (!domain) continue;
    if (FREE_MAIL_DOMAINS.has(domain) || selfDomains.has(domain)) continue;
    const entry = stats.get(domain) ?? { total: 0, receiptLike: 0 };
    entry.total++;
    if (
      looksLikeReceiptEmail({
        subject: email.subject ?? "",
        bodyText: email.preview ?? "",
      })
    ) {
      entry.receiptLike++;
    }
    stats.set(domain, entry);
  }

  const candidates: RuleCandidate[] = [];
  for (const [sender, { total, receiptLike }] of stats) {
    const ratio = receiptLike / total;
    if (receiptLike >= minReceiptLike && ratio >= minRatio) {
      candidates.push({ sender, total, receiptLike, ratio });
    }
  }
  candidates.sort((a, b) => b.receiptLike - a.receiptLike || b.total - a.total);
  return { scanned: list.length, candidates };
}
