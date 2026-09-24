/**
 * DEV ONLY. Runs the receipts-by-email pipeline for ONE email (or one local
 * receipt file) and shows the confirmation it would send — without touching
 * the mailbox and without sending anything unless `--send` is passed.
 *
 *   pnpm preview:confirmation --latest                # newest unprocessed forward
 *   pnpm preview:confirmation --email <jmapId>        # one specific message
 *   pnpm preview:confirmation --file ~/receipt.pdf    # a local receipt file
 *   pnpm preview:confirmation --body ~/receipt.txt    # a local text receipt
 *   pnpm preview:confirmation --html ~/receipt.html   # a local HTML receipt
 *   pnpm preview:confirmation --latest --send         # submit it for real
 *
 * Everything is real: extraction (LLM/OCR), the receipt render, the stored
 * image, the expense row, and the confirmation builder. The package script
 * loads scripts/lib/vite-assets.mjs, which is what lets tsx resolve the
 * renderer's bundled font — without it the receipt image would be a stub.
 * The mailbox side is read-only: no `$receipt-processed` mark, no Trash, no
 * delete. The dev DB's `inbound_emails` claim for the email is cleared
 * first, so re-running the same message works.
 *
 * Output, in `--out` (default /tmp):
 *   confirmation-<expenseId>.eml   open in a mail client: the inline receipt
 *                                  renders there exactly as it will arrive
 *   confirmation-<expenseId>.html  open in a browser: `cid:` images are
 *                                  inlined as data: URLs
 * and the MIME parts are printed, so "is the receipt inline?" needs no
 * mail client at all.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import PostalMime from "postal-mime";
import { buildRfc822Message } from "../app/lib/email-mime.server";
import { INBOUND_EMAIL_ADDRESS } from "../app/lib/env";
import {
  destroyEmail,
  markReceiptProcessed,
  markReceiptRetry,
  rawEmail,
  unprocessedReceiptIds,
} from "../app/lib/fastmail.server";
import { mimeForFile } from "../app/lib/images.server";
import {
  fastmailInboundDeps,
  receiptEmailData,
  type FastmailAdapter,
} from "../app/lib/inbound-fastmail.server";
import {
  processInboundEvent,
  type AttachmentMeta,
  type EmailReceivedData,
  type InboundDeps,
} from "../app/lib/inbound-email.server";
import { db } from "../app/lib/prisma.server";
import { sendEmail } from "../app/lib/reply.server";
import type { SendEmailInput } from "../app/lib/email-mime.server";
import { arg } from "./lib/args";

const realAdapter: FastmailAdapter = {
  rawEmail,
  unprocessedReceiptIds,
  markProcessed: markReceiptProcessed,
  markRetry: markReceiptRetry,
  destroyEmail,
};

/** The pipeline's fetch collaborators for a local input. */
type LocalFetchDeps = Pick<
  InboundDeps,
  "fetchReceivedEmail" | "listAttachments" | "downloadAttachment"
>;
/** A local input as the email a forward would have produced: a receipt that
 * ARRIVES as a file (`file`), one whose content IS the body as plain text
 * (`body`), or one whose body is HTML (`html`).
 *
 * The HTML mode matters: a forwarded receipt email renders from its HTML
 * part with headless Chromium, so the saved image looks like the email did.
 * Feed that same email as text and you preview the plain-text fallback
 * instead: legible, but a wall of the email's own spacing, not the receipt
 * the reader saw. */
function localInput(opts: {
  from: string;
  file?: string;
  body?: string;
  html?: string;
}): { data: EmailReceivedData; deps: LocalFetchDeps } {
  const id = `local-${Date.now()}`;
  const name = basename(opts.file ?? opts.body ?? opts.html ?? "receipt");
  const bodyText = opts.body ? readFileSync(opts.body, "utf8") : null;
  const bodyHtml = opts.html ? readFileSync(opts.html, "utf8") : null;
  const data: EmailReceivedData = {
    email_id: id,
    created_at: new Date().toISOString(),
    from: opts.from,
    to: [INBOUND_EMAIL_ADDRESS],
    bcc: [],
    cc: [],
    received_for: [],
    message_id: `<${id}@localhost>`,
    subject: `Fwd: ${name}`,
    headers: {},
    attachments: [],
  };
  const meta: AttachmentMeta = {
    id: "local-1",
    filename: name,
    size: opts.file ? statSync(opts.file).size : 0,
    content_type: mimeForFile(name, "application/octet-stream"),
    content_disposition: "attachment",
    content_id: null,
    download_url: null,
    expires_at: null,
  };
  return {
    data,
    deps: {
      fetchReceivedEmail: async () => ({
        id: data.email_id,
        from: data.from,
        to: data.to,
        subject: data.subject,
        html: bodyHtml,
        text: bodyText,
        headers: {},
        created_at: data.created_at,
        message_id: data.message_id,
      }),
      listAttachments: async () => (opts.file ? [meta] : []),
      downloadAttachment: async () => readFileSync(opts.file!),
    },
  };
}
/** The confirmation HTML with every `cid:` reference replaced by the part's
 * bytes, so a browser shows the receipt where the mail client will. */
function withInlineImages(
  html: string,
  attachments: SendEmailInput["attachments"],
): string {
  let out = html;
  for (const att of attachments ?? []) {
    if (!att.contentId) continue;
    const type = att.contentType ?? "application/octet-stream";
    out = out.replaceAll(
      `cid:${att.contentId}`,
      `data:${type};base64,${att.content}`,
    );
  }
  return out;
}

/** A Content-ID without the RFC 2392 angle brackets a parser keeps. */
function bareCid(id: string | null | undefined): string {
  return (id ?? "").replace(/^</, "").replace(/>$/, "");
}

/** One line per MIME part of the built message: what a client receives. */
async function describeParts(raw: Buffer): Promise<void> {
  const parsed = await PostalMime.parse(raw);
  const inline: string[] = [];
  const files: string[] = [];
  for (const att of parsed.attachments) {
    const line = `${att.mimeType} ${att.filename ?? "(unnamed)"}`;
    // postal-mime keeps the header's angle brackets; the HTML's cid: URL
    // never has them, so compare (and show) the bare value.
    if (att.contentId) inline.push(`${line} cid=${bareCid(att.contentId)}`);
    else files.push(line);
  }
  console.info("\nParts a client sees:");
  console.info(`  text/plain   ${(parsed.text ?? "").length} bytes`);
  console.info(`  text/html    ${(parsed.html ?? "").length} bytes`);
  for (const part of inline) console.info(`  INLINE       ${part}`);
  for (const part of files) console.info(`  attachment   ${part}`);
  const referenced = [...(parsed.html ?? "").matchAll(/cid:([^"'>\s]+)/g)];
  console.info(
    referenced.length > 0
      ? `  HTML references: ${referenced.map((m) => m[1]).join(", ")}`
      : "  HTML references no cid: image",
  );
  // A cid the HTML never points at renders nowhere; a reference with no part
  // is a broken image. Both are the failure this preview exists to catch.
  const ids = new Set(parsed.attachments.map((a) => bareCid(a.contentId)));
  const missing = referenced.map((m) => m[1]!).filter((id) => !ids.has(id));
  console.info(
    missing.length === 0
      ? "  inline wiring: OK"
      : `  inline wiring: BROKEN (no part for ${missing.join(", ")})`,
  );
}

/** Which database the run will write to (the expense and the claim clear).
 * Printed before anything writes, so the target is never a surprise. */
function databaseLabel(): string {
  const url = process.env.DATABASE_URL ?? "";
  if (url === "") return "(unset)";
  return url.slice(url.lastIndexOf("@") + 1);
}

async function main(): Promise<void> {
  const emailId = arg("email");
  const latest = process.argv.includes("--latest");
  const file = arg("file");
  const body = arg("body");
  const html = arg("html");
  const send = process.argv.includes("--send");
  const out = arg("out") ?? "/tmp";
  if (!emailId && !latest && !file && !body && !html) {
    console.error(
      "usage: pnpm preview:confirmation (--latest | --email <jmapId> | --file <path> | --body <path> | --html <path>) [--from <address>] [--send] [--out /tmp]",
    );
    process.exit(1);
  }

  let data: EmailReceivedData;
  let deps: InboundDeps;
  if (file || body || html) {
    const from = arg("from");
    if (!from) {
      console.error(
        "--file, --body and --html need --from <a verified sender address, e.g. you@example.com>",
      );
      process.exit(1);
    }
    const local = localInput({ from, file, body, html });
    data = local.data;
    deps = { ...fastmailInboundDeps(realAdapter), ...local.deps };
  } else {
    let id = emailId;
    if (!id) {
      const ids = await realAdapter.unprocessedReceiptIds(20);
      if (ids.length === 0) {
        console.error("no unprocessed email in the Receipts folder");
        process.exit(1);
      }
      // The adapter lists oldest first; --latest takes the newest.
      id = ids[ids.length - 1]!;
      console.info(`${ids.length} unprocessed email(s); using ${id}`);
    }
    data = await receiptEmailData(id, realAdapter);
    deps = fastmailInboundDeps(realAdapter);
  }

  // Re-runs must work: the pipeline's claim row would otherwise report the
  // email as already processed. Dev DB only, and only for this email.
  await db.orm.public.InboundEmail.where((e) =>
    e.emailId.eq(data.email_id),
  ).deleteAll();

  // Capture the reply instead of sending it; --send submits the same input
  // through the real Fastmail path afterwards.
  let reply: SendEmailInput | undefined;
  const captured = {
    ...deps,
    sendReply: async (input: SendEmailInput) => {
      reply = input;
    },
  };

  console.info(`\nDatabase: ${databaseLabel()}`);
  console.info(`Processing "${data.subject}" from ${data.from}…`);
  const result = await processInboundEvent(data, captured);
  console.info(`Status: ${result.status}`);

  if (!reply) {
    const accepted = result.status === "created" || result.status === "partial";
    console.info(
      accepted
        ? "No reply was produced:\n" +
            "  The same receipt was already imported in the last 30 minutes, so\n" +
            "  the confirmation was suppressed (the duplicate guard). Use a\n" +
            "  different receipt, or wait out the window."
        : "No confirmation was sent for this outcome (see the status above).",
    );
    await db.close();
    // The renderer's browser keeps the event loop alive; a CLI exits here.
    process.exit(0);
  }

  const raw = buildRfc822Message({
    fromName: "Expense",
    fromEmail: INBOUND_EMAIL_ADDRESS || "receipts@localhost",
    to: reply.to,
    subject: reply.subject,
    html: reply.html,
    text: reply.text,
    inReplyTo: reply.inReplyTo,
    attachments: reply.attachments,
  });
  const stamp = "expenseId" in result ? result.expenseId : data.email_id;
  const emlPath = join(out, `confirmation-${stamp}.eml`);
  const htmlPath = join(out, `confirmation-${stamp}.html`);
  writeFileSync(emlPath, raw);
  writeFileSync(htmlPath, withInlineImages(reply.html, reply.attachments));

  console.info(`\nSubject: ${reply.subject}`);
  console.info(`To:      ${reply.to}`);
  await describeParts(raw);
  console.info(`\nWrote ${emlPath}`);
  console.info(`Wrote ${htmlPath}`);
  if ("expenseId" in result) {
    // The dev server, not PUBLIC_URL: the expense was written to the dev DB
    // (the email's own edit link still uses PUBLIC_URL, as in production).
    console.info(
      `Expense: http://expense.localhost/expense/${result.expenseId}`,
    );
  }

  if (send) {
    console.info("\nSending the confirmation through Fastmail…");
    const ok = await sendEmail(reply);
    console.info(
      ok ? "Sent: check your inbox for the receipt inline." : "Send failed.",
    );
  } else {
    console.info(
      "\nNot sent. Open the .eml in a mail client, or re-run with --send.",
    );
  }

  await db.close();
  // The renderer's headless browser keeps the event loop alive, so exiting
  // here is what makes this a one-shot command rather than a hang.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
