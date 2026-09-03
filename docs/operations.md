# Operations: database connections, environment variables, and secrets

Operational reference for the expense app. **Read this before deploying,
touching database configuration, or changing environment variables.**
(AGENTS.md links here; this content moved out of AGENTS.md in Aug 2026.)

---

## Database connections (Supabase)

Supabase direct connections (`db.<ref>.supabase.co:5432`) are **IPv6-only** for
new projects: this network has no working IPv6 route, and Vercel functions
should not rely on it either. Use the **Supavisor pooler** on
`aws-1-us-west-2.pooler.supabase.com` (IPv4):

**`DATABASE_URL` (runtime): transaction-mode pooler, port 6543.** Every Vercel
serverless instance opens its own Prisma pool, so session mode (one dedicated
backend connection per pooled client) exhausted the pooler cap under the
image-heavy list page. Transaction mode shares one small backend pool across all
clients: connections are checked out only for the duration of a
query/transaction, so serverless instances stop holding dedicated slots.
Supavisor's transaction mode handles the extended protocol / prepared statements
and Prisma's batch + interactive transactions (verified against prod with the
PrismaPg adapter).
**Both pooler URLs must carry `?sslmode=no-verify`.** The pooler requires
TLS (rejects plaintext with `(ESSLREQUIRED)`), but its cert is signed by
Supabase's private CA (`Supabase Intermediate 2021 CA`), and pg >= 8.13
verifies the chain for `sslmode=require`/`verify-full` (fails with
"self-signed certificate"). `no-verify` = encrypt-only, which is the
long-standing behavior. A URL pasted from the Supabase dashboard's copy
button has NO sslmode param, so every DB call then fails `(ESSLREQUIRED)`;
this is how prod broke in Aug 2026 (URL re-pasted without the param).

**`DATABASE_URL_UNPOOLED` (psql/prisma DDL in `scripts/deploy`,
`scripts/migrate-prod` and `scripts/clone`): session-mode pooler, port 5432.** Migrations and DDL want stable sessions; the session pooler behaves
like a direct connection. Keep it here, not on the transaction pooler. Also
mirrored as the `DATABASE_URL_UNPOOLED` GitHub Actions secret for the CI
`migrate-db` job (the CI `VERCEL_TOKEN` can't read project settings, so the
DDL URL is passed directly rather than pulled via the Vercel CLI).

Pool sizing still matters: `app/lib/prisma.server.ts` keeps the per-instance
pool at `max: 2` with 4s idle release, and `findUserById` caches lookups for 30s
(the image-list burst). Pooler `pool_size` is capped at **80% of the DB's
`max_connections`** (48 on the current 60-connection compute); the session
pooler is set to 40. **Invariant: never raise a pooler's `pool_size` above 80%
of `max_connections`, and if you change one (e.g. a compute upgrade that bumps
`max_connections`) resize the poolers to match.** A pooler that may open more
backends than Postgres has room for fails with `(EMAXCONN) max client
connections reached, limit: <pool_size>` while holding most of the budget idle
(see the incident below). Temporary fallback if transaction mode misbehaves: flip
`DATABASE_URL` back to port 5432, but session mode is strictly worse under
serverless (one dedicated slot per client); fix the pooler instead.

Incident 2026-08-16: prod 500s with `(EMAXCONN) max client connections
reached, limit: 200` on `prisma.user.findUnique`. `max_connections` was still
60; the pooler already held ~44 idle backends plus ~8 Supabase services
(PostgREST/pg_net/pg_cron/exporter), so the budget was near-exhausted at
idle. Cause: `pool_size` had been raised to 200 (3.3× the whole budget) in
Supabase → Database → Connection pooling. Fix: session pooler ≤ 40,
transaction pooler 10–15.

When setting these in Vercel, add them with `vercel env add … --no-sensitive`: a
_Sensitive_ var pulls back as `[SENSITIVE]` in `vercel env pull`, which silently
breaks `scripts/deploy` (psql then falls back to stale `PG*` env vars). The old
Vercel Neon integration (which set `DATABASE_URL`, `PGHOST`, `POSTGRES_URL`,
`NEON_*`, …) was disconnected in Aug 2026; don't re-add it. The abandoned Neon
database still exists as a rollback fallback.

### Column type changes: the cast rule (learned 2026-08-24)

`prisma db update` (Prisma 8) **cannot** convert a `text` column to a
timestamp type: it reports that the column would be dropped and recreated
and asks for destructive consent, and CI's migrate-db job grants it, which
would drop the column and its data on prod. The test suite never catches
this (the test reset recreates the schema with no data). The operative
schema path is `prisma db update` (CI migrate-db + `scripts/deploy`);
there is no `prisma/migrations` history anymore (the v7 history was
retired with the Prisma 8 migration; prod's `_prisma_migrations` table is
a tolerated leftover, declared as `LegacyPrismaMigrations` with
`@@control(tolerated)` in the contract).

Procedure for a type change (e.g. String → DateTime):

1. Edit `prisma/contract.prisma`, then `pnpm build:prisma` (contract
   emit) so `contract.json`/`contract.d.ts` match.
2. Hand-write rerun-safe SQL and apply it to dev AND prod FIRST (psql on
   `DATABASE_URL_UNPOOLED`, swap `sslmode=no-verify` → `require`):
   `ALTER TABLE "t" ALTER COLUMN "c" TYPE TIMESTAMPTZ USING ("c"::timestamptz);`
   Check for cast-breaking values (e.g. `''`) on both databases first.
3. Then `pnpm db:push` (dev), then the same `db update --confirm <dbname>`
   against prod with `DATABASE_URL_UNPOOLED`, which normalizes timestamptz
   → the contract's `TimestampString(3)` (that conversion db update CAN
   do, data-preserving) and makes the next CI migrate-db a no-op.
4. Apply the ALTER to prod BEFORE pushing the code, or CI's db update
   sees a data-losing plan and the deploy fails.

Prisma 8 notes: every timestamp column is `TimestampString(3)` — a
pass-through string codec, chosen deliberately because the Temporal
codecs need the `Temporal` global (not on current Node/Vercel runtimes).
Reads arrive as Postgres wire text (`"2026-08-25 22:21:25.534"`) and
`app/lib/db/wire.ts` converts to the domain's UTC ISO strings
(`toIso`/`fromIso`); numeric columns read/write as exact decimal strings
(`numeric(10,2)` always carries two decimals on the wire); the `type`
columns are named `_type` in the contract (PSL reserved word) and the
db-layer mappers translate. Postgres errors surface as structured Prisma
envelopes with the SQLSTATE on `err.cause` — use the helpers in
`app/lib/db/pg-errors.ts`, never a top-level `err.code === "23505"`
check. Upsert's `conflictOn` only targets primary keys and unique
constraints (not unique indexes): for `(accountId, hash)`-style unique
indexes, update-where + create-if-missing (see `extraction-cache.ts`).

---

## Secrets

Env load order: `process.env` (Vercel/inline) → local `.env` (via dotenv in
`app/lib/env.ts`). `DATABASE_URL` is required: no file fallback. Dev/test use
`.env` (`DATABASE_URL`, and auth: `APP_EMAIL`, `APP_PASSWORD`,
`SESSION_SECRET`); prod uses the Vercel dashboard (`DATABASE_URL`, plus the same
three auth vars). Pull prod env with `vercel env pull
--environment=production .env.prod` (use `DATABASE_URL_UNPOOLED` for psql/prisma
DDL; both point at the Supabase session pooler, see “Database connections” below). Tests hardcode local services (`expense_test`, image blobs
in Postgres), not `.env`.

Connected email accounts (auto-import, see `docs/email-connections.md`) add
`EMAIL_TOKEN_ENCRYPTION_KEY`: a 32-byte base64 key encrypting users' FastMail API
tokens at rest (AES-256-GCM). Set it in production **before** anyone
connects an account; when unset the Settings section reports the feature
unconfigured and connect returns 503. Losing the key invalidates all stored
tokens, so users would need to reconnect (there is no rotation without that
cost, since the tokens must stay decryptable to act on the user's mailbox).
The connected-accounts webhook and renewal cron reuse the push keys
(`PUSH_PRIVATE_KEY`/`PUSH_AUTH`) and `CRON_SECRET`; the push URL is
`<PUBLIC_URL>/api/email-connections-push?c=<connectionId>`, so `PUBLIC_URL`
must be set before the first connection, and the cron runs daily at 13:00
UTC (vercel.json) after the receipts cron at 12:00.

Receipts-by-email adds optional vars: `INBOUND_EMAIL_ADDRESS`,
`LLM_API_KEY`, `LLM_MODEL` (default `deepseek-v4-flash`), `LLM_BASE_URL`
(default `https://api.deepseek.com`; any OpenAI-compatible endpoint,
e.g. OpenRouter `https://openrouter.ai/api/v1`), `LLM_MAX_TOKENS` (default
500), plus the legacy `DEEPSEEK_API_KEY`/`DEEPSEEK_MODEL` names, which are
still honored as fallbacks. DeepSeek-only request params (e.g. `thinking`)
are emitted only against the DeepSeek endpoint, so pointing `LLM_BASE_URL`
at another provider needs no code change,
`RECEIPT_OCR_MODE` (`auto`
default: vision first, tesseract only on provider error | `deepseek` | `tesseract`),
`LLM_VISION_MODEL` (defaults to
`LLM_MODEL`; DeepSeek's is `deepseek-v4-flash-vision-exp`),
`LLM_VISION_MAX_TOKENS` (default 1500), and `RECEIPT_VISION_MAX_WIDTH` (default
768, clamped 384–1536, the downscale applied before the DeepSeek vision
call; see `docs/extraction.md`). All optional: receipts stop arriving when
the FastMail vars are unset, but the app keeps working.

**Timezones**: the server runs UTC (Vercel) and never computes a
user-facing "today". Web forms default dates from the browser's own
timezone; the dashboard future-badge and mileage-rate lines are computed
client-side after mount; reconciliation sends its local `today` with the
complete request (the future-date ceiling). The MCP tools
(`capture_receipt`, `log_mileage`) are timezone-agnostic by design:
omitting `date` stores today's UTC date, and every response carries
`serverUtcNow` (ISO UTC) so the client (which knows its own timezone)
resolves the user's local date and passes an explicit `date` when it
differs.

The **FastMail JMAP push reader** (the receipts source, which reads
forwarded receipts directly from a FastMail folder and discards them) adds: `FASTMAIL_TOKEN` (JMAP API token: full mail
access, treat as a password; shareable with the inbox project), `PUSH_PRIVATE_KEY`
/ `PUSH_AUTH` (RFC 8291 push keys, generated by `pnpm setup:push`),
`DEVICE_CLIENT_ID` (default `expense-receipts`; keep distinct from other apps'
subscriptions on the same FastMail account), `RECEIPTS_FOLDER` (default
`Receipts`; must match the folder the delivery rule files into), and
`CRON_SECRET` (gates `/api/inbound-cron`). The receipts address is
`INBOUND_EMAIL_ADDRESS`, the single address for the feature: users forward
receipts TO it AND (when FastMail sending is configured) replies/
verifications are sent FROM it (identity-matched, falling back to the
account's default identity). It moved from `receipts@expense.labnotes.org`
(Resend era) to `receipts@labnotes.org` in Aug 2026; mail to any other
address is not processed (the delivery rule only matches the current one),
and the FastMail rule/identity must stay in sync with this var. **The old
Resend-era address is back in service (Aug 2026): `expense.labnotes.org` is a
FastMail subdomain domain (DNS via Cloudflare: MX
`us1/us2-smtp.messagingengine.com`, DKIM `fm1-3._domainkey`, SPF
`include:spf.messagingengine.com`; the old AWS SES MX
`inbound-smtp.us-east-1.amazonaws.com` and the "FastMail -> Resend ->
Expense" redirect rule were removed), and `receipts@expense.labnotes.org` has
the same "Move to label: Receipts" address action as `receipts@labnotes.org`;
mail to either address lands in the Receipts folder with the original
sender intact (no SRS rewrite, so sender verification works). Note: FastMail
offers no API for rules/aliases/domains (the official MCP server is
read/send-only), so these were configured through the web UI (browser
automation), and Cloudflare DNS through the Cloudflare MCP
(`https://mcp.cloudflare.com`). All optional:
when `FASTMAIL_TOKEN`
is unset the push/cron routes 503. When `FASTMAIL_TOKEN` IS set, all
outbound email (receipt replies +
verification emails) goes through FastMail JMAP `EmailSubmission/set` (NOT
RFC 8621 `Email/submit`, which FastMail rejects as unknownMethod; `Identity/get`
is likewise gated behind the `urn:ietf:params:jmap:submission` capability)
from `INBOUND_EMAIL_ADDRESS` (identity-matched, falling back to the
account's default identity); without `FASTMAIL_TOKEN` send permission, outbound emails are
skipped with a warning (logged + Sentry-captured), they never silently fail.

`FASTMAIL_OAUTH_CLIENT_ID` (optional) turns on the "Connect with FastMail"
OAuth flow (Authorization Code + PKCE; no client secret exists). While
unset, the OAuth buttons are hidden everywhere and token paste is the only
connect path; setting it and redeploying switches `/onboarding` and
Settings → Email accounts over without any other change. FastMail issues
client ids manually; the ready-to-send request and the post-reply checklist
are in `docs/email-connections.md` → Client registration (one-time).

Gmail/Google Workspace connections add four optional vars, all required
together (when any is unset the Gmail connect surfaces stay hidden and
FastMail is the only provider): `GOOGLE_OAUTH_CLIENT_ID` and
`GOOGLE_OAUTH_CLIENT_SECRET` (the GCP Web-application OAuth client;
redirect URI `<origin>/gmail-oauth-callback`), `GOOGLE_PUBSUB_TOPIC` (full
topic name `projects/<project>/topics/<topic>` passed to Gmail
`users.watch`), and `GOOGLE_PUBSUB_AUDIENCE` (optional; the OIDC `aud`
expected on Pub/Sub push JWTs, defaulting to this deployment's
`/api/email-connections-gmail-push` URL). Setup steps and Testing-mode
caveats: `docs/email-connections.md` → Gmail / Google Workspace.

`SMOKE_TEST_SECRET` (optional) gates the post-deploy PDF/OCR/MCP smoke check at
GET `/api/smoke` (send it in the `x-smoke-secret` header); when unset the route
is disabled (404) and `scripts/deploy` skips the check with a warning. It must
also be set as a **GitHub Actions secret** (same value) for
`.github/workflows/deployment-smoke.yml`.

`PUBLIC_URL` (optional) is the public base URL the OAuth metadata advertises as
its issuer + endpoint origin. Set it when the app sits behind a TLS-terminating
proxy (e.g. a local `https://expense.localhost` setup) so MCP clients see the
public origin instead of the proxy-internal `http://` one; otherwise they
refuse to authenticate ("Protected resource … does not match expected"). Without
it, the request origin is used, honoring `x-forwarded-proto`/`x-forwarded-host`
for http requests. Also used as the base URL for the “Edit this receipt”
link in inbound confirmation emails. Set it to the production origin
(`https://expense.labnotes.org`) or those emails have no edit link.

`SENTRY_DSN` + `VITE_SENTRY_DSN` (optional, same DSN value twice) enable Sentry
error monitoring (server runtime + browser build-time respectively; see
`app/entry.server.tsx` / `app/entry.client.tsx` and `app/lib/errors.server.ts`).
Unset `SENTRY_DSN` → the server falls back to its hardcoded DSN; unset
`VITE_SENTRY_DSN` → no browser Sentry. The server SDK inits INSIDE the bundle
(`app/entry.server.tsx`, the module Vercel boots as the function handler),
gated on `VERCEL_ENV=production`, so dev/test/preview never emit to the
production project. Do NOT move server init back into a `NODE_OPTIONS --import`
instrument file: Vercel never runs the `start` script, so that code never
executes in the deployed function (the function config's `environment` is empty;
server errors only ever reached Sentry locally this way). The post-deploy smoke
check reports `Sentry.isInitialized()` and `scripts/smoke-check` warns when a
production deployment boots with it false.

Sentry cron monitors: both daily crons run through the shared `cronTick`
helper (`app/lib/cron.server.ts`), which owns the `Sentry.withMonitor`
wrapping and an EXPLICIT `Sentry.flush()` before the route returns. The
flush is load-bearing: the SDK's automatic `flushIfServerless` only works on
Vercel's Edge runtime (its `vercelWaitUntil` helper returns early unless
`EdgeRuntime` is defined), so on Node serverless the ok check-in envelope is
dropped when the lambda freezes after responding and every run reports a
monitor timeout. Never hand-roll a cron route; add a `cronTick` call with a
new monitor name and crontab instead.

`checkinMargin` is set to 30 minutes because Vercel fires crons late (2-4
minutes typically, but observed ~25 minutes late on 2026-08-29); the
original 5-minute margin logged every late fire as a false "missed" check-in
while the tick itself ran healthy.

`vercel env pull` REDACTS sensitive env vars as the literal string
`[SENSITIVE]` — scripts that need real secrets (EMAIL_TOKEN_ENCRYPTION_KEY,
FASTMAIL_TOKEN, SENTRY_AUTH_TOKEN) must source them from `.env` or read
them from the Vercel dashboard, not from a pulled env file.

Vendor tracer-bridge packages: when a dependency lazy-loads files Vercel's
tracer can't follow (alias requires, binary assets), add a tiny
`vendor/<name>/index.cjs` that `require`s the exact exported subpaths. As a
node_modules `file:` dependency it ships un-bundled, so its requires stay
literal and the tracer follows them with require conditions. Import it
alongside the lazy dependency (see `vendor/pdfkit-standard-fonts`). Both vars must be set in Vercel;
`VITE_SENTRY_DSN` is baked at build time, `SENTRY_DSN` is read at runtime.
`SENTRY_AUTH_TOKEN` is now SET (organization token, Vercel production env;
create at Sentry → org settings → Auth Tokens). It lets the vite plugin
(`sentryReactRouter` in `vite.config.ts`) create releases + upload
sourcemaps at build time. Releases are named after `VERCEL_GIT_COMMIT_SHA`
(override with `SENTRY_RELEASE`); client events get the same release via
`VITE_SENTRY_RELEASE`, injected at build time by `vite.config.ts`, and the
server reads `VERCEL_GIT_COMMIT_SHA` at runtime, so release health and
"resolved in next release" work. TRAP: `sentryReactRouter` forwards the
`release` option as an OBJECT (`release: { name }`); a bare string is
spread into char indices and the name is silently lost (`--release
undefined`). Without the token, every build warns "No auth token provided"
and stack traces arrive without source maps (errors still report; the DSN
works).
`app/lib/errors.server.ts` holds the capture helpers: `captureError`
(console.error + Sentry.captureException), `captureErrorOnce` (deduped by
error identity, for the SSR double-report paths), and `captureWarning`
(console.warn + Sentry.captureMessage, for recoverable failures the app
absorbs, e.g. an outbound reply email that failed to send; the FastMail
send path uses it). All three are no-ops until the server
SDK inits, so they're safe to call unconditionally.

`VERCEL_PROTECTION_BYPASS` (optional) is the project's Protection Bypass for
Automation secret (Vercel → Settings → Security). Deployment URLs are behind
Vercel SSO protection, so both `scripts/deploy` and the smoke workflow send it
as the `x-vercel-protection-bypass` header to reach the fresh deployment while
Deployment Checks hold it from the production alias. Set it as a Vercel
production env var (for the deploy script) and as a GitHub Actions secret.
