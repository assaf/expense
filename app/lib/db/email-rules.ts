import { ulid } from "ulid";
import prisma from "~/lib/prisma.server";
import { extractEmailAddress } from "~/lib/validation";

/**
 * Email rules — which senders a connected account auto-imports. General
 * rules (accountId = "", synced from app/data/email-rules.ts) apply to
 * everyone; user rules are scoped to a workspace and learned from forwards.
 *
 * A rule's `sender` is either a full address ("receipts@stripe.com" — exact
 * match) or a bare domain ("apple.com" — matches the domain and any
 * subdomain).
 */

export interface EmailRuleRecord {
  accountId: string;
  sender: string;
  source: string;
}

export type AddEmailRuleResult =
  | { ok: true; rule: EmailRuleRecord }
  | { ok: false; error: string };

/** Does this rule's sender pattern match a From address (already lowercased)? */
export function ruleSenderMatches(
  sender: string,
  fromAddress: string,
): boolean {
  if (sender.includes("@")) return sender === fromAddress;
  const domain = fromAddress.split("@")[1] ?? "";
  return domain === sender || domain.endsWith(`.${sender}`);
}

/** The rule that applies to an email From header, or undefined to ignore. */
export async function matchEmailRule(
  accountId: string,
  from: string,
): Promise<EmailRuleRecord | undefined> {
  const fromAddress = extractEmailAddress(from);
  if (!fromAddress.includes("@")) return undefined;
  // General rules first, then the workspace's own — a user rule can't be
  // shadowed, but the order only matters for reporting anyway.
  const rules = await prisma.emailRule.findMany({
    where: { OR: [{ accountId: "" }, { accountId }] },
  });
  return rules.find((r) => ruleSenderMatches(r.sender, fromAddress));
}

/** The general rules (accountId = "") — the seed + anything inferred. */
export async function listGeneralEmailRules(): Promise<EmailRuleRecord[]> {
  const rows = await prisma.emailRule.findMany({
    where: { accountId: "" },
    orderBy: { sender: "asc" },
  });
  return rows.map((r) => ({
    accountId: r.accountId,
    sender: r.sender,
    source: r.source,
  }));
}

/** Add (or return the existing) rule for a sender pattern. */
export async function addEmailRule(input: {
  accountId: string;
  sender: string;
  source: string;
}): Promise<AddEmailRuleResult> {
  const sender = input.sender.trim().toLowerCase();
  const valid = sender.includes("@")
    ? /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(sender)
    : /^[a-z0-9.-]+\.[a-z]{2,}$/.test(sender);
  if (!valid) {
    return { ok: false, error: `"${sender}" is not an address or domain.` };
  }
  const existing = await prisma.emailRule.findUnique({
    where: { accountId_sender: { accountId: input.accountId, sender } },
  });
  if (existing) {
    return {
      ok: true,
      rule: {
        accountId: existing.accountId,
        sender: existing.sender,
        source: existing.source,
      },
    };
  }
  await prisma.emailRule.create({
    data: {
      id: ulid(),
      accountId: input.accountId,
      sender,
      source: input.source,
      createdAt: new Date().toISOString(),
    },
  });
  return {
    ok: true,
    rule: { accountId: input.accountId, sender, source: input.source },
  };
}
