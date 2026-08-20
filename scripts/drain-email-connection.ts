/**
 * DEV ONLY — drain a connected mailbox into expenses (local extraction, no
 * LLM). Defaults to the Inbox; pass --role trash to process mail already in
 * the Trash folder (e.g. to replay receipts moved there for testing).
 *
 *   pnpm drain:email --connection <id>                         # Inbox, 90d, batch 10
 *   pnpm drain:email --connection <id> --role trash --limit 2 # two trashed emails
 *
 * Side effects per processed receipt: creates an expense (partial — category
 * unknown until you set it once), re-applies Trash (a no-op if already
 * trashed), and sends a confirmation email to the mailbox owner. Run this
 * against the dev DB; the dev server (localhost:4565) reads the same DB.
 */
import {
  mailboxSummaries,
  rawConnectionEmail,
  moveConnectionEmailToTrash,
} from "../app/lib/email-connection-mail.server";
import {
  drainEmailConnection,
  type ConnectionMailAdapter,
  type ConnectionDeps,
} from "../app/lib/email-connection-process.server";
import { extractReceipt } from "../app/lib/receipt-ai.server";
import { readEmailConnectionById } from "../app/lib/db/email-connections";
import { decryptSecret } from "../app/lib/token-crypto.server";
import prisma from "../app/lib/prisma.server";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const connectionId = arg("connection");
  const role = arg("role") ?? "inbox";
  const limit = Number(arg("limit") ?? 10);
  const days = Number(arg("days") ?? 90);
  if (!connectionId) {
    console.error(
      "usage: pnpm drain:email --connection <id> [--role trash] [--limit 2] [--days 90]",
    );
    process.exit(1);
  }

  const connection = await readEmailConnectionById(connectionId);
  if (!connection) {
    console.error(`No email connection with id ${connectionId}`);
    process.exit(1);
  }
  const token = decryptSecret(connection.tokenEnc);

  // Stub the renderers (a 1x1 PNG) — the real ones use Vite's ?inline font
  // asset, which tsx can't resolve. Extraction, trash, and the confirmation
  // email stay real; only the saved receipt image is a stub.
  const TINY_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const stubDeps: ConnectionDeps = {
    classifyAttachment: async () => null,
    extractReceipt,
    extractFromImage: async () => {
      throw new Error(
        "extractFromImage called — local-only should skip attachments",
      );
    },
    renderReceiptImage: async () => TINY_PNG,
    renderEmailImage: async () => TINY_PNG,
    renderTextEmail: async () => TINY_PNG,
  };

  const adapter: ConnectionMailAdapter = {
    inboxEmailSummaries: (opts) => mailboxSummaries({ token, role, ...opts }),
    rawEmail: (id) => rawConnectionEmail(token, id),
    moveToTrash: (id) => moveConnectionEmailToTrash(token, id),
  };

  console.info(
    `Draining ${connection.emailAddress} (${role}, last ${days}d, batch ${limit})…`,
  );
  const result = await drainEmailConnection(connection, {
    adapter,
    extractionDeps: stubDeps,
    lookbackMs: days * 24 * 60 * 60 * 1000,
    batchSize: limit,
    timeBudgetMs: 120_000,
  });
  console.info(
    `Done: ${result.evaluated} evaluated, ${result.created} created, ${result.partial} partial, ${result.ignored} ignored, ${result.failed} failed.`,
  );

  // Show the freshly-created expenses so the result is visible.
  const expenses = await prisma.expense.findMany({
    where: { accountId: connection.accountId },
    orderBy: { createdAt: "desc" },
    take: result.created + result.partial,
    select: {
      id: true,
      merchant: true,
      amount: true,
      category: true,
      createdAt: true,
    },
  });
  if (expenses.length > 0) {
    console.info("\nRecent expenses:");
    for (const e of expenses) {
      console.info(
        `  ${e.merchant || "(unknown)"}  $${e.amount?.toString() ?? "?"}  [${e.category || "no category"}]  ${e.id}`,
      );
    }
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
