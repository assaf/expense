# Connected email accounts (auto-import)

Users connect their **own** email account so expenses import straight from
their inbox — no forwarding, no manual entry. Distinct from
[receipts-by-email](receipts-by-email.md) (forward receipts to a dedicated
address); both coexist.

**Status: all four phases shipped (connect/verify/disconnect, per-connection
push webhook + renewal cron, rules + processing pipeline, rule inference
from an existing inbox).**

## What exists today

- **Model** (`prisma/schema.prisma`): `EmailConnection` — one row per
  connected mailbox, scoped to the workspace (`accountId`) but with
  `emailAddress` **globally unique**: one mailbox feeds exactly one
  workspace, so two accounts can never race to process (and trash) the same
  email. `EmailProcessLog` — one row per evaluated email (idempotency key =
  connection + JMAP email id), the audit/health log and the source of the
  "processed in the last 24 hours" stat.
- **Token handling**: the user generates a FastMail API token (Settings →
  Privacy & Security → API tokens), pastes it in Settings → Email accounts.
  We verify it live against `https://api.fastmail.com/jmap/session`
  (`app/lib/jmap.server.ts` — distinguishes invalid token / no mail scope /
  network), then store it **AES-256-GCM encrypted**
  (`app/lib/token-crypto.server.ts`, key = `EMAIL_TOKEN_ENCRYPTION_KEY`, 32 bytes
  base64). The token is never returned to the client after connect.
- **Store**: `app/lib/db/email-connections.ts` — create (with exclusivity
  checks), list (with last-24h stat, never the token), remove, plus the
  push-subscription state, lastPushAt stamp, and status flips.
- **Per-connection push** (`app/lib/email-connection-push.server.ts`): a
  JMAP `PushSubscription` per connection, renewed by the daily cron.
  Reuses the app's RFC 8291 push keys (`PUSH_PRIVATE_KEY`/`PUSH_AUTH` —
  they're our decryption keys, not per-tenant secrets); the per-connection
  parts are the push URL (`/api/email-connections-push?c=<connectionId>`)
  and the deviceClientId (`expense-conn-<connectionId>`). Every JMAP call
  authenticates as the user with their stored token. Subscription
  id/expiry are persisted on the connection row.
- **Webhook** (`app/routes/api.email-connections-push.ts`): public; the
  decrypted body is the auth. PushVerification → echo the code with the
  connection's token (completes the handshake, clears `status=error`).
  StateChange → stamp `lastPushAt` (draining/matching is phase 3).
  Pushes for unknown/disconnected connections 404 quietly.
- **Cron** (`app/routes/api.email-connections-cron.ts`, vercel.json,
  daily 13:00 UTC): renew every connection's subscription (recreate within
  7 days of the 30-day expiry — recreation triggers a fresh
  PushVerification). A failure (revoked token, FastMail error) flags the
  connection `status=error` → "Needs attention" in Settings; a successful
  renewal clears it.
- **Disconnect** also destroys the server-side subscription (best effort —
  an orphaned one dies at expiry and its pushes 404).
- **Settings UI**: `app/components/settings/email-accounts.tsx` — step-by-step
  FastMail instructions with the direct new-token link, connect form,
  connection rows with stats (received / processed / last 24h / last
  webhook), disconnect.
- **Stats counters**: `receivedCount` / `processedCount` / `lastPushAt` are
  incremented by the processing pipeline (phase 3); `processedLast24h` is
  computed from `EmailProcessLog` rows with `outcome = "created"`.

## Env

- `EMAIL_TOKEN_ENCRYPTION_KEY` — 32-byte base64 key (`openssl rand -base64 32`) that
  encrypts user API tokens at rest. **Required in production before anyone
  connects an account.** When unset, the Settings section reports the
  feature unconfigured and the `connectEmail` action returns 503. Losing
  the key invalidates all stored tokens (users reconnect); it cannot be
  rotated without that cost.

- **Rules** (`app/lib/db/email-rules.ts` + `app/data/email-rules.ts`):
  general rules (seeded: Apple, Amazon, Uber, …) synced on boot by
  `initStore`; user rules learned automatically when a receipt forward
  imports successfully (`learnRuleFromForward` in the inbound pipeline —
  the ORIGINAL sender from the forwarded content becomes the rule). A rule
  is an exact address or a domain (matches subdomains).
- **Processing pipeline** (`app/lib/email-connection-process.server.ts`):
  on each push (and daily via the cron) the Inbox is drained (3-day
  lookback, EmailProcessLog = idempotency). Per email: self/bounce guards
  → rule match (no match = ignore, untouched) → **local classification**
  (`app/lib/email-classify.ts` — regex only, no LLM: marketing and
  shipping mail from rule-matched senders is filtered before any model
  call, so a webhook never costs a DeepSeek request for junk) → the shared
  receipt core
  (same extraction/render/save as receipts-by-email — see
  `selectReceiptSource`/`extractReceiptFromSource`/`saveExpenseFromExtraction`
  in `inbound-email.server.ts`) → on success the email moves to **Trash**
  and the mailbox owner gets a confirmation email (from their own mailbox,
  with the edit link). Marketing mail from a rule-matched sender is
  ignored in place. Errors are logged to EmailProcessLog and the email
  stays in the Inbox — never trashed on failure, never re-expensed.
  Counters: receivedCount per evaluated email, processedCount per created.
- **JMAP mail ops as the user** (`app/lib/email-connection-mail.server.ts`):
  Inbox query, raw RFC 5322 download, Trash move, and send (identity match
  → upload → import → submit, one retry on transient submission failure).

- **Rule inference** (`app/lib/email-connection-infer.server.ts` +
  `pnpm infer:rules`, i.e. `scripts/infer-email-rules.ts`): scan a
  connected inbox read-only (last 90 days, up to 500 emails, subject +
  preview only — no LLM, no full-body fetches) and score senders by
  receipt-likeness with the local classifier. Candidates: a non-freemail
  domain with ≥2 receipt-like emails and ≥50% ratio. The script prints a
  table; `--apply` adds candidates as general rules (source = "inferred"),
  idempotently. Deliberately operator-driven — never cron/webhook-wired,
  because general rules affect every workspace.

## Safety decisions

- Trash, never destroy: recovery is one "move out of Trash" away.
- One workspace per mailbox (global unique) — no double-processing.
- Errors leave the email untouched and set `status = "error"` on the
  connection when the push subscription can't be renewed (user-visible).
- Disconnect deletes the row + token; users should also revoke the token in
  FastMail (the UI says so).

## No-LLM extraction (connected flow)

The connected-mailbox pipeline never calls DeepSeek. Receipts are parsed
with local logic only:

- **Repeat merchant** → `tryKnownMerchantExtraction`: the body names a
  merchant the account has spent with before + a regex-parseable total;
  merchant/category/report come from the account's own history. Zero model
  calls. (This path is shared with receipts-by-email.)
- **First-time merchant from a rule-matched sender** →
  `tryRuleMerchantExtraction`: the merchant name comes from the rule's
  sender domain (curated map for the seeded senders — Apple, Amazon,
  Stripe, …; title-cased label otherwise), the total from
  `parseReceiptAmount`. Category is `""` so the expense lands as
  **partial** (completeness badge flags it); set the category once and the
  known-merchant path carries it forward on every later receipt from that
  sender.
- **Can't parse locally** (no explicit total — refunds, reference-only
  confirmations) → the email is skipped, logged `"not extractable locally"`,
  and left in the Inbox for a manual add. Never trashed, never expensed.
- **Attachment receipts** (PDF/image) → skipped for manual review. The
  connected flow overrides `classifyAttachment` to a no-op so ambiguous
  attachment selection never calls the model tiebreak; it falls through to
  the email body, which extracts locally.

The receipts-by-email (forward) flow is unchanged: it still uses the LLM for
unknown senders, where the model's flexibility is the point. Local-only is
the connected flow, where every sender is rule-matched.
