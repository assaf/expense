# Receipts by email

inbound is Fastmail-only (the Resend webhook path was removed in Aug 2026; see the git history for `api.inbound-email.ts`). A Fastmail delivery rule files mail to a
dedicated address (e.g. `receipts@labnotes.org`) into a folder, never the
Inbox. Fastmail pushes an encrypted RFC 8291 `StateChange` to
`/api/inbound-push`; the handler drains the folder via
`processUnprocessedReceipts` (`app/lib/inbound-fastmail.server.ts`): mark
each email `$receipt-processed` **before** processing, run the existing
`processInboundEvent` through the Fastmail MIME bridge (`InboundDeps`
fetch/list/download collaborators backed by postal-mime; the JMAP email
id is the idempotency key), and **destroy the email after any non-error
result** (created / partial / duplicate / concurrent / unknown /
unverified sender / self-reply). The `inbound_emails` row is the
**atomic claim** (`claimInboundEmail`, createMany+skipDuplicates): the
keyword mark alone can't stop two concurrent drains (a push burst, or a
push racing the cron) from both listing the same email before either
marks it: the first drain to insert the "processing" row wins, and the
other returns `concurrent`/`duplicate` without importing or replying
(Aug 2026: duplicate confirmation emails from that race). A receipt
that also exists in the owner's connected inbox (the auto-import
pipeline) gets imported by both pipelines; the confirmation is then
suppressed on the second import via `findRecentlyImportedMatch`
(merchant+amount+date, plus description when present, within 30 min), so
the user gets one response per receipt (Sentry: "duplicate confirmation
suppressed"). Because
the originals are destroyed, the stored receipt IMAGE is the only remaining
source of a receipt's number; backfills read the refs off the expense
images (e.g. the z.ai description backfill, Aug 2026). Error
results stay in the folder, marked, and are skipped next run; the
pipeline's reply email is the recovery path. The daily cron
(`/api/inbound-cron`, `0 12 * * *`) renews the ~30-day push subscription
and drains anything a missed push left behind. Sender
verification: From must have a verified `inbound_senders` row (one row per
account+address, normalized lowercase);
failure/confirmation replies are sent FROM the FastMail identity
(`INBOUND_EMAIL_ADDRESS`, default the account's primary identity) via
`EmailSubmission/set` (upload raw MIME → `Email/import` into the
identity's Sent mailbox → submit; the submit step retries once on a
transient failure, reusing the same email id; the blob/Sent import
doesn't repeat) when `FASTMAIL_TOKEN` has send
permission; without it the send is skipped with a warning. The
confirmation reply carries the **original receipt**, not the stored
rendered image: a body-text receipt is quoted verbatim below the details
(both the HTML blockquote and the plain-text part, ">"-prefixed, capped
at 4000 chars); an image/PDF attachment source is attached as the
original file under its original filename with a byte-sniffed content
type (`replyAttachmentContentType`; the declared `application/octet-stream`
for screenshots is corrected from the bytes). The self-reply guard
compares the incoming
From against the outbound address, so forwarded replies can't loop.
**Bounces and autoresponders are dropped silently** (never imported,
never answered): a cheap pre-fetch check matches DSN subject lines
(`Undelivered Mail`, `Delivery Status Notification`, …) and daemon
senders (`mailer-daemon@`, `postmaster@`), and a post-fetch header check
matches null `Return-Path: <>`, `multipart/report` bodies, and
`Auto-Submitted: auto-*`. Without this, a failed outbound reply bounces
back from the mail server, the bounce looks like an unknown sender, gets
another reply, bounces again: an infinite Sent-folder loop (Aug 2026: a
run of this produced hundreds of "Receipt not imported" emails in Sent).

Foreign-currency receipts are converted to USD at the ECB reference rate
for the expense date (the IRS payment-date rule; `app/lib/fx.server.ts`
via Frankfurter, no key, weekends roll back to the prior business day).
The confirmation email states the original amount, the rate, and the USD
total; when no rate is available the amount is stored as-is and the email
says so instead. The expense's description also gains a "(Converted from
EUR 50.00 at 1.1699 USD/EUR, ECB rate for …)" note (`app/lib/fx-note.ts`),
so exports and report PDFs document the conversion; the note is
strip-and-append, never duplicated on re-imports or edits.

**Runaway protection (three layers, all still live):**

1. The bounce guard above is the durable stop: it drops DSNs and
   autoresponders before they reach the reply path.
2. A reply circuit breaker in `processUnprocessedReceipts` never replies
   to the same address twice in one drain; a repeated target means the
   guard was bypassed, so the duplicates are suppressed and a Sentry warning
   (`[inbound] duplicate reply suppressed — possible bounce loop`) fires.
3. The daily cron tick is wrapped in a Sentry cron monitor
   (`expense-inbound-cron`); a missed check-in alerts if the pipeline stops
   draining (bad deploy, broken auth, …).

Recurrence diagnosis: search Sent for `[inbound] duplicate reply` or the
cron monitor's missed check-in; in Fastmail, `from:me subject:"Receipt
not imported" counts the sent-loop fallout (delete the old ones; the
loop itself is dead).
**When pushes stop arriving, the subscription is unverified**: a
subscription created before the webhook was live (or with stale push
keys) never completed the PushVerification handshake, and verification
state is invisible via the API (`verificationCode`reads null either
way). Fix: destroy the subscription and recreate it (a tsx script
calling`destroySubscription`+`ensureSubscription`) so FastMail issues a
fresh PushVerification against the live webhook. `RECEIPTS_FOLDER`must
match the folder name EXACTLY (a`Receipt`vs`Receipts` mismatch makes
every drain throw and die silently). To test the push handler without
waiting for Fastmail: encrypt a StateChange with the app's own keys
(`p256dhFromPrivate(PUSH_PRIVATE_KEY)`+`http_ece`encrypt) and POST it
to`/api/inbound-push`; decryption is the auth, so this works.
Env: `FASTMAIL_TOKEN`,
`PUSH_PRIVATE_KEY`/`PUSH_AUTH`(from`pnpm setup:push`), `DEVICE_CLIENT_ID`(default`expense-receipts`), `RECEIPTS_FOLDER`(must match the rule's
folder),`INBOUND_EMAIL_ADDRESS`, `CRON_SECRET`, and `PUBLIC_URL`(the push URL is`<PUBLIC_URL>/api/inbound-push`; set it in prod or verification fails).

- **Verification + exclusivity**: adding an address (Email page → Receipts by
  email, or auto-added at signup/join/login) puts it in `inbound_senders` as
  **pending** and emails a verification link to it (single-use token hashed
  in `verificationTokenHash`, 7-day TTL, resent on demand or when stale
  > 24h). Only after the mailbox owner clicks the link does the address
  > accept receipts. Clicking writes the claim to
  > `inbound_sender_verifications` (address PK = the DB-level exclusivity
  > authority: one verified account per address) and **deletes every other
  > account's pending rows for that address**; a rival's stale link then
  > fails. Removing a sender deletes both rows and frees the address. The
  > user's login email is always ensured as a sender (`ensureInboundSenderForUser`
  > on signup/join/login, auto-emailing a verification link when owed); it
  > shows on the Email page as "Your sign-in email" and can't be removed. The
  > pipeline replies "verify first" (status `unverified-sender`) when the
  > From address has a row but no verification.
- The expense date is the **original forwarded email's date** (quoted
  "Begin forwarded message" Date → .eml attachment Date → received header).
- Only the best receipt attachment (PDF/image, heuristic + model tiebreak)
  is used; logos/signatures/inline decoration are skipped; otherwise the
  email body becomes the receipt image: with an HTML part it is rendered
  to a PNG with headless Chromium (`email-render.server.ts`; inline `cid:`
  images are downloaded and rewritten to data URIs; network is blocked in
  the page); text-only emails render as a 600px text column (24px margins,
  14pt). The resvg text sheet (`receipt-render.server.ts`) is the final
  fallback for any browser failure.
- PDF attachments are stored as rendered PNGs; the stored image is always
  browser-displayable (HEIC/BMP/TIFF → PNG via sharp).
- `RECEIPT_OCR_MODE` defaults to `auto` (**vision first**): the hosted
  model reads the image (`LLM_VISION_MODEL`, DeepSeek's
  `deepseek-v4-flash-vision-exp`) with zero local OCR CPU on the happy path;
  tesseract.js runs **only when the provider errors** (weak vision results
  stand; photocopies/glare are vision cases anyway). `deepseek` forces
  vision-only; `tesseract` forces local-only. See `docs/extraction.md`.
- Extraction is LLM-cheap by design: an email body or PDF text layer naming a merchant
  the account spent with in the last 90 days, with a parseable total,
  skips the model entirely (stored category/report + deterministic amount
  parse via `tryKnownMerchantExtraction` in `app/lib/receipt-ai.server.ts`);
  LLM results are cached per account by input hash
  (`app/lib/db/extraction-cache.ts`, 7-day TTL), so re-uploading the same
  receipt costs nothing.
- Heavy deps (sharp, @resvg/resvg-js, @napi-rs/canvas, tesseract.js,
  pdfjs-dist) are Node-runtime only; native modules must stay external in
  the server build (Vite SSR externalizes node_modules by default).
