# Agent guide — Expense

Personal expense tracker (receipts + mileage). React Router v8 framework mode,
Tailwind v4. Storage is Postgres-only (required), accessed through **Prisma**
(schema in `prisma/schema.prisma` — the single source of truth; client in
`app/lib/prisma.server.ts`). Domain reads/writes go through the per-domain
modules in `app/lib/db/` (accounts, expenses, reports, categories, settings,
oauth, inbound, reconcile — see the table below); receipt images via
`app/lib/images.server.ts` (Postgres BYTEA — prod and local both; no separate
storage service). There is **no runtime DDL** — schema changes go through Prisma
(`prisma migrate dev` locally, `pnpm db:push` on deploy). Dev/tests run on local
Postgres (`expense_dev`/`expense_test`) only. Deployed to **Vercel** with a
**Supabase** Postgres database (project ref `ldtqjzfftjbzcvgktgbt`, region
us-west-2; GitHub push to `main` auto-deploys).

## Database connections (Supabase)

Supabase direct connections (`db.<ref>.supabase.co:5432`) are **IPv6-only** for
new projects — this network has no working IPv6 route, and Vercel functions
should not rely on it either. Use the **Supavisor pooler** on
`aws-1-us-west-2.pooler.supabase.com` (IPv4):

- **`DATABASE_URL` (runtime) — transaction-mode pooler, port 6543.** Every
  Vercel serverless instance opens its own Prisma pool, so session mode (one
  dedicated backend connection per pooled client) exhausted the pooler cap under
  the image-heavy list page. Transaction mode shares one small backend pool
  across all clients — connections are checked out only for the duration of a
  query/transaction, so serverless instances stop holding dedicated slots.
  Supavisor's transaction mode handles the extended protocol / prepared
  statements and Prisma's batch + interactive transactions (verified against
  prod with the PrismaPg adapter).
  **Both pooler URLs must carry `?sslmode=no-verify`.** The pooler requires
  TLS (rejects plaintext with `(ESSLREQUIRED)`), but its cert is signed by
  Supabase's private CA (`Supabase Intermediate 2021 CA`), and pg >= 8.13
  verifies the chain for `sslmode=require`/`verify-full` (fails with
  "self-signed certificate"). `no-verify` = encrypt-only, which is the
  long-standing behavior. A URL pasted from the Supabase dashboard's copy
  button has NO sslmode param — every DB call then fails `(ESSLREQUIRED)`;
  this is how prod broke in Aug 2026 (URL re-pasted without the param).
- **`DATABASE_URL_UNPOOLED` (psql/prisma DDL in `scripts/deploy`,
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
(see incident below). Temporary fallback if transaction mode misbehaves: flip
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

## Commands

```bash
pnpm dev             # dev server
pnpm check           # prisma generate + react-router typegen + vp check
pnpm build           # production build
pnpm build:prisma    # prisma generate (writes prisma/generated, gitignored)
pnpm start           # serve production build (port 3000)
pnpm db:push         # sync the dev database to schema.prisma
pnpm db:migrate      # apply prisma/migrations (deploy)
pnpm setup:push      # FastMail push setup: generate keys, create the push subscription
pnpm test            # force-resets expense_test schema + 91 tests (incl. image blobs)
./scripts/deploy [--skip-tests]  # check + tests + prod db sync + vercel deploy --prod + open site
./scripts/clone              # clone the prod (Supabase) DB into the local dev DB (prisma/backup.sql), then sync the local schema to the latest (prisma db push) and reconcile the migration history (prod applies schema with db push, which never records migrations — the clone marks the dump's missing migrations as applied)
# NOTE: prod runs on Vercel (Supabase Postgres) — `./scripts/deploy` handles
# schema sync via `vercel env pull` + `prisma db push`, then CLI-deploys and
# opens the site. `git push origin main` also auto-deploys: the CI workflow's
# `migrate-db` job passes the prod DDL URL via the `DATABASE_URL_UNPOOLED`
# GitHub secret and runs `prisma db push`. It does NOT use the Vercel CLI: the
# `VERCEL_TOKEN` secret can list deployments (smoke job) but is denied on the
# project-settings/team endpoints `vercel env pull` needs (403
# PROJECT_UNAUTHORIZED), so the DDL URL is passed directly instead. DEPLOY
# ORDERING CONTRACT: secretlint → check & test → migrate prod DB →
# pdf-ocr-smoke. The smoke
# check (CI `pdf-ocr-smoke`, and the post-deploy /api/smoke curl) runs the
# deployed bundle against the prod schema and fails on any schema change if the
# migration was skipped. Migrations must NEVER run before the test suite:
# `scripts/deploy` runs `pnpm test` before calling migrate-prod, and the CI
# `migrate-db` job needs both `check` and `test` (which run in parallel, after
# the secretlint gate). The workflow's job timeouts bound the whole run (~10m
# ceiling — secretlint 2m + max(check 2m, test 4m) + migrate 2m + smoke 2m —
# typical ~5m). Schema changes: `prisma migrate
# dev` locally, then run deploy to sync prod (migration history exists since Jul
# 2026). Note: `vercel env pull` merges with the existing file, so stale local
# entries (e.g. leftover `PGHOST`) survive — delete `.env.prod.pull`/
# `.env.prod` before pulling if they cause trouble.
```

Run `pnpm check` before committing.

## Secrets

Env load order: `process.env` (Vercel/inline) → local `.env` (via dotenv in
`app/lib/env.ts`). `DATABASE_URL` is required — no file fallback. Dev/test use
`.env` (`DATABASE_URL`, and auth: `APP_EMAIL`, `APP_PASSWORD`,
`SESSION_SECRET`); prod uses the Vercel dashboard (`DATABASE_URL`, plus the same
three auth vars). Pull prod env with `pnpx vercel env pull
--environment=production .env.prod` (use `DATABASE_URL_UNPOOLED` for psql/prisma
DDL; both point at the Supabase session pooler — see “Database connections
(Supabase)” above). Tests hardcode local services (`expense_test`, image blobs
in Postgres), not `.env`.

Receipts-by-email adds optional vars: `RESEND_API_KEY`,
`INBOUND_EMAIL_WEBHOOK_SECRET`, `INBOUND_EMAIL_ADDRESS`, `DEEPSEEK_API_KEY`,
`DEEPSEEK_MODEL` (default `deepseek-v4-flash`), `RECEIPT_OCR_MODE` (`auto`
default | `deepseek` | `tesseract`). All optional — the webhook route returns
503 when unconfigured and everything else still works.

The **FastMail JMAP push reader** (alternative receipt source — reads
forwarded receipts directly from a FastMail folder and discards them, instead
of the Resend webhook) adds: `FASTMAIL_TOKEN` (JMAP API token — full mail
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
and the FastMail rule/identity must stay in sync with this var. All optional
— when `FASTMAIL_TOKEN`
is unset the push/cron routes 503 and receipts keep flowing through Resend.
When `FASTMAIL_TOKEN` IS set, all outbound email (receipt replies +
verification emails) goes through FastMail JMAP `EmailSubmission/set` (NOT
RFC 8621 `Email/submit` — FastMail rejects it as unknownMethod; `Identity/get`
is likewise gated behind the `urn:ietf:params:jmap:submission` capability)
from `INBOUND_EMAIL_ADDRESS` (identity-matched, falling back to the
account's default identity); the Resend outbound fallback was removed (Aug 2026) — without `FASTMAIL_TOKEN` send permission, outbound emails are
skipped with a warning (logged + Sentry-captured), they never silently fail
in a Resend API call.

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
and Resend send paths both use it). All three are no-ops until the server
SDK inits, so they're safe to call unconditionally.

`VERCEL_PROTECTION_BYPASS` (optional) is the project's Protection Bypass for
Automation secret (Vercel → Settings → Security). Deployment URLs are behind
Vercel SSO protection, so both `scripts/deploy` and the smoke workflow send it
as the `x-vercel-protection-bypass` header to reach the fresh deployment while
Deployment Checks hold it from the production alias. Set it as a Vercel
production env var (for the deploy script) and as a GitHub Actions secret.

## Stack & conventions

- **Routing**: React Router v8, flat file routes in `app/routes/`. `app/routes.ts`
  wires an index + `flatRoutes()`. Loaders/actions are server-only.
- **Types**: import route types from `./+types/<name>`. Path alias `~/*` → `app/*`.
- **State**: Postgres via Prisma (schema.prisma) — accounts, users, expenses,
  reports, categories, settings, mileage_rates, image_blobs, inbound_emails,
  inbound_senders, reconciliation_runs, oauth clients/codes/tokens/consents.
  Required,
  everywhere.
  Never read state on the client; all reads/writes go through the per-domain
  modules in `app/lib/db/` (Prisma queries, scoped
  by `accountId`). `prisma/generated` is the generated client (gitignored,
  produced by `pnpm build:prisma`).
- **MCP (agents)**: `/mcp` (Streamable HTTP) exposes the store to any MCP
  client. Auth is OAuth 2.1 only (authorization-code + PKCE — clients sign
  in with their normal account and approve a consent page; no API keys).
  Settings → Agents & API lists connected apps (name, client id, last used,
  expires) with a per-app remove that revokes all its tokens. Tools:
  capture_receipt (reuses the OCR/DeepSeek pipeline
  - merchant history), log_mileage, list_expenses/expense_summary, report
    create/close/add/export PDF, list_categories/merchants, get_settings,
    reconcile (read-only statement CSV matching). See `docs/mcp.md`.
- **Images**: Postgres BYTEA (`image_blobs` table) — all images live in
  the database; no external storage, no separate service.
  See `app/lib/images.server.ts`.
  **Keys are namespaced per account** (`images/{accountId}/…`) so the same
  filename in two accounts never collides; every
  save/read/rename/delete takes the owning `accountId`. Named
  `YYYY-MM-DD_REPORT_FILE.ext` once a receipt has a date + report;
  otherwise a temp id-based name (renamed on save). Legacy (pre-account)
  keys were migrated once by `initStore`; the one-shot SQL now lives in
  `scripts/migrate-legacy` (also migrates the legacy `settings.duplicateDismissals`
  blob to the `duplicate_dismissals` join table) — run it against any
  pre-2026 database before serving it.
- **Maps**: Leaflet is loaded **dynamically, client-only** (it touches `navigator`
  at load and breaks SSR). Geocoding via Nominatim, routing via OSRM — no API
  keys. See `app/lib/maps.server.ts`.
- **Dark mode**: system-only via `prefers-color-scheme`, no toggle. The
  `@custom-variant dark (&:is(.dark *))` in `app/global.css` is already wired;
  an inline `<script>` in `app/root.tsx` applies `.dark` to `<html>` before
  first paint (FOUC-free) and listens for live OS theme changes. **Every new
  component must add `dark:` variants for all color classes** — background,
  text, border, ring, placeholder, hover, and focus states. Use these
  mappings:
  - Backgrounds: `bg-white` → `dark:bg-gray-800`, `bg-gray-50` →
    `dark:bg-gray-900`, `bg-gray-100` → `dark:bg-gray-700`
  - Text: `text-gray-500` → `dark:text-gray-400`, `text-gray-600` →
    `dark:text-gray-300`, `text-gray-700` → `dark:text-gray-200`,
    `text-gray-800` → `dark:text-gray-100`
  - Borders: `border-gray-100` → `dark:border-gray-800`,
    `border-gray-200` → `dark:border-gray-700`,
    `border-gray-300` → `dark:border-gray-600`
  - Accent backgrounds: `bg-blue-50` → `dark:bg-gray-800`,
    `bg-amber-50` → `dark:bg-amber-950`, `bg-green-50` →
    `dark:bg-green-950`, `bg-red-50` → `dark:bg-red-950`
  - Accent text: `text-blue-600` → `dark:text-blue-400`,
    `text-amber-700` → `dark:text-amber-400`,
    `text-green-700` → `dark:text-green-400`,
    `text-red-600` → `dark:text-red-400`
  - Hover: `hover:bg-gray-100` → `dark:hover:bg-gray-800`,
    `hover:bg-black/5` → `dark:hover:bg-white/5`
  - Focus rings: `focus:ring-blue-500` → `dark:focus:ring-blue-400`,
    `ring-offset-white` → `dark:ring-offset-gray-900`
  - Do NOT use `bg-ink` or `text-ink` in dark mode — `--color-ink` is a
    CSS custom property that resolves to different values per theme.
    Prefer concrete Tailwind colors wherever possible.
  - Shared UI primitives (`Button`, `Input`, `Textarea`, `Select`,
    `Card`, `EmptyState`) already have dark variants. Use them instead of
    raw elements where possible.
- **Validation**: plain helper validators in `app/lib/validation.ts`;
  completeness rules in `app/lib/completeness.ts`. Domain validation is
  Zod-free; the `zod` dependency is used only for MCP tool argument
  schemas in `app/lib/mcp.server.ts`.
- **Code style**: formatting, lint, React, testing, and commit conventions —
  see "Code style" below.

## Code style

Enforced by `pnpm check` (oxfmt + oxlint + tsc via `vp`) unless noted.

### TypeScript

- **Strict mode required** — code must pass `vpr check` (type-aware linting:
  `typeAware: true`, `typeCheck: true`).
- **Prefer interfaces over types** for object shapes (`interface Location`);
  use `type` for unions and aliases (`type Expense = ReceiptExpense | MileageExpense`).
- **No enums** — use string unions (`type ExpenseType = "receipt" | "mileage"`).
- **Avoid `any`** — `typescript/no-explicit-any` warns; narrow with `unknown`.
- **Descriptive names** — auxiliary-verb booleans: `isComplete`, `hasAmount`.
- **No classes** — pure functions; the only classes are error subclasses
  (`class DeepSeekError extends Error`).
- **Early returns** — handle errors/guards at the top of functions, avoid deep nesting.

### Imports & organization

- **Path alias** `~/*` → `app/*` (`~/test` → `test`); relative imports only
  for same-directory siblings (`./x`), never `../` — e.g.
  `import { Editor } from "./expense.$id"`.
- **Group imports by origin**: `node:` builtins → external packages → `~/*` →
  relative — with `./+types/<name>` last where present.
- **`import type`** for type-only imports.
- **No barrel files** — import from the concrete module.
- **File structure**: exports at top, then module-level helpers/constants,
  then types (see `app/lib/db/accounts.ts`, `inbound-email.server.ts`).

### Formatting (oxfmt via `vp`)

- Double quotes, 2-space indent, 80-col print width, semicolons
  (`vite.config.ts` fmt block: `printWidth: 80`, `tabWidth: 2`,
  `singleQuote: false`, `semi: true`).
- Never hand-wrap or hand-sort — run `pnpm check` (`vp check --fix` also runs
  on staged files).

### React & components

- **Functional components only** — no class components.
- **Named exports** for shared components (`export function Button`); route
  modules `export default` the page component.
- **Component naming**: PascalCase; files in `app/components/` (`ui/` for
  primitives).
- **Hooks at top level** — `react-hooks/rules-of-hooks` errors,
  `exhaustive-deps` warns.
- **No `dangerouslySetInnerHTML`** — `react/no-danger` errors; escape
  untrusted text with `escapeHtml` (`app/lib/escape.ts`).

### Accessibility

- **Icons must carry `aria-hidden="true"`.** Every lucide-react icon is
  decorative when paired with visible text; the few standalone icon buttons
  already have `aria-label` on the `<button>` which overrides the hidden
  SVG. A new icon without `aria-hidden` will be read aloud by screen readers
  as raw SVG markup.
- **Inputs must set `aria-invalid={true}` when `invalid` is true.** The
  shared `Input` and `Textarea` components do this automatically — pass
  the `invalid` prop and `aria-invalid` follows. When wiring validation
  errors outside those components, pair the error message element with
  `aria-describedby` on the input.
- **Focus must be managed.** Dialogs and overlays (`ConfirmDialog`,
  `Lightbox`) trap focus on open and restore it on close. Any new overlay
  must follow the same pattern: capture `document.activeElement` before
  mounting, focus the least-destructive action on open, wrap Tab/Shift+Tab,
  and close on Escape (restoring the captured element).
- **Color contrast must meet WCAG AA.** The baseline is `text-gray-500`
  (#6b7280) on white backgrounds (4.6:1); `text-gray-400` (#9ca3af) is
  ~2.6:1 and fails. Placeholder text, helper text, and functional icons
  must use at least `text-gray-500`. The `text-amber-700` incomplete badge
  should be checked on `bg-amber-50`.
- **Touch targets must be ≥ 24×24 CSS pixels** (WCAG 2.2 AA). Small
  icon-only buttons (clear-search X, remove-stop X) need at least `p-1`
  on the `<button>` to reach the minimum.
- **Every page must have a meaningful `<title>`.** Route modules must export
  a `meta` function that sets a descriptive title — not just the app name.
  The expense editor includes the merchant + amount (or mileage type +
  distance); other routes should follow.
- **Use landmark elements and heading hierarchy.** Every page has a
  `<main id="main-content">` (the skip-link target) and exactly one `<h1>`.
  Sections get `<h2>` (at minimum `sr-only` if the visual design omits
  them). The `<header>` and `<nav>` elements are implicit landmarks.
- **Keyboard shortcuts must exist for primary actions.** The editor already
  binds Enter → Save and Escape → Cancel (guarded against textareas and
  datalist inputs). Any new editor or modal must follow the same contract.
- **Respect `prefers-reduced-motion`.** `global.css` already kills all
  animations/transitions when the user requests reduced motion.
  `scrollIntoView({ behavior: "smooth" })` guards against it too — any
  new animation or smooth scroll must do the same.
- **Tests must use accessible selectors.** Prefer `getByRole`,
  `getByLabel`, `getByPlaceholder`, and `getByText` over CSS class
  selectors or `.locator("button")` — this keeps tests aligned with the
  accessible name contract. The a11y smoke tests live in
  `test/a11y.test.ts` and cover skip-link, page titles, keyboard
  shortcuts, focus trapping, `aria-invalid`, `aria-pressed`, and
  `aria-expanded`.

### Conditionals & logic

- **Prefer early returns** over nested if/else.
- **No `forEach`** — use `for...of`, `.map()`, `.filter()`, `.flatMap()`
  (`unicorn/no-array-for-each` warns, `unicorn/prefer-array-flat-map` errors).

### Error handling & validation

- **Validate at the boundary** — plain helper validators in
  `app/lib/validation.ts`, completeness rules in `app/lib/completeness.ts`.
- Handle errors first (guard clauses); return early on bad input
  (`unknownIntent()` → 400).
- Catch at boundaries and log with `console.warn`/`console.error` (see Logging).

### Logging

- **No `console.log`** — `no-console` errors; allowed methods are `.assert`,
  `.error`, `.info`, `.warn`.
- Prefix runtime logs with a context tag: `console.warn("[draft-upload] …")`,
  `console.error("[inbound] …")`.

### Security

- **scrypt** for password hashing (`app/lib/passwords.ts`); never store
  plaintext.
- Escape untrusted text before embedding in HTML/SVG/email (`escapeHtml`);
  `react/no-danger` is an error.
- Sanitize free-text filenames (`sanitizeFilenamePart`).
- **Authenticated responses must not be shared-cacheable.** Receipt images
  use `Cache-Control: private` (browser-only) — never flip them back to
  `public` for perceived performance. Every HTML document denies framing
  (`X-Frame-Options: DENY` + `Content-Security-Policy: frame-ancestors
'none'`, set in the `app/root.tsx` loader headers, merged into all matched
  routes — covers the OAuth consent page). HSTS comes from Vercel, no
  app header needed.
- Server-side fetches of untrusted URLs (MCP `capture_receipt` url, `<img
src>` in forwarded email HTML) go through `fetchPublicUrl`
  (`app/lib/ssrf.server.ts`) — literal + DNS-resolved private-address
  checks, re-checked on every redirect hop. Never raw-fetch an
  attacker-controlled URL.

### Testing (`vpr test` + Playwright)

- Test files live in `test/*.test.ts` — NOT alongside source.
- To unit-test a route action directly (no browser), type the args object as
  `Parameters<typeof action>[0]` — the generated `+types/<route>` module
  only resolves via tsconfig `rootDirs` for relative imports inside `app/`,
  so `~/routes/+types/…` does NOT resolve from `test/`. See
  `test/api-inbound-push.test.ts` for the pattern (mock the route's
  network-facing collaborators with `vi.mock`, keep real decryption).
- The FastMail flows are unit-tested offline: `test/fastmail-send.test.ts`
  drives `sendEmailViaJmap` through its injectable `JmapSendDeps`
  (identity match → upload → import → submit; the submit step retries once
  on a transient failure with the same email id; failures return false),
  and `test/api-inbound-push.test.ts` forges RFC 8291 payloads encrypted to
  throwaway keys from a `vi.mock`'d `~/lib/env` (generated lazily in
  getters — `vi.hoisted` runs before `node:crypto` initializes), so the
  decrypt cases run everywhere, CI included (PushVerification echo,
  StateChange drain, unknown type, undecryptable body).
- Browser tests via Playwright (vitest provider); helpers in `test/helpers/`
  (`launchBrowser.ts` → `goto`/`signIn`, `seedTestData.ts` → `testPrisma` +
  seeded constants, `launchServer.ts`).
- Use `testPrisma` for DB assertions; seed with the account/user constants.
- Requires local Postgres (`expense_test`); the schema is force-reset each run.
- **The suite runs on a pinned clock** — `2026-07-15T12:00:00Z`, ticking in
  real time from that base, shared by the test process, browser pages, and
  the test server (`test/helpers/frozen-time.ts`, `pinned-time.ts`,
  `pinned-clock.mjs`, `launchBrowser.ts::freezePageClock`). Consequence for
  test writers:
  - `Date.now()` / `new Date()` return pinned base + elapsed — NEVER use them
    for real-time deadlines or polling loops (they hang); use
    `performance.now()` (see `launchServer.ts`, `auth.test.ts` polling).
  - Derive webhook timestamps (`svix-timestamp`) from `Date.now()`, not
    absolute wall-clock values, so they stay inside the server's replay guard.
  - The browser pin is a `context.addInitScript` Date override — NOT
    Playwright's `page.clock` (`setFixedTime` never fires page timers;
    `install()` doesn't survive navigations).
  - The server pin loads via `NODE_OPTIONS=--import ./test/helpers/pinned-clock.mjs`
    in `launchServer.ts`; keep the pinned instant in sync across all files.
  - The test server blanks `PUBLIC_URL` in its env (like the live-service
    keys) so the OAuth metadata issuer follows the request/forwarded origin.
    A `.env` `PUBLIC_URL` (set for the FastMail push URL) changed the issuer
    to the prod origin locally and prompted a bad hardcode in `531e814` —
    keep OAuth test expectations origin-derived, never hardcoded.

### Git commits

- **Conventional commits**, lowercase type, optional scope:
  `type(scope): subject` — e.g. `feat(analytics): …`, `fix(monetary): …`,
  `refactor(db): …`. **No emoji prefixes in this repo.**
- Imperative mood, atomic commits, explain why not just what.
- Run `pnpm check` before committing.

## Key files

| File                                    | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/routes/_index.tsx`                 | Main list, add buttons, paste/upload image.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `app/routes/expense.$id.tsx`            | Receipt + mileage editor (save/cancel/delete).                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `app/routes/expense.$id.image.ts`       | Serve / replace / delete receipt image.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `app/routes/api.route.ts`               | Recompute mileage distance + amount.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `app/routes/export.*`                   | PDF per report + ZIP of everything.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `app/routes/mcp.ts`                     | MCP endpoint (Streamable HTTP). OAuth bearer token → account; dual-era and fully stateless (2025-era handshake + 2026-07-28 `_meta` envelope, no sessions). `maxDuration: 60`.                                                                                                                                                                                                                                                                                            |
| `app/lib/mcp.server.ts`                 | MCP server: dual-era stateless handler (`createMcpHandler` + a hand-wired legacy leg), 13 tools + statement reconciliation matcher. `capture_receipt` runs the app's own extraction pipeline. OAuth access tokens only.                                                                                                                                                                                                                                                   |
| `app/lib/oauth.server.ts`               | OAuth authorization server: PKCE (S256), token/code hashing, RFC 8414 metadata, refresh rotation, client auth.                                                                                                                                                                                                                                                                                                                                                            |
| `app/routes/oauth.authorize.tsx`        | Consent page (GET) + approve/deny (POST). Also `oauth.token.ts`, `oauth.register.ts`, `oauth.revoke.ts`, and the `[.]well-known.*` discovery routes.                                                                                                                                                                                                                                                                                                                      |
| `app/lib/report-pdf.server.ts`          | Report PDF builder — shared by the web export and the MCP `export_report` tool. Mileage rows show type · rate, distance + route addresses; a "Receipts & routes" appendix embeds a real route map per mileage trip with date/mileage/amount beside it (`app/lib/route-map.server.ts`).                                                                                                                                                                                    |
| `app/routes/settings.tsx`               | Reports, categories, current IRS mileage rates (one line, from the master table), start/end location, receipts-by-email sender, Agents & API (MCP) tokens.                                                                                                                                                                                                                                                                                                                |
| `app/routes/reconcile.tsx`              | Credit-card statement reconciliation (/reconcile): upload → parse+match → three buckets (auto-matched / needs review / not matched) → complete in one transaction. Draft runs persist decisions so the session survives reloads; re-uploading the same file resumes or refuses. See `app/lib/reconcile.server.ts`.                                                                                                                                                        |
| `app/lib/reconcile.server.ts`           | Shared statement parser + matcher (CSV with signed or Debit/Credit amounts, QFX/OFX with FITID, PDF text lines) and the confidence-tiered matching rules (date ±2d, amount $0.50/1%, merchant-token overlap, refund rows never auto-match). Used by the web flow AND the MCP `reconcile` tool. Pure — never writes.                                                                                                                                                       |
| `app/routes/api.inbound-email.ts`       | Resend inbound webhook (public, signature-verified; `maxDuration: 60`).                                                                                                                                                                                                                                                                                                                                                                                                   |
| `app/routes/api.inbound-push.ts`        | FastMail JMAP push webhook (public — RFC 8291-decrypted body is the auth; `maxDuration: 60`). PushVerification echo + StateChange → drain the Receipts folder.                                                                                                                                                                                                                                                                                                            |
| `app/routes/api.inbound-cron.ts`        | Daily cron (CRON_SECRET-gated): renew the ~30-day push subscription + drain the Receipts folder (catch-up for missed pushes). Wired in `vercel.json`.                                                                                                                                                                                                                                                                                                                     |
| `app/lib/fastmail.server.ts`            | Minimal FastMail JMAP client: session, `Email/query` on the Receipts folder (`inMailbox` + `notKeyword`), raw RFC 5322 download, `Email/set` destroy, push-subscription get/create/destroy. Ported from the inbox project (incl. its gotchas: `$`-keywords, per-object set failures surface as throws).                                                                                                                                                                   |
| `app/lib/fastmail-push.server.ts`       | RFC 8291 (Web Push) keys, push-body decryption (`http_ece`), `ensureSubscription` (renews within 7 days of expiry). Decryption success is the push route's auth.                                                                                                                                                                                                                                                                                                          |
| `app/lib/inbound-fastmail.server.ts`    | FastMail-backed `InboundDeps` (MIME bridge via postal-mime — fetch/list/download collaborators; JMAP email id = idempotency key) + `processUnprocessedReceipts` (mark `$receipt-processed` → run `processInboundEvent` → destroy on non-error). Reuses the Resend-era pipeline unchanged.                                                                                                                                                                                 |
| `scripts/setup-push.ts`                 | One-time FastMail push setup (`pnpm setup:push`): generate `PUSH_PRIVATE_KEY`/`PUSH_AUTH`, write them to `.env`, print the `vercel env add` commands, create the push subscription at `<PUBLIC_URL>/api/inbound-push`. Run once before deploy and again after (so the PushVerification handshake reaches the live webhook).                                                                                                                                               |
| `app/routes/api.smoke.ts`               | Post-deploy PDF+OCR+MCP health check (secret-gated GET `/api/smoke`; `maxDuration: 60`). Runs the receipt pipeline (pdfkit→pdfjs→tesseract) plus a full MCP round trip (`runMcpSmoke`) in the deployed bundle. `scripts/deploy` curls it after every deploy and fails the deploy if the pipeline breaks in the serverless bundle.                                                                                                                                         |
| `app/routes/login.tsx`                  | Sign in / create account / join by invite code.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `app/routes/sign-out.ts`                | Destroys the session, redirects to /login.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `app/lib/editor.server.ts`              | Editor context shared by the /expense/:id and /expense/new loaders (reports, categories, merchants, home, IRS rate table).                                                                                                                                                                                                                                                                                                                                                |
| `app/lib/auth.server.ts`                | Auth: session storage, `requireUser`, login/signup.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `app/lib/passwords.ts`                  | scrypt hashing + invite-code generation.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `app/lib/prisma.server.ts`              | Prisma client singleton (PrismaPg adapter).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `app/lib/inbound-email.server.ts`       | Receipt-by-email pipeline: signature, date, attachment pick, expense create, replies.                                                                                                                                                                                                                                                                                                                                                                                     |
| `app/lib/receipt-ai.server.ts`          | DeepSeek extraction client (text + vision attempt, JSON mode).                                                                                                                                                                                                                                                                                                                                                                                                            |
| `app/lib/receipt-ocr.server.ts`         | OCR (tesseract fallback) + PDF text/render (pdfjs + @napi-rs/canvas).                                                                                                                                                                                                                                                                                                                                                                                                     |
| `app/lib/receipt-render.server.ts`      | HTML→text + text→PNG receipt image (resvg + bundled JetBrains Mono); fallback renderer.                                                                                                                                                                                                                                                                                                                                                                                   |
| `app/lib/email-render.server.ts`        | Render email bodies → PNG with real headless Chromium (HTML + plain-text column; puppeteer-core + @sparticuz/chromium on Vercel, Playwright Chromium locally; RENDER_BROWSER=local/sparticuz/none overrides).                                                                                                                                                                                                                                                             |
| `app/lib/reply.server.ts`               | Failure/partial reply emails via Resend.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `app/lib/sender-verification.server.ts` | Builds + sends the receipts-by-email verification email (from `INBOUND_EMAIL_ADDRESS`; skips with a warning when Resend is unconfigured). Token lifecycle lives in `app/lib/db/inbound.ts` (`addInboundSender` / `verifyInboundSenderAddress` / `ensureInboundSenderForUser`).                                                                                                                                                                                            |
| `app/data/default-categories.csv`       | Default categories seeded for every new account (IRS Schedule C, Part II lines 8–27a; one name per row, no header, comma-containing names quoted). Loaded at build time by `app/lib/default-categories.server.ts` (Vite `?raw` import) — edit the CSV to change what new accounts get seeded with.                                                                                                                                                                        |
| `prisma/schema.prisma`                  | Single schema source of truth (15 models).                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `prisma/migrations/0_init`              | Baseline migration (fresh DBs via `prisma migrate`).                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `scripts/clone`                         | Clone prod (Supabase) DB into the local dev DB: dump `DATABASE_URL_UNPOOLED` to `prisma/backup.sql`, drop/recreate the local schema, restore, then sync the local schema to the latest (`prisma db push`) and mark the dump's missing migrations as applied — prod applies schema via db push, which never records migrations, so a raw dump would report them pending and the next `migrate dev` would try to re-apply them.                                             |
| `scripts/import-expensify.ts`           | API-driven Expensify import: effective SmartScan fields + receipt images (needs `EXPENSIFY_PARTNER_USER_ID`/`_SECRET`; receipts are login-gated — `--cookie` or `--receipts-dir`).                                                                                                                                                                                                                                                                                        |
| `app/lib/db/`                           | Postgres backend split by domain: `seed.ts` (initStore + IRS mileage-rate master table), `accounts.ts` (accounts/users), `expenses.ts`, `reports.ts`, `categories.ts`, `settings.ts`, `oauth.ts`, `inbound.ts`, `reconcile.ts`, plus `names.ts` (shared report/category add/rename), `extraction-context.ts`, and `shared.ts` (TTL cache, verification constants). `expenseData`/`deleteReceiptImages` are exported from `expenses.ts` for the reconcile/reports modules. |
| `app/lib/maps.server.ts`                | Geocode + route (Nominatim/OSRM).                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `app/lib/route-map.server.ts`           | Real route map for report PDFs, same look as the editor: Carto Positron light tiles fetched server-side (cached, descriptive User-Agent), white-cased blue route + dashed gray return + numbered stop bubbles, rendered with resvg + bundled JetBrains Mono. Falls back to a schematic drawing when the tile server is unreachable; `tileFetcher` injectable for offline tests.                                                                                           |
| `app/lib/mileage-rates.ts`              | IRS rate lookup + amount math: `mileageRateFor(entries, date, type)`, `currentMileageRates(entries, date)`, `mileageAmount(distance, rate)` (exact half-up cents), `formatRate`, `MILEAGE_TYPES`. Pure — shared by the editor (client) and server.                                                                                                                                                                                                                        |
| `app/data/mileage-rates.ts`             | The IRS standard rates seed for the global `mileage_rates` master table (synced by `initStore` when the seed differs) — edit this to update rates (snapshot: `docs/2026-08-04 IRS standard mileage rates.md`).                                                                                                                                                                                                                                                            |

## Gotchas

- **Known dependency advisory (unfixed by design)**: `deepmerge-ts` 7.1.5
  (GHSA-ggr8-5vv4-36mx, stack-exhaustion DoS) comes transitively via
  `@prisma/config` (Prisma CLI config merge). Prisma 7.9.1 is current and
  upstream hasn't bumped it; practical risk is ~zero (only exploitable by
  someone who can already write the repo's config files). If `npm audit`
  flags it again, fix via `pnpm.overrides: { "deepmerge-ts": "^8.0.0" }`
  and verify `prisma db push`/migrate still work.

- **Completeness (the "Incomplete" badge)**: a receipt is incomplete when
  missing date, amount, merchant, category, or report — the receipt image is
  NOT a factor; a mileage expense additionally needs 2+ route addresses
  (distance/amount are calculated from the route) and has no merchant field.
  Shared `isComplete` in `app/lib/completeness.ts`, display-only (editor badge
  - home list) — no server-side save gate.

- **Pooler caps and serverless pools**: the Supavisor poolers cap total
  connections (session pooler: `pool_size: 40`, max 80% of the DB's
  `max_connections`, which is 60 on the current compute). Every Vercel
  serverless instance opens its own Prisma pool, so a burst of concurrent DB
  requests (the image-heavy list page) can exhaust the cap and every DB call
  500s with `(EMAXCONNSESSION) max clients reached in session mode`. The
  runtime `DATABASE_URL` therefore uses the **transaction-mode pooler (port 6543)**, which shares one backend pool across all clients (see "Database
  connections (Supabase)"); session mode is only used for DDL
  (`DATABASE_URL_UNPOOLED`). `app/lib/prisma.server.ts` still keeps the
  per-instance pool small (`max: 2`, 4s idle release) and `findUserById`
  caches lookups for 30s. If 500s reappear under load, check the pooler
  sizes in the Supabase dashboard and Sentry for `EMAXCONNSESSION` /
  `EMAXCONN`. **Never raise `pool_size` above 80% of `max_connections`**
  (see the 2026-08-16 incident in "Database connections (Supabase)").

- **Auth & accounts**: multi-user access control with account-level sharing.
  Users live in Postgres (`users`, `accounts`); every expense, report,
  category, setting, and mileage row is scoped by `accountId`. Users in the
  same account share everything; other accounts are fully isolated (all
  reads and writes are scoped — see `app/lib/db/`).
  - Sign in with email/password (scrypt-hashed in `users.passwordHash`);
    the email is the login name — stored lowercase, unique, format-
    validated at signup/join (`isEmail` in `app/lib/validation.ts`).
  - Signup creates a new account; joining uses the account's invite code
    (shown in Settings, regenerable). Session = signed HttpOnly cookie
    (`SESSION_SECRET`, 30-day max age).
  - **Email verification gates sign-in**: signup/join create a _pending_
    account and email a single-use verification link (`/verify-email?token=`,
    sha256 of the token at rest on `users.verificationTokenHash`, 7-day TTL,
    resend button on the login page, rate-limited to once a day) — the user
    can't sign in until it's clicked (`login` throws EmailNotVerifiedError).
    Re-signing up with the same email while the account is still unverified
    deletes the throwaway account and its old link (`deleteUnverifiedUser`)
    and starts fresh. Users created before this requirement (and the
    APP_EMAIL bootstrap user) are grandfathered as verified (`emailVerifiedAt`
    backfilled by the migration / `scripts/migrate-prod`).
  - **Bootstrap**: on an empty database, the first account + user are
    created from `APP_EMAIL`/`APP_PASSWORD` (fail-closed if missing). On
    existing pre-email databases, `initStore` backfills the bootstrap
    (oldest) user's login from `APP_EMAIL` when their stored email is not
    a valid address (legacy username-era rows).
    Single-user era rows are adopted into that account automatically. This
    is app-side data seeding (`initStore` in `app/lib/db/seed.ts`, memoized per
    process) — the SCHEMA itself is managed by Prisma (no runtime DDL).
  - Every loader/action calls `requireUser(request)` and passes
    `user.accountId` to the store; the root loader guards all routes.
  - Tests seed two accounts + three users; `launchBrowser.ts` signs in as
    `testuser`; `test/auth.test.ts` covers login, signup, invite-code join,
    sign-out, and cross-account isolation.
- Tests and dev require local Postgres up (`brew services start postgresql@18`);
  without it the suite fails to connect. `pnpm test` uses `expense_test`.
  No MinIO/other services needed — images live in Postgres.
- `prisma/backup.sql` (the `./scripts/clone` dump) is ~300MB and must stay out
  of Vercel uploads — `.vercelignore` excludes it (and `backup-*.sql`); don't
  remove those entries or deploys fail on the 100MB upload limit.
- When renaming a report, expenses update but image files are **not** auto-renamed
  (they keep their old convention name). Re-saving each receipt rewrites the name.
- `vpr check` excludes `vite.config.ts` from tsgolint (recursion limits); tsc
  still type-checks it.
- **PDF/OCR can't be fully verified locally** — local tests run against
  node_modules, where every file exists; Vercel's dependency tracer is what
  drops pdf.worker.mjs / tesseract wasm and breaks PDF/OCR in production.
  Real coverage: `test/pdf-ocr.test.ts` (text extraction + rasterization in
  `pnpm test`; tesseract round-trip opt-in via `RUN_OCR_TESTS=1`, on in CI)
  and the smoke check (`/api/smoke`, gated by `SMOKE_TEST_SECRET`), which
  runs in the deployed serverless bundle — `scripts/deploy` curls it after
  CLI deploys, and `.github/workflows/deployment-smoke.yml` runs it on every
  push to `main`. The workflow: `secretlint` runs first and gates the whole
  pipeline, then `check` + `test` run in parallel, then
  `migrate-db` (runs `./scripts/migrate-prod --ci` against prod via the
  `DATABASE_URL_UNPOOLED` GitHub secret, only after tests pass — never
  before) → `pdf-ocr-smoke`. The smoke job fails fast when
  CI or the migration fails, so a broken build or an unmigrated schema never
  reports a passing smoke check. Job timeouts (2/2/4/1/2 minutes) bound the
  whole run to a ~10m ceiling; typical runs are ~5m.
  **Deployment Checks gate: REMOVED (Aug 2026).** Production promotion is no
  longer gated on a Vercel Deployment Check — the alias follows the latest
  READY production deployment automatically. The gate broke twice: a stale
  required check name ("Check & Test" — split into separate "Check" +
  "Test" jobs in 6037bcb, leaving Vercel waiting on a check-run that never
  existed, so every deployment's `deployment-alias` check stayed pending
  forever) kept the alias frozen on a pre-migration build for ~23h (P2021
  500s), then kept newer deployments un-promoted entirely. The smoke check
  still runs and fails loudly in CI (now also reporting whether the server
  Sentry SDK initialized in the deployed bundle); it just doesn't block the
  alias. To inspect/re-add checks: `vercel project checks` /
  `vercel project checks remove <id>` (API: GET/POST/DELETE
  `/v2/projects/…/checks`); the Vercel dashboard path is Settings → Build &
  Deployment → Deployment Checks. Requires `VERCEL_TOKEN`,
  `VERCEL_PROJECT_ID`, `VERCEL_ORG_ID` (team id, `team_…`), and
  `SMOKE_TEST_SECRET` GitHub secrets. The job name is the check name — keep
  it stable.
- **Reconciliation**: `/reconcile` matches an uploaded credit-card statement
  (CSV / QFX/OFX / PDF) against the account's receipt expenses. The matcher
  (`app/lib/reconcile.server.ts`) only considers receipt expenses with a
  date + non-zero amount that are **not already reconciled** (mileage is
  never a card transaction); date tolerance ±2 days, amount within $0.50 /
  1%, and refund/credit/payment lines never auto-match. Exact date+amount+
  a shared merchant token = high-confidence auto match; a close match with
  a different merchant, several candidates, or two lines claiming the same
  expense goes to review where the user picks (or discards). Completing
  marks matched expenses `reconciledAt` and creates any “add as new
  expense” rows (with a rendered statement receipt as the image) in **one
  transaction**; undecided rows are discarded. **Nothing existing is ever
  deleted by reconciliation.** Draft runs store rows/matches/decisions in a
  `reconciliation_runs.data` JSON column (survives reloads); the file sha256
  (`fileHash`) makes re-uploads idempotent (resume the draft, or refuse when
  already completed). `Expense.reconciledAt` is only ever written by the
  reconciliation flow — `expenseData` deliberately omits it so a normal save
  can't wipe the status. The home page shows a green “Reconciled” badge and
  a Reconcile entry point. The MCP `reconcile` tool is the same matcher in
  read-only mode (adds a `needsReview` tier). PDF support is text-layer
  only — scanned statements can't be parsed; the UI says so and points at
  the CSV/QFX export.
- **Receipts by email**: the `/api/inbound-email` route is public (no session) —
  it verifies Resend's webhook (standard Svix/Standard-Webhooks format:
  `svix-id` / `svix-timestamp` / `svix-signature` headers, HMAC-SHA256 of
  `id.timestamp.body` keyed with the base64-decoded `whsec_…` secret,
  replay-guarded) and maps the sender to an account via the `inbound_senders`
  table (one row per account+address, normalized lowercase). Webhook retries
  are idempotent via the `inbound_emails` table.
  - **FastMail direct read (JMAP push) — the primary source; the Resend
    webhook stays as fallback.** A FastMail delivery rule files mail to a
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
    and drains anything a missed push left behind. Same sender-verification
    model as the webhook (From must have a verified `inbound_senders` row);
    failure/confirmation replies are sent FROM the FastMail identity
    (`INBOUND_EMAIL_ADDRESS`, default the account's primary identity) via
    `EmailSubmission/set` (upload raw MIME → `Email/import` into the
    identity's Sent mailbox → submit; the submit step retries once on a
    transient failure, reusing the same email id — the blob/Sent import
    doesn't repeat) when `FASTMAIL_TOKEN` has send
    permission; without it the send is skipped with a warning. The
    self-reply guard compares the incoming
    From against the outbound address, so forwarded replies can't loop.
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
    (The Resend 422 from Aug 2026 — an unknown-sender reply failing with
    `422 Invalid input: expected ""` — is obsolete: the outbound Resend path
    was removed in Aug 2026. `RESEND_API_KEY` now serves the inbound webhook
    only, fetching the received email's content/attachments.)
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
  - Heavy deps (sharp, @resvg/resvg-js, @napi-rs/canvas, tesseract.js,
    pdfjs-dist) are Node-runtime only; native modules must stay external in
    the server build (Vite SSR externalizes node_modules by default).
