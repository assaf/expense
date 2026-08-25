/**
 * Infer GENERAL email rules from a connected inbox (phase 4 of the
 * connected-email-accounts feature, documented in docs/email-connections.md).
 *
 *   pnpm tsx scripts/infer-email-rules --connection <connectionId>          # dry run
 *   pnpm tsx scripts/infer-email-rules --connection <connectionId> --apply  # add as general rules
 *
 * Scans the connected account's Inbox (read-only: last 90 days, up to 500
 * emails, subject + preview only) and scores senders by receipt-likeness
 * with the local classifier. Candidates: a non-freemail domain with ≥2
 * receipt-like emails and ≥50% ratio. `--apply` adds them as general rules
 * (accountId = "", source = "inferred"); idempotent, and never touches
 * user rules or the seed. General rules affect EVERY workspace, so review
 * the table before applying.
 */

import { inferRuleCandidates } from "../app/lib/email-connection-infer.server";
import { readEmailConnectionById } from "../app/lib/db/email-connections";
import { addEmailRule, listGeneralEmailRules } from "../app/lib/db/email-rules";
import { decryptSecret } from "../app/lib/token-crypto.server";
import prisma from "../app/lib/prisma.server";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const connectionId = arg("connection");
  const apply = process.argv.includes("--apply");
  if (!connectionId) {
    console.error(
      "Usage: pnpm tsx scripts/infer-email-rules --connection <connectionId> [--apply]",
    );
    process.exit(1);
  }

  const connection = await readEmailConnectionById(connectionId);
  if (!connection) {
    console.error(`No email connection with id ${connectionId}`);
    process.exit(1);
  }
  const token = decryptSecret(connection.tokenEnc);

  console.info(`Scanning ${connection.emailAddress}'s Inbox (last 90 days)…`);
  const { scanned, candidates } = await inferRuleCandidates(
    token,
    connection.emailAddress,
  );
  const existing = new Set(
    (await listGeneralEmailRules()).map((r) => r.sender),
  );

  console.info(`Scanned ${scanned} emails. Candidates:`);
  if (candidates.length === 0) {
    console.info("  (none)");
  }
  for (const c of candidates) {
    const status = existing.has(c.sender) ? "already a rule" : "new";
    console.info(
      `  ${c.sender.padEnd(28)} ${String(c.receiptLike).padStart(3)}/${String(c.total).padStart(3)} receipt-like (${Math.round(c.ratio * 100)}%)  ${status}`,
    );
  }

  if (!apply) {
    console.info(
      "\nDry run — re-run with --apply to add the new candidates as general rules.",
    );
    return;
  }
  let added = 0;
  for (const c of candidates) {
    if (existing.has(c.sender)) continue;
    const result = await addEmailRule({
      accountId: "",
      sender: c.sender,
      source: "inferred",
    });
    if (result.ok) {
      added++;
      console.info(`  + general rule: ${c.sender}`);
    } else {
      console.error(`  ! ${c.sender}: ${result.error}`);
    }
  }
  console.info(`\nAdded ${added} general rule(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
