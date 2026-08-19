# Connected email accounts (auto-import)

Users connect their **own** email account so expenses import straight from
their inbox — no forwarding, no manual entry. Distinct from
[receipts-by-email](receipts-by-email.md) (forward receipts to a dedicated
address); both coexist.

**Status: phases 1–2 shipped (connect/verify/disconnect + per-connection
push webhook + renewal cron). Phase 3 (processing pipeline) and phase 4
(rule inference) are planned.**

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

## Planned (not built yet)

1. **Phase 3 — processing**: rules engine (general rules seeded
   Apple/Amazon/etc. + per-user rules learned when a user forwards a
   receipt via receipts-by-email), body classification (receipt vs
   marketing), expense creation through the existing extraction pipeline,
   move the email to **Trash** (not destroy — recoverable), and a reply
   email with the collected fields + edit link, sent from the user's own
   mailbox via their token. Every decision logged in `EmailProcessLog`;
   errors keep the email in place (never lose an expense).
2. **General-rule inference (phase 4)**: scan a connected inbox (read-only)
   to propose general rules from senders with receipt-like history.

## Safety decisions

- Trash, never destroy: recovery is one "move out of Trash" away.
- One workspace per mailbox (global unique) — no double-processing.
- Errors leave the email untouched and set `status = "error"` on the
  connection when the push subscription can't be renewed (user-visible).
- Disconnect deletes the row + token; users should also revoke the token in
  FastMail (the UI says so).
