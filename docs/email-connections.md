# Connected email accounts (auto-import)

Users connect their **own** email account so expenses import straight from
their inbox; no forwarding, no manual entry. Distinct from
[receipts-by-email](receipts-by-email.md) (forward receipts to a dedicated
address); both coexist.

**Status: all four phases shipped (connect/verify/disconnect, per-connection
push webhook + renewal cron, rules + processing pipeline, rule inference
from an existing inbox), plus the inbox review flow (/email-review), plus
the first-run Fastmail onboarding (/onboarding).**

## Connecting via OAuth

The token-paste flow has an OAuth 2.0 alternative ("Connect with
Fastmail"), gated on `FASTMAIL_OAUTH_CLIENT_ID`: unset (today), the buttons
are hidden and paste is the only path; set, an Authorization Code + PKCE
public client flow runs instead (Fastmail registers clients manually, no
client secret exists). Authorization + token endpoints are Fastmail's
(`api.fastmail.com/oauth/authorize|refresh`); the code lives in
`app/lib/fastmail-oauth.server.ts`, with `/connect-fastmail` (entry) and
`/fastmail-oauth-callback` (redirect target) routes.

- **Storage**: same `EmailConnection` row as a pasted token, plus
  `refreshTokenEnc` + `tokenExpiresAt` (null for API-token rows). All
  consumers go through `connectionAccessToken`, which decrypts and returns
  the access token for legacy rows unchanged, and for OAuth rows refreshes
  via the token endpoint 60s before expiry, persisting the ROTATED refresh
  token (Fastmail revokes stale ones; reuse revokes the whole grant).
- **Requested scopes**: `urn:ietf:params:jmap:core` + `urn:ietf:params:
jmap:mail` only (no `jmap:submission`: confirmations are imported, not
  sent).
- **Onboarding**: the anonymous path parks the ENCRYPTED credentials on
  the session (`fmPending`, 10-minute TTL) and the onboarding flow consumes
  them; the callback always verifies the new access token against
  `jmap/session` before anything is stored.
- **Disconnect does not revoke the grant server-side**, same caveat as
  API tokens: users revoke at Fastmail (Settings → Privacy & Security →
  Authorized connections).

### Client registration (one-time)

Fastmail issues OAuth client ids by email to partnerships@fastmailteam.com
(no self-serve). Until the reply sets `FASTMAIL_OAUTH_CLIENT_ID`, the
buttons stay hidden; everything above is already coded and tested.
Ready-to-send request:

> Subject: OAuth client registration for "Expense" (JMAP mail client)
>
> Hi,
>
> I'd like to register an OAuth client for Expense, a personal receipt
> tracker at https://expense.labnotes.org. It connects a user's own
> Fastmail mailbox over JMAP so receipts in their inbox import
> automatically (Email/get, Email/query, Email/import, Mail set
> operations, and PushSubscription/set for push).
>
> - Client type: public, Authorization Code + PKCE (S256), no client
>   secret.
> - Redirect URIs: `https://expense.labnotes.org/fastmail-oauth-callback`
>   and `http://localhost:5199/fastmail-oauth-callback` for development
>   (please allow the localhost port).
> - Requested scopes: `urn:ietf:params:jmap:core` and
>   `urn:ietf:params:jmap:mail` (deliberately not `jmap:submission`:
>   the app imports mail, it does not send).
>
> Two questions: (1) is a client secret required at the token exchange
> for this client type, and (2) is `PushSubscription/set` permitted under
> `jmap:core`, or does it need a separate scope?
>
> Thanks,
> Assaf

When the reply arrives, check it against the assumptions baked into
`app/lib/fastmail-oauth.server.ts`:

- If the reply requires a client secret: add
  `FASTMAIL_OAUTH_CLIENT_SECRET` to `app/lib/env.ts` and include
  `client_secret` in both token POSTs when non-empty.
- If the reply forces https-only redirect URIs (no localhost port
  allowance): update the `redirectUri` derivation in
  `app/routes/connect-fastmail.ts` and re-verify the dev flow.
- If `PushSubscription/set` needs a scope beyond `jmap:core`: add it to
  `OAUTH_SCOPES`; no other code changes (users re-consent once).
- If the token response omits `refresh_token` on refresh (some servers
  only return it on the code exchange): stop rotating
  `refreshTokenEnc` when absent instead of persisting null; the current
  code assumes Fastmail always rotates, per their docs.

## Gmail / Google Workspace

A second provider behind the same pipeline, quiet-launched in Google
**Testing mode** (env-gated exactly like Fastmail OAuth: the four
`GOOGLE_*` vars in `docs/operations.md`; while any is unset the Gmail
surfaces stay hidden). Advertising copy is unchanged; only the functional
surfaces (/onboarding step 1, /emails, the home empty-state nudge) present
both providers equally when configured.

**Architecture**: no Google SDK — plain `fetch` + `node:crypto`, matching
the Vercel lazy-loading story. OAuth lives in
`app/lib/google-oauth.server.ts` (Authorization Code + PKCE, confidential
client, consent forced so Google always issues a refresh token); the Gmail
API client + pipeline adapter live in `app/lib/gmail.server.ts`; the
provider branch point is `mailClientFor` in
`app/lib/email-connection-process.server.ts` (adapter + owner-notification
transport; the drain/review pipeline itself is provider-agnostic). Routes:
`/connect-gmail` and `/gmail-oauth-callback` (mirror the Fastmail pair),
plus `/api/email-connections-gmail-push` (Pub/Sub push webhook).

**Scope rule**: only `gmail.modify` + `openid email`. No `gmail.send`:
report/confirmation emails reach the owner's inbox via
`messages.import` (`neverMarkSpam`, `internalDateSource=dateHeader`),
mirroring the Fastmail import-don't-send behavior. `gmail.modify` covers
read, TRASH moves (the success path), and import.

### GCP setup (one-time, per deployment)

1. **Project + OAuth consent screen**: create a GCP project; configure the
   consent screen (External). Justify `gmail.modify` in the scope review.
   While in **Testing** mode, users see the "unverified app" screen, the
   app is capped at 100 test users, and **refresh tokens expire after 7
   days** (they surface as `gmailAccessToken` refresh failures → connection
   `status = "error"` → the user reconnects; no special-casing).
2. **OAuth client**: create a _Web application_ client with redirect URI
   `<origin>/gmail-oauth-callback`. Set `GOOGLE_OAUTH_CLIENT_ID` /
   `GOOGLE_OAUTH_CLIENT_SECRET`.
3. **Pub/Sub**: create a topic; grant publish on it to
   `gmail-api-push@system.gserviceaccount.com`; create a **push**
   subscription to `<origin>/api/email-connections-gmail-push` whose OIDC
   token audience matches `GOOGLE_PUBSUB_AUDIENCE` (defaults to that same
   push URL). Set `GOOGLE_PUBSUB_TOPIC` to the full topic name
   `projects/<project>/topics/<topic>`.

The webhook verifies the Pub/Sub push JWT by hand (`node:crypto`): RS256
signature against Google's JWKS (`kid`-matched, 1h module cache), `iss`
`accounts.google.com`, `aud` = the configured audience, `exp` in the
future. Any failure → 401 (fail closed). An unknown or non-Gmail mailbox
answers **200 { drained: false }** because Pub/Sub retries non-2xx and a
stale subscription must never wedge the retry queue.

**Watch renewal**: `users.watch` (`labelIds: ["INBOX"]`) expires after ~7
days; the daily cron renews at a 48h margin (five retries), persisting
`pushExpiresAt` (`pushSubscriptionId` stays null; Gmail has no id, only an
expiration). Pushes carry a `historyId`, but the drain is lookback-based
with EmailProcessLog dedupe (same as Fastmail), so no history column and
no history API usage.

**Gmail API quirks the adapter absorbs**: `messages.list` is always
newest-first and `after:` is day-granular, so the adapter scans metadata
(500-message cap) and enforces the drain's exclusive-afterIso,
oldest-first contract client-side; raw email needs two calls
(`format=raw` for the source, `format=metadata` for the envelope the
pipeline logs on).

### Before advertising (out of Testing mode)

Google OAuth verification (scope justification for `gmail.modify`) plus an
annual CASA Tier 2 assessment. Until both land: 100 test users, 7-day
refresh-token expiry, and the unverified-app consent screen are accepted
limitations of the quiet launch, documented rather than worked around.

### Setup checklist after registering (mirrors the Fastmail checklist)

- Create the OAuth client + Pub/Sub topic/subscription as above.
- Set the four `GOOGLE_*` vars in Vercel (production) and redeploy.
- Connect a real Google account, send a receipt email to the mailbox,
  confirm the push → drain → expense flow, and check `/api/smoke` stays
  green.

## Fastmail onboarding (/onboarding)

First-run flow for users who connect their own mailbox instead of signing
up with email + verification link (entry: "Connect a Fastmail account
instead" on the sign-up flow, /login?mode=create).

- **Token = mailbox control = email verification.** The step-1 form pastes
  a Fastmail API token; `verifyJmapToken` proves it live against
  `jmap/session`, which also reveals the account's address; no typing.
  Step 2 sets a password (new account) or enters the existing account's
  password (attach). On success `emailVerifiedAt` is stamped WITHOUT an
  emailed link: a valid token is strictly stronger proof than a
  click-through link. Session cookie + redirect into `/email-review` with
  `?onboarding=1` (the "Finish setup" CTA lands on the expense list, which
  shows a one-time welcome panel: the flow flags the account via the
  `welcomePending` setting; other accounts never see it).
- **Login email claimed as a VERIFIED sender.** The same proof claims the
  address as a verified receipts-by-email sender
  (`verifyInboundSenderDirect` in `app/lib/db/inbound.ts`, the same exclusive
  claim transaction as the link click, no token), so forwarding from the
  address works immediately and `login()`'s `ensureDefaultSender` finds the
  row already verified and skips its email.
- **Account matching** (`app/lib/onboarding.server.ts`): step 2 asks for
  the EMAIL + PASSWORD the user signs in with, and the mailbox connects to
  THAT account. No account for the entered email → create one (name
  derived from the email local part, numeric suffix on collision,
  `emailVerifiedAt` stamped; the token proves mailbox control); verified
  account → sign in (`login()`, so lockout/rehash apply) and attach; stale
  unverified signup → replaced via `deleteUnverifiedUser`. The token's own
  address only PRE-FILLS the email field: a mailbox address that happens
  to own an account the user can't authenticate to (e.g. a bootstrap
  account) must not block attaching to the user's real account. The
  receipts-by-email sender is claimed as verified only when the account
  email equals the mailbox address (the token proves control of the
  mailbox, not of other addresses). A mailbox already claimed by another
  workspace refuses with the standard error and any half-created account
  is rolled back. The step-1 resolution (`verifyOnboardingToken`) reports
  none/verified/unverified so the UI picks the right copy.
  Attach can still dead-end when the user doesn't know their account
  password. The attach step links to `/reset-password?email=…`, so
  mailbox control (the token) plus the emailed link recovers the account.
- The user still sets a password: sessions expire after 30 days; the token
  is stored AES-256-GCM encrypted as usual.

## Discovery surfaces (how users hear about connecting)

The feature is promoted in the public marketing copy (`app/lib/seo-content.ts`,
the single source; renders /, /about, /faq, /alternatives + their .md mirrors
and llms.txt) and with in-app nudges:

- **Sign-up flow** (`/login?mode=create`): blue "Connect your Fastmail
  account" button under an "or" divider.
- **Landing page**: hero line ("Have a Fastmail account? Connect it…") and a
  "Connect your Fastmail account" feature card.
- **FAQ**: "Does Expense work with FastmaiFastmail"only support Gmail"
  positioning lives in the FAQ, the /alternatives "Email import" comparison
  row, and the /about benefit + KEY_FACTS.
- **Home page highlight** (`FeatureHighlight`): the `connect-email` highlight
  is in the rotation ONLY while the account has no connected mailbox
  (`HighlightData.hasEmailConnection`), and `pickHighlight(data, boost)`
  triples its odds until connected (the loader boosts it), so unconnected
  accounts see the nudge within a few visits while the rotation still varies.
- **Empty state** (`_index.tsx`): new accounts with no expenses and no
  connection get the connect suggestion under the "Nothing here yet" copy.
- **Signup success screen** ("Check your email", `login.tsx`): mentions
  connecting Fastmail once signed in.
- **/emails**: accounts using receipts-by-email (verified senders) but no
  connection see a callout suggesting they connect instead of forwarding.
- **Welcome panel** (`WelcomePanel`, gated by the `welcomePending` setting):
  shown after onboarding completes; dismiss persists via the setting.

## What exists today

- **Model** (`prisma/contract.prisma`): `EmailConnection`, one row per
  connected mailbox, scoped to the workspace (`accountId`) but with
  `emailAddress` **globally unique**: one mailbox feeds exactly one
  workspace, so two accounts can never race to process (and trash) the same
  email. `EmailProcessLog`, one row per evaluated email (idempotency key =
  connection + JMAP email id), the audit/health log and the source of the
  "processed in the last 24 hours" stat.
- **Token handling**: the user generates a Fastmail API token (Settings →
  Privacy & Security → API tokens), pastes it on the Email page.
  We verify it live against `https://api.fastmail.com/jmap/session`
  (`app/lib/jmap.server.ts`, which distinguishes invalid token / no mail scope /
  network), then store it **AES-256-GCM encrypted**
  (`app/lib/token-crypto.server.ts`, key = `EMAIL_TOKEN_ENCRYPTION_KEY`, 32 bytes
  base64). The token is never returned to the client after connect.
- **Store** (`app/lib/db/email-connections.ts`): create (with exclusivity
  checks), list (with last-24h stat, never the token), remove, plus the
  push-subscription state, lastPushAt stamp, and status flips.
- **Per-connection push** (`app/lib/email-connection-push.server.ts`): a
  JMAP `PushSubscription` per connection, renewed by the daily cron.
  Reuses the app's RFC 8291 push keys (`PUSH_PRIVATE_KEY`/`PUSH_AUTH`;
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
  7 days of the 30-day expiry; recreation triggers a fresh
  PushVerification). A failure (revoked token, Fastmail error) flags the
  connection `status=error` → "Needs attention" on the Email page; a successful
  renewal clears it.
- **Disconnect** also destroys the server-side subscription (best effort;
  an orphaned one dies at expiry and its pushes 404).
- **Settings UI** (`app/components/settings/email-accounts.tsx`): step-by-step
  FastmaiFastmailctions with the direct new-token link, connect form,
  connection rows with stats (received / processed / last 24h / last
  webhook), disconnect. Rendered on the Email page (`app/routes/emails.tsx`).
- **Stats counters**: `receivedCount` / `processedCount` / `lastPushAt` are
  incremented by the processing pipeline (phase 3); `processedLast24h` is
  computed from `EmailProcessLog` rows with `outcome = "created"`.

## Env

- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` /
  `GOOGLE_PUBSUB_TOPIC` / `GOOGLE_PUBSUB_AUDIENCE` (the last optional,
  defaulting to this deployment's push URL): Gmail/Google Workspace
  support, all required together. See
  [Gmail / Google Workspace](#gmail--google-workspace) above and
  `docs/operations.md`.

- `EMAIL_TOKEN_ENCRYPTION_KEY`: 32-byte base64 key (`openssl rand -base64 32`) that
  encrypts user API tokens at rest. **Required in production before anyone
  connects an account.** When unset, the Settings section reports the
  feature unconfigured and the `connectEmail` action returns 503. Losing
  the key invalidates all stored tokens (users reconnect); it cannot be
  rotated without that cost.

- **Rules** (`app/lib/db/email-rules.ts` + `app/data/email-rules.ts`):
  general rules (seeded: Apple, Amazon, Uber, …) synced on boot by
  `initStore`; user rules learned automatically when a receipt forward
  imports successfully (`learnRuleFromForward` in the inbound pipeline:
  the ORIGINAL sender from the forwarded content becomes the rule). A rule
  is an exact address or a domain (matches subdomains).
- **Processing pipeline** (`app/lib/email-connection-process.server.ts`):
  on each push (and daily via the cron) the Inbox is drained (3-day
  lookback, cursor-scanned over receivedAt; an all-seen batch slides the
  window forward instead of stopping, so a front of ignored mail never
  blocks newer mail from the catch-up; EmailProcessLog = idempotency). Per email: self/bounce guards
  → rule match (no match = ignore, untouched) → **precision-first
  classification** (`classifyReceiptEmail` in
  `app/lib/email-classify.ts`, regex only, no LLM): bank-notification
  senders (the notification-senders seed domains), payment-status
  subjects (payment received/processing, upcoming invoice, purchase
  approved, statement credit, charged twice), and marketing/shipping mail
  are all skipped in place; a receipt-signal subject (receipt/invoice/
  order confirmation/payment) imports; everything else is **uncertain**
  and also skipped — a body amount alone never promotes non-receipt mail
  into an expense, and uncertain emails stay in the Inbox for review or
  manual add (the LLM fallback for the uncertain class is a designed
  extension, not wired) → the shared
  receipt core
  (same extraction/render/save as receipts-by-email; see
  `selectReceiptSource`/`extractReceiptFromSource`/`saveExpenseFromExtraction`
  in `inbound-email.server.ts`) → on success the email moves to **Trash**
  and the mailbox owner gets a confirmation **written to their Inbox**
  (see below; the API token can't send) with the edit link. Marketing mail
  from a rule-matched sender is ignored in place. Errors are logged to
  EmailProcessLog and the email stays in the Inbox: never trashed on
  failure, never re-expensed. Counters: receivedCount per evaluated
  email, processedCount per created.
- **JMAP mail ops as the user** (`app/lib/email-connection-mail.server.ts`):
  Inbox query, raw RFC 5322 download, Trash move, and Inbox delivery of
  the confirmation (upload RFC 5322 blob → `Email/import` into the Inbox;
  no submit).

- **Rule inference** (`app/lib/email-connection-infer.server.ts` +
  `pnpm infer:rules`, i.e. `scripts/infer-email-rules.ts`): scan a
  connected inbox read-only (last 90 days, up to 500 emails, subject +
  preview only; no LLM, no full-body fetches) and score senders by
  receipt-likeness with the local classifier. Candidates: a non-freemail
  domain with ≥2 receipt-like emails and ≥50% ratio. The script prints a
  table; `--apply` adds candidates as general rules (source = "inferred"),
  idempotently. Deliberately operator-driven (never cron/webhook-wired),
  because general rules affect every workspace.

## Safety decisions

- Trash, never destroy: recovery is one "move out of Trash" away.
- One workspace per mailbox (global unique), so no double-processing.
- Errors leave the email untouched and set `status = "error"` on the
  connection when the push subscription can't be renewed (user-visible).
- Disconnect deletes the row + token; users should also revoke the token in
  FastmaiFastmailI says so).

## No-LLM extraction (connected flow)

The connected-mailbox pipeline never calls DeepSeek. Receipts are parsed
with local logic only:

- **Repeat merchant** → `tryKnownMerchantExtraction`: the body names a
  merchant the account has spent with before + a regex-parseable total;
  merchant/category/report come from the account's own history. Zero model
  calls. (This path is shared with receipts-by-email.)
- **First-time merchant from a rule-matched sender** →
  `tryRuleMerchantExtraction`: the merchant name comes from the rule's
  sender domain (curated map for the seeded senders: Apple, Amazon,
  Stripe, …; title-cased label otherwise), the total from
  `parseReceiptAmount`. Category is `""` so the expense lands as
  **partial** (completeness badge flags it); set the category once and the
  known-merchant path carries it forward on every later receipt from that
  sender.
- **Can't parse locally** (no explicit total: refunds, reference-only
  confirmations) → the email is skipped, logged `"not extractable locally"`,
  and left in the Inbox for a manual add. Never trashed, never expensed.
- **Attachment receipts** (PDF/image) → skipped for manual review. The
  connected flow overrides `classifyAttachment` to a no-op so ambiguous
  attachment selection never calls the model tiebreak; it falls through to
  the email body, which extracts locally.

The receipts-by-email (forward) flow is unchanged: it still uses the LLM for
unknown senders, where the model's flexibility is the point. Local-only is
the connected flow, where every sender is rule-matched.

## Confirmation delivery (written to Inbox, not sent)

Fastmail **API tokens can't submit mail.** `EmailSubmission/set` and
`Identity/get` return HTTP 403 `"Disallowed capabilities for this
type/client: urn:ietf:params:jmap:submission"`. The token can read/write
mail (Email/get, Email/query, Mailbox/get, Email/set mailboxIds,
Email/import) but cannot send.

So the confirmation-to-owner is **delivered, not sent**: the RFC 5322
blob is uploaded and `Email/import`-ed straight into the owner's Inbox
(mail capability only, the same one used to Trash). The owner sees it
appear in their Inbox; no SMTP, no identity, no submission. The expense

- Trash already succeeded, so a delivery failure is logged and never
  fatal.

### Loop guard (header-based)

The app's own confirmations look like receipts ("Receipt" + a `$` total
in the body), so without a guard a flow that re-scans a folder they
land in would reprocess them in a feedback loop: 1 receipt → N
expenses + N+ confirmations across drains.

`buildRfc822Message` sets `X-Expense-Confirmation: 1` on **all** outbound
app mail. Both inbound pipelines recognize it via
`hasOwnConfirmationHeader` (case-insensitive) and skip + remove the
email: the forward flow (`processUnprocessedReceipts`) destroys it
before `processInboundEvent`; the connected flow
(`processConnectionEmail`) logs + ignores it after fetch (a backstop
behind the sender self-check). A real receipt never sets this header,
so it can't be spoofed into the skip path. Header-based, not
subject-based; no brittle regex to keep in sync with the wording.

## Receipt number in the description

`parseReceiptRef` pulls a `#ref` (e.g. `#1718-6067`) from the subject
(preferred) or body; the connected-flow local extraction sets it as the
expense `description`, so each expense carries the receipt number it came
from; the user can tell which expense maps to which receipt email.

## Inbox review (/email-review)

A freshly connected mailbox may already hold months of receipts; the
review flow walks the user through them: scan the Inbox for receipt-like
emails, show a list (received date, sender, subject), and let the user
**process** each (→ expense, email to Trash, confirmation in their Inbox)
or **ignore** it (drops off the list, email stays in the Inbox). Both
actions require confirmation in the UI. Entry: the Review button on each
connection row on the Email page (`/emails`), which shows the pending
count; a never-scanned connection auto-scans on first visit.

Implementation (`app/lib/email-review.server.ts`, route
`app/routes/email-review.tsx`, UI `app/components/email-review.tsx`):

- **Scan** (`scanConnectionInbox`): one bounded batch, Inbox email from
  the last 90 days, newest first, capped at 500 messages (45s defensive
  budget). Bounded so a scan can't be hammered into downloading a whole
  backlog; email older than the window isn't offered by review
  (rule-matched senders are still caught by the auto-drain).
  For each undecided email it fetches + parses the raw message
  and runs the same local classifier as the pipeline
  (`looksLikeReceiptEmail`); matches are upserted on `EmailProcessLog` as
  `outcome = "pending-review"` with the receivedAt + full From header
  (columns added for the list display). Non-receipts get NO row, so the
  auto-pipeline still evaluates them later (a rule added after a scan is
  not shadowed). Rows the pipeline already created/partial/processing,
  rows the user review-ignored, and ignored rows with a decisive reason
  (self / bounce / own confirmation) are skipped; everything else (no
  rule, not a receipt locally, not extractable locally, pipeline errors)
  is re-examined (recovering emails the pipeline couldn't handle is a
  core purpose). `reviewScannedAt` on the connection row stamps that the
  list is current.
- **Bank notifications** ("A new transaction was charged to your
  account", CapitalOne today; `isTransactionNotification` in
  `email-classify.ts`): the same email is noise when the merchant also
  sends a receipt (z.ai) and the only record when they don't
  (self-storage), so content can't decide. The scan matches them by
  ARRIVAL TIMING (`decideNotifications` in `email-review.server.ts`),
  which mirrors the mailbox's view of a charge: transaction posts → the
  bank's alerts land within a minute (domestic + international
  together) → the merchant's receipt email follows minutes later,
  within an hour. The charge amount comes off the "Amount: $X" line
  (card-currency, not the international variant's foreign amount);
  notifications group by (date, amount) and cluster into bursts by
  arrival (5-minute gap = new charge). Every successfully processed
  email is stamped with the expense it created (`expense:<id>` on its
  log row; `notification-expense:<id>` for notifications), and the row's
  receivedAt is the EMAIL's arrival, so the receipt's arrival moment is
  known. A receipt covers a burst when its email arrived within two
  hours after the burst, and only the burst it FOLLOWS: a receipt
  landing before a burst belongs to an earlier charge. So two
  same-amount charges ten minutes apart with one receipt supersedes only
  the first charge's burst; the second notification stays listed,
  because its charge has no other record. Expenses with no arrival
  record (hand-entered, forwarded through the receipts address, or
  imported before the stamps existed) never cover anything, and expenses
  created from notifications are their charge's record, never covers:
  every ambiguity fails toward "stays listed", never a silent loss. A
  covered burst is logged `review-ignored` with reason
  `superseded:<expenseId>` and never offered; everything is re-decided
  every scan, so notifications drop off once their receipt is imported
  and RETURN if it is deleted. Rows the user ignored by hand are never
  re-offered. The review page shows the skips as an audit trail: "Bank
  notifications skipped", each linked to the receipt that covered it;
  the emails stay in the Inbox. Residual ambiguity: two same-amount
  charges within the 5-minute burst window, or a receipt delayed past
  two hours (the notification stays listed; ignore it by hand).
  Keep notification senders OUT of the email rules: the auto-drain has
  no supersede check, so a rule would import notifications as expenses
  (the drain sees them before the merchant receipt arrives).
- **Charges with no expense** (`listUncoveredCharges` in
  `email-review.server.ts`): the charge-side bookend to the superseded
  audit. Every pending bank notification on the connection is listed on
  the review page in a "Bank charges with no expense" section (month
  grouped), each actionable like a review item (process/ignore, without
  the remember-sender option: accepting a bank as a rule is always
  wrong). The list re-runs the cover pairing on load, so a pending
  notification whose receipt arrived meanwhile is flipped to superseded
  and leaves the section, even for emails long past the scan's 90-day
  window (their charge amount is stored on the log row at scan time,
  `chargeAmount`, since the email may leave the Inbox). This is where a
  card-only charge that would otherwise be silently lost (ignored Extra
  Space alerts) stays visible until the user acts.
- **Process** (`processReviewItem` → `processConnectionEmail` with
  `{ review: true }`): review mode is the auto-pipeline minus the rule
  gate and the local receipt gate (the user's explicit choice replaces
  them), with the model allowed (`localOnly: false`) so attachment
  receipts and unparseable totals work. The claim flips the
  pending-review row to `processing` in place (no insert race); success
  logs created/partial, moves the email to Trash, and delivers the owner
  confirmation ("You processed this email as an expense…"); failure
  logs back to pending-review so the item stays on the list with the
  error shown.
- **Remember the sender** ("accept a new sender"): emails from senders
  with no rule show a "New sender" badge; the process confirmation
  offers a checkbox (default on) that adds a user rule
  (`source = "review"`): the sender's domain, or their exact address
  for freemail providers (`reviewSenderRulePattern`, same policy as rule
  inference). Skipped when any rule already covers the sender.
- **Ignore** (`ignoreReviewItem`): flips the row to
  `outcome = "review-ignored"` ("user ignored"). The email stays in the
  Inbox untouched; the row keeps both the auto-pipeline and future scans
  from re-offering it.

Outcomes live on the existing `EmailProcessLog` row (one per email):
`pending-review` (on the list), `review-ignored` (user said no),
`created`/`partial` (processed), plus the pipeline's own values. The
auto-drain's seenEmail check skips any logged email, so a pending or
review-ignored row is never double-processed.

## Dev tooling

- `pnpm drain:email --connection <id> [--role inbox|trash] [--limit N]
[--days N]` (`scripts/drain-email-connection.ts`): drains a mailbox
  under tsx with **stubbed renderers** (tsx can't load Vite's `?inline`
  font asset), so the saved receipt image is a 1×1 placeholder. Use it
  for fast logic checks, not for the final image.
- `GET /api/dev-email-drain?connection=<id>` (dev only, `Bearer
<CRON_SECRET>`): drains the Inbox in the **bundled dev server** with the
  real Playwright renderer, so the saved image is a true render of the
  email. Use this when the image matters.
