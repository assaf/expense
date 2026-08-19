# Receipts by email

inbound is FastMail-only (the Resend webhook path was removed in Aug 2026 — see the git history for `api.inbound-email.ts`). A FastMail delivery rule files mail to a
dedicated address (e.g. `receipts@labnotes.org`) into a folder — never the
Inbox. FastMail pushes an encrypted RFC 8291 `StateChange` to
`/api/inbound-push`; the handler drains the folder via
`processUnprocessedReceipts` (`app/lib/inbound-fastmail.server.ts`): mark
each email `$receipt-processed` **before** processing (the keyword is
one-way, so a concurrent push/cron can't double-process; the `inbound_emails`
row is the second idempotency guard), run the existing `processInboundEvent`
through the FastMail MIME bridge (`InboundDeps` fetch/list/download
collaborators backed by postal-mime — the JMAP email id is the idempotency
key), and **destroy the email after any non-error result** (created /
partial / duplicate / unknown / unverified sender / self-reply). Error
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
transient failure, reusing the same email id — the blob/Sent import
doesn't repeat) when `FASTMAIL_TOKEN` has send
permission; without it the send is skipped with a warning. The
self-reply guard compares the incoming
From against the outbound address, so forwarded replies can't loop.
**Bounces and autoresponders are dropped silently** (never imported,
never answered): a cheap pre-fetch check matches DSN subject lines
(`Undelivered Mail`, `Delivery Status Notification`, …) and daemon
senders (`mailer-daemon@`, `postmaster@`), and a post-fetch header check
matches null `Return-Path: <>`, `multipart/report` bodies, and
`Auto-Submitted: auto-*`. Without this, a failed outbound reply bounces
back from the mail server, the bounce looks like an unknown sender, gets
another reply, bounces again — an infinite Sent-folder loop (Aug 2026: a
run of this produced hundreds of "Receipt not imported" emails in Sent).

**Runaway protection (three layers, all still live):**

1. The bounce guard above is the durable stop — it drops DSNs and
   autoresponders before they reach the reply path.
2. A reply circuit breaker in `processUnprocessedReceipts` never replies
   to the same address twice in one drain; a repeated target means the
   guard was bypassed, so the duplicates are suppressed and a Sentry warning
   (`[inbound] duplicate reply suppressed — possible bounce loop`) fires.
3. The daily cron tick is wrapped in a Sentry cron monitor
   (`expense-inbound-cron`) — a missed check-in alerts if the pipeline stops
   draining (bad deploy, broken auth, …).

Recurrence diagnosis: search Sent for `[inbound] duplicate reply` or the
cron monitor's missed check-in; in Fastmail, `from:me subject:"Receipt
not imported"` counts the sent-loop fallout (delete the old ones — the
loop itself is dead).
**When pushes stop arriving, the subscription is unverified** — a
subscription created before the webhook was live (or with stale push
keys) never completed the PushVerification handshake, and verification
state is invisible via the API (`verificationCode` reads null either
way). Fix: destroy the subscription and recreate it (a tsx script
calling `destroySubscription` + `ensureSubscription`) so FastMail sends a
fresh PushVerification against the live webhook. `RECEIPTS_FOLDER` must
match the folder name EXACTLY (a `Receipt` vs `Receipts` mismatch makes
every drain throw and die silently). To test the push handler without
waiting for FastMail: encrypt a StateChange with the app's own keys
(`p256dhFromPrivate(PUSH_PRIVATE_KEY)` + `http_ece` encrypt) and POST it
to `/api/inbound-push` — decryption is the auth, so this works.
Env: `FASTMAIL_TOKEN`,
`PUSH_PRIVATE_KEY`/`PUSH_AUTH` (from `pnpm setup:push`), `DEVICE_CLIENT_ID`
(default `expense-receipts`), `RECEIPTS_FOLDER` (must match the rule's
folder), `INBOUND_EMAIL_ADDRESS`, `CRON_SECRET`, and `PUBLIC_URL` (the push URL is
`<PUBLIC_URL>/api/inbound-push` — set it in prod or verification fails).

- **Verification + exclusivity**: adding an address (Settings → Receipts by
  email, or auto-added at signup/join/login) puts it in `inbound_senders` as
  **pending** and emails a verification link to it (single-use token hashed
  in `verificationTokenHash`, 7-day TTL, resent on demand or when stale
  > 24h). Only after the mailbox owner clicks the link does the address
  > accept receipts. Clicking writes the claim to
  > `inbound_sender_verifications` (address PK = the DB-level exclusivity
  > authority — one verified account per address) and **deletes every other
  > account's pending rows for that address**; a rival's stale link then
  > fails. Removing a sender deletes both rows and frees the address. The
  > user's login email is always ensured as a sender (`ensureInboundSenderForUser`
  > on signup/join/login, auto-emailing a verification link when owed) — it
  > shows in Settings as "Your sign-in email" and can't be removed. The
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
- The hosted DeepSeek API is text-only today — image OCR falls back to
  tesseract.js (CDN worker/lang at runtime). `RECEIPT_OCR_MODE=deepseek`
  forces vision-only. Don't expect image input to work until DeepSeek ships
  it on the hosted API.
- Extraction is LLM-cheap by design: an email body or PDF text layer naming a merchant
  the account spent with in the last 90 days, with a parseable total,
  skips the model entirely (stored category/report + deterministic amount
  parse — `tryKnownMerchantExtraction` in `app/lib/receipt-ai.server.ts`);
  LLM results are cached per account by input hash
  (`app/lib/db/extraction-cache.ts`, 7-day TTL), so re-uploading the same
  receipt costs nothing.
- Heavy deps (sharp, @resvg/resvg-js, @napi-rs/canvas, tesseract.js,
  pdfjs-dist) are Node-runtime only; native modules must stay external in
  the server build (Vite SSR externalizes node_modules by default).
