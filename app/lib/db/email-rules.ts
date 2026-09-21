import { ulid } from "ulid";
import { and, or } from "@prisma/orm-postgres/orm-client";
import { db } from "~/lib/prisma.server";
import { isUniqueViolation } from "~/lib/db/pg-errors";
import { nowWire } from "~/lib/db/wire";
import { extractEmailAddress, normalizeRuleSender } from "~/lib/validation";
import type { AcceptedSenderRow } from "~/lib/types";

/**
 * Email rules: which senders a connected account auto-imports. General
 * rules (accountId = "", seeded from app/data/email-rules.csv) apply to
 * everyone; user rules are scoped to a workspace and learned from forwards.
 *
 * A rule's `sender` is either a full address ("receipts@stripe.com", exact
 * match) or a bare domain ("apple.com", which matches the domain and any
 * subdomain). `normalizeRuleSender` owns that shape, so the store and the
 * seed parser can't disagree about what counts.
 *
 * A workspace can turn a sender off. Its own rule is deleted; a general rule
 * of the same pattern is left alone (it serves every other workspace) and
 * vetoed by an email_rule_removals row instead, so the boot seed re-adding
 * the row cannot undo the choice.
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
  // General rules first, then the workspace's own, so a user rule can't be
  // shadowed, but the order only matters for reporting anyway. A pattern the
  // workspace turned off never matches, whichever scope carries the rule.
  const removed = new Set(await listRemovedSenders(accountId));
  const rules = await db.orm.public.EmailRule.where((r) =>
    or(r.accountId.eq(""), r.accountId.eq(accountId)),
  ).all();
  return rules.find(
    (r) => !removed.has(r.sender) && ruleSenderMatches(r.sender, fromAddress),
  );
}

/** The sender patterns this workspace turned off, ascending. */
export async function listRemovedSenders(accountId: string): Promise<string[]> {
  const rows = await db.orm.public.EmailRuleRemoval.where((r) =>
    r.accountId.eq(accountId),
  )
    .orderBy((r) => r.sender.asc())
    .all();
  return rows.map((r) => r.sender);
}

/** The general rules (accountId = ""): the seed + anything inferred. */
export async function listGeneralEmailRules(): Promise<EmailRuleRecord[]> {
  const rows = await db.orm.public.EmailRule.where((r) => r.accountId.eq(""))
    .orderBy((r) => r.sender.asc())
    .all();
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
  const sender = normalizeRuleSender(input.sender);
  if (sender === null) {
    return {
      ok: false,
      error: `"${input.sender.trim().toLowerCase()}" is not an address or domain.`,
    };
  }
  const existing = await db.orm.public.EmailRule.where((r) =>
    and(r.accountId.eq(input.accountId), r.sender.eq(sender)),
  ).first();
  let source = existing?.source ?? input.source;
  if (!existing) {
    try {
      await db.orm.public.EmailRule.create({
        id: ulid(),
        accountId: input.accountId,
        sender,
        source: input.source,
        createdAt: nowWire(),
      });
    } catch (err) {
      // Two writers for one (account, sender) are routine: the review accept
      // and the drain learning the same sender from a forward can land
      // together, and a multi-instance cron runs the drain twice. The unique
      // index is the gate, and the row that won is the rule both callers
      // asked for, so read it back rather than failing the user's click.
      if (!isUniqueViolation(err)) throw err;
      const row = await db.orm.public.EmailRule.where((r) =>
        and(r.accountId.eq(input.accountId), r.sender.eq(sender)),
      ).first();
      source = row?.source ?? input.source;
    }
  }
  // Remembering a sender the workspace had turned off has to lift the veto,
  // or the rule is written and stays dead. It happens only once the rule is
  // really there: deleting the veto first meant a failed write (a timeout, a
  // dropped connection) switched a sender the user had turned off back on
  // while the action reported failure and left nothing to show for it.
  await db.orm.public.EmailRuleRemoval.where((r) =>
    and(r.accountId.eq(input.accountId), r.sender.eq(sender)),
  ).deleteAll();
  return {
    ok: true,
    rule: { accountId: input.accountId, sender, source },
  };
}

/** Turn a sender off for one workspace: delete its own rule for that exact
 * pattern, and veto the general rule of the same pattern (the shared row
 * cannot be deleted for everyone). Only the exact pattern is affected, so
 * turning off "apple.com" leaves a learned "email.apple.com" rule matching
 * its own mail. */
export async function removeEmailRule(input: {
  accountId: string;
  sender: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const sender = normalizeRuleSender(input.sender);
  if (sender === null) {
    return {
      ok: false,
      error: `"${input.sender.trim().toLowerCase()}" is not an address or domain.`,
    };
  }
  await db.orm.public.EmailRule.where((r) =>
    and(r.accountId.eq(input.accountId), r.sender.eq(sender)),
  ).deleteAll();
  const general = await db.orm.public.EmailRule.where((r) =>
    and(r.accountId.eq(""), r.sender.eq(sender)),
  ).first();
  if (!general) return { ok: true };
  const vetoed = await db.orm.public.EmailRuleRemoval.where((r) =>
    and(r.accountId.eq(input.accountId), r.sender.eq(sender)),
  ).first();
  if (vetoed) return { ok: true };
  try {
    await db.orm.public.EmailRuleRemoval.create({
      accountId: input.accountId,
      sender,
      createdAt: nowWire(),
    });
  } catch (err) {
    // The veto is keyed by (accountId, sender), so losing this insert means
    // the same veto is already there: the sender is off either way.
    if (!isUniqueViolation(err)) throw err;
  }
  return { ok: true };
}

/** Lift the veto on a pre-selected sender: the general rule applies again.
 * Nothing is re-learned, so a removed rule the workspace had learned itself
 * does not come back. */
export async function restoreEmailRule(input: {
  accountId: string;
  sender: string;
}): Promise<void> {
  const sender = normalizeRuleSender(input.sender);
  if (sender === null) return;
  await db.orm.public.EmailRuleRemoval.where((r) =>
    and(r.accountId.eq(input.accountId), r.sender.eq(sender)),
  ).deleteAll();
}

/** Every pattern on the workspace's accepted list: its own learned rules,
 * the pre-selected (general) rules, and the pre-selected ones it turned off.
 * One row per pattern, ascending; a pattern carried by both rule scopes is
 * one learned row. */
export async function listAcceptedSenders(
  accountId: string,
): Promise<AcceptedSenderRow[]> {
  const learned = await db.orm.public.EmailRule.where((r) =>
    r.accountId.eq(accountId),
  )
    .orderBy((r) => r.sender.asc())
    .all();
  const general = await db.orm.public.EmailRule.where((r) => r.accountId.eq(""))
    .orderBy((r) => r.sender.asc())
    .all();
  const removed = await db.orm.public.EmailRuleRemoval.where((r) =>
    r.accountId.eq(accountId),
  )
    .orderBy((r) => r.sender.asc())
    .all();
  const byPattern = new Map<string, AcceptedSenderRow>();
  const put = (row: AcceptedSenderRow) => {
    byPattern.set(row.sender, row);
  };
  for (const rule of learned) {
    put({ sender: rule.sender, origin: "learned", turnedOff: false });
  }
  for (const rule of general) {
    if (!byPattern.has(rule.sender)) {
      put({ sender: rule.sender, origin: "preset", turnedOff: false });
    }
  }
  for (const row of removed) {
    put({
      sender: row.sender,
      origin: byPattern.get(row.sender)?.origin ?? "preset",
      turnedOff: true,
    });
  }
  return [...byPattern.values()].sort((a, b) =>
    a.sender < b.sender ? -1 : a.sender > b.sender ? 1 : 0,
  );
}
