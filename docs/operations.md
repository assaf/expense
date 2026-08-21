# Operations — database connections, environment variables, and secrets

Operational reference for the expense app. **Read this before deploying,
touching database configuration, or changing environment variables.**
(AGENTS.md links here — this content moved out of AGENTS.md in Aug 2026.)

---

## Database connections (Supabase)

Supabase direct connections (`db.<ref>.supabase.co:5432`) are **IPv6-only** for
new projects — this network has no working IPv6 route, and Vercel functions
should not rely on it either. Use the **Supavisor pooler** on
`aws-1-us-west-2.pooler.supabase.com` (IPv4):

**`DATABASE_URL` (runtime) — transaction-mode pooler, port 6543.** Every Vercel
serverless instance opens its own Prisma pool, so session mode (one dedicated
backend connection per pooled client) exhausted the pooler cap under the
image-heavy list page. Transaction mode shares one small backend pool across all
clients — connections are checked out only for the duration of a
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
button has NO sslmode param — every DB call then fails `(ESSLREQUIRED)`;
this is how prod broke in Aug 2026 (URL re-pasted without the param).

**`DATABASE_URL_UNPOOLED` (psql/prisma DDL in `scripts/deploy`,
`scripts/migrate-prod` and `scripts/clone`) — session-mode pooler, port 5432.** Migrations and DDL want stable sessions; the session pooler behaves
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
`DATABASE_URL` back to port 5432 — but session mode is strictly worse under
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
`NEON_*`, …) was disconnected in Aug 2026 — don't re-add it. The abandoned Neon
database still exists as a rollback fallback.

---

## Secrets

Env load order: `process.env` (Vercel/inline) → local `.env` (via dotenv in
`app/lib/env.ts`). `DATABASE_URL` is required — no file fallback. Dev/test use
`.env` (`DATABASE_URL`, and auth: `APP_EMAIL`, `APP_PASSWORD`,
`SESSION_SECRET`); prod uses the Vercel dashboard (`DATABASE_URL`, plus the same
three auth vars). Pull prod env with `vercel env pull
--environment=production .env.prod` (use `DATABASE_URL_UNPOOLED` for psql/prisma
DDL; both point at the Supabase session pooler — see “Database connections” below). Tests hardcode local services (`expense_test`, image blobs
in Postgres), not `.env`.

Connected email accounts (auto-import — `docs/email-connections.md`) add
`EMAIL_TOKEN_ENCRYPTION_KEY`: a 32-byte base64 key encrypting users' FastMail API
tokens at rest (AES-256-GCM). Set it in production **before** anyone
connects an account; when unset the Settings section reports the feature
unconfigured and connect returns 503. Losing the key invalidates all stored
tokens — users would need to reconnect (there is no rotation without that
cost, since the tokens must stay decryptable to act on the user's mailbox).
The connected-accounts webhook and renewal cron reuse the push keys
(`PUSH_PRIVATE_KEY`/`PUSH_AUTH`) and `CRON_SECRET`; the push URL is
`<PUBLIC_URL>/api/email-connections-push?c=<connectionId>`, so `PUBLIC_URL`
must be set before the first connection, and the cron runs daily at 13:00
UTC (vercel.json) after the receipts cron at 12:00.

Receipts-by-email adds optional vars: `INBOUND_EMAIL_ADDRESS`,
`DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` (default `deepseek-v4-flash`),
`RECEIPT_OCR_MODE` (`auto`
default | `deepseek` | `tesseract`), and `RECEIPT_VISION_MAX_WIDTH` (default
768, clamped 384–1536 — the downscale applied before the DeepSeek vision
call; see `docs/extraction.md`). All optional — receipts stop arriving when
the FastMail vars are unset, but the app keeps working.

The **FastMail JMAP push reader** (the receipts source — reads
forwarded receipts directly from a FastMail folder and discards them) adds: `FASTMAIL_TOKEN` (JMAP API token — full mail
access, treat as a password; shareable with the inbox project), `PUSH_PRIVATE_KEY`
/ `PUSH_AUTH` (RFC 8291 push keys, generated by `pnpm setup:push`),
`DEVICE_CLIENT_ID` (default `expense-receipts` — keep distinct from other apps'
subscriptions on the same FastMail account), `RECEIPTS_FOLDER` (default
`Receipts`; must match the folder the delivery rule files into), and
`CRON_SECRET` (gates `/api/inbound-cron`). The receipts address is
`INBOUND_EMAIL_ADDRESS` — the single address for the feature: users forward
receipts TO it AND (when FastMail sending is configured) replies/
verifications are sent FROM it (identity-matched, falling back to the
account's default identity). It moved from `receipts@expense.labnotes.org`
(Resend era) to `receipts@labnotes.org` in Aug 2026 — mail to any other
address is not processed (the delivery rule only matches the current one),
and the FastMail rule/identity must stay in sync with this var. **The old
Resend-era address is back in service (Aug 2026): `expense.labnotes.org` is a
FastMail subdomain domain (DNS via Cloudflare — MX
`us1/us2-smtp.messagingengine.com`, DKIM `fm1-3._domainkey`, SPF
`include:spf.messagingengine.com`; the old AWS SES MX
`inbound-smtp.us-east-1.amazonaws.com` and the "FastMail -> Resend ->
Expense" redirect rule were removed), and `receipts@expense.labnotes.org` has
the same "Move to label: Receipts" address action as `receipts@labnotes.org`
— mail to either address lands in the Receipts folder with the original
sender intact (no SRS rewrite, so sender verification works). Note: FastMail
offers no API for rules/aliases/domains (the official MCP server is
read/send-only) — these were configured through the web UI (browser
automation), and Cloudflare DNS through the Cloudflare MCP
(`https://mcp.cloudflare.com`). All optional
— when `FASTMAIL_TOKEN`
is unset the push/cron routes 503. When `FASTMAIL_TOKEN` IS set, all
outbound email (receipt replies +
verification emails) goes through FastMail JMAP `EmailSubmission/set` (NOT
RFC 8621 `Email/submit` — FastMail rejects it as unknownMethod; `Identity/get`
is likewise gated behind the `urn:ietf:params:jmap:submission` capability)
from `INBOUND_EMAIL_ADDRESS` (identity-matched, falling back to the
account's default identity); without `FASTMAIL_TOKEN` send permission, outbound emails are
skipped with a warning (logged + Sentry-captured), they never silently fail.

`SMOKE_TEST_SECRET` (optional) gates the post-deploy PDF/OCR/MCP smoke check at
GET `/api/smoke` (send it in the `x-smoke-secret` header); when unset the route
is disabled (404) and `scripts/deploy` skips the check with a warning. It must
also be set as a **GitHub Actions secret** (same value) for
`.github/workflows/deployment-smoke.yml`.

`PUBLIC_URL` (optional) is the public base URL the OAuth metadata advertises as
its issuer + endpoint origin. Set it when the app sits behind a TLS-terminating
proxy (e.g. a local `https://expense.localhost` setup) so MCP clients see the
public origin instead of the proxy-internal `http://` one — otherwise they
refuse to authenticate ("Protected resource … does not match expected"). Without
it, the request origin is used, honoring `x-forwarded-proto`/`x-forwarded-host`
for http requests. Also used as the base URL for the “Edit this receipt”
link in inbound confirmation emails — set it to the production origin
(`https://expense.labnotes.org`) or those emails have no edit link.

`SENTRY_DSN` + `VITE_SENTRY_DSN` (optional, same DSN value twice) enable Sentry
error monitoring (server runtime + browser build-time respectively; see
`app/entry.server.tsx` / `app/entry.client.tsx` and `app/lib/errors.server.ts`).
Unset `SENTRY_DSN` → the server falls back to its hardcoded DSN; unset
`VITE_SENTRY_DSN` → no browser Sentry. The server SDK inits INSIDE the bundle
(`app/entry.server.tsx` — the module Vercel boots as the function handler),
gated on `VERCEL_ENV=production`, so dev/test/preview never emit to the
production project. Do NOT move server init back into a `NODE_OPTIONS --import`
instrument file: Vercel never runs the `start` script, so that code never
executes in the deployed function (the function config's `environment` is empty;
server errors only ever reached Sentry locally this way). The post-deploy smoke
check reports `Sentry.isInitialized()` and `scripts/smoke-check` warns when a
production deployment boots with it false. Both vars must be set in Vercel;
`VITE_SENTRY_DSN` is baked at build time, `SENTRY_DSN` is read at runtime.
`SENTRY_AUTH_TOKEN` (optional) is read by the vite plugin (`sentryReactRouter`
in `vite.config.ts`) to create releases + upload sourcemaps at build time;
without it every build warns "No auth token provided" and stack traces arrive
without source maps (errors still report — the DSN works). Generate a token in
Sentry → Settings → Auth Tokens with `org:read`, `project:read`,
`project:write`, `project:releases:write` and add it to Vercel.
`app/lib/errors.server.ts` holds the capture helpers — `captureError`
(console.error + Sentry.captureException), `captureErrorOnce` (deduped by
error identity, for the SSR double-report paths), and `captureWarning`
(console.warn + Sentry.captureMessage, for recoverable failures the app
absorbs — e.g. an outbound reply email that failed to send; the FastMail
send path uses it). All three are no-ops until the server
SDK inits, so they're safe to call unconditionally.

`VERCEL_PROTECTION_BYPASS` (optional) is the project's Protection Bypass for
Automation secret (Vercel → Settings → Security). Deployment URLs are behind
Vercel SSO protection, so both `scripts/deploy` and the smoke workflow send it
as the `x-vercel-protection-bypass` header to reach the fresh deployment while
Deployment Checks hold it from the production alias. Set it as a Vercel
production env var (for the deploy script) and as a GitHub Actions secret.
