# Agent guide — Expense

Personal expense tracker (receipts + mileage). React Router v8 framework mode,
Tailwind v4. Storage is Postgres-only (required), accessed through **Prisma**
(schema in `prisma/schema.prisma` — the single source of truth; client in
`app/lib/prisma.server.ts`). Domain reads/writes go through
`app/lib/store.server.ts` → `app/lib/database.ts`; receipt images via
`app/lib/images.server.ts` (Postgres BYTEA — prod
and local both; no separate storage service). There is **no runtime DDL** —
schema changes go through
Prisma (`prisma migrate dev` locally, `pnpm db:push` on deploy).
Dev/tests run on local Postgres (`expense_dev`/`expense_test`) only.
Deployed to **Vercel** with a **Supabase** Postgres database (project ref
`ldtqjzfftjbzcvgktgbt`, region us-west-2; GitHub push to `main` auto-deploys).

## Database connections (Supabase)

Supabase direct connections (`db.<ref>.supabase.co:5432`) are **IPv6-only** for
new projects — this network has no working IPv6 route, and Vercel functions
should not rely on it either. Use the **Supavisor pooler** on
`aws-1-us-west-2.pooler.supabase.com` (IPv4):

- **`DATABASE_URL` (runtime) — transaction-mode pooler, port 6543.** Every
  Vercel serverless instance opens its own Prisma pool, so session mode (one
  dedicated backend connection per pooled client) exhausted the pooler cap
  under the image-heavy list page. Transaction mode shares one small backend
  pool across all clients — connections are checked out only for the duration
  of a query/transaction, so serverless instances stop holding dedicated
  slots. Supavisor's transaction mode handles the extended protocol /
  prepared statements and Prisma's batch + interactive transactions (verified
  against prod with the PrismaPg adapter).
- **`DATABASE_URL_UNPOOLED` (psql/prisma DDL in `scripts/deploy` and
  `scripts/clone`) — session-mode pooler, port 5432.** Migrations and DDL
  want stable sessions; the session pooler behaves like a direct connection.
  Keep it here, not on the transaction pooler.

Pool sizing still matters: `app/lib/prisma.server.ts` keeps the per-instance
pool at `max: 2` with 4s idle release, and `findUserById` caches lookups for
30s (the image-list burst). Pooler `pool_size` is capped at **80% of the
DB's `max_connections`** (48 on the current 60-connection compute); the
session pooler is set to 40. Rollback if anything misbehaves: flip
`DATABASE_URL` back to port 5432.

When setting these in Vercel, add them with `vercel env add … --no-sensitive`:
a _Sensitive_ var pulls back as `[SENSITIVE]` in `vercel env pull`, which
silently breaks `scripts/deploy` (psql then falls back to stale `PG*` env
vars). The old Vercel Neon integration (which set `DATABASE_URL`, `PGHOST`,
`POSTGRES_URL`, `NEON_*`, …) was disconnected in Aug 2026 — don't re-add it.
The abandoned Neon database still exists as a rollback fallback.

## Commands

```bash
pnpm dev             # dev server
pnpm check           # prisma generate + react-router typegen + vp check
pnpm build           # production build
pnpm build:prisma    # prisma generate (writes prisma/generated, gitignored)
pnpm start           # serve production build (port 3000)
pnpm db:push         # sync the dev database to schema.prisma
pnpm db:migrate      # apply prisma/migrations (deploy)
pnpm test            # force-resets expense_test schema + 91 tests (incl. image blobs)
./scripts/deploy [--skip-tests]  # check + tests + prod db sync + vercel deploy --prod + open site
./scripts/clone              # clone the prod (Supabase) DB into the local dev DB (prisma/backup.sql)
# NOTE: prod runs on Vercel (Supabase Postgres) — `./scripts/deploy` handles schema
# sync (preflight + Step 4c rename + db push, via `vercel env pull`), CLI
# deploy, and opening the site. `git push origin main` also auto-deploys.
# Schema changes: `prisma migrate dev` locally, then run deploy to sync prod
# (migration history exists since Jul 2026). When Prisma can't express a
# change as a lossless diff (e.g. column renames), deploy runs an explicit,
# guarded SQL step before db push — mirror the money-column and username→email
# conversions there instead of relying on `--accept-data-loss`.
# Note: `vercel env pull` merges with the existing file, so stale local
# entries (e.g. leftover `PGHOST`) survive — delete `.env.prod.pull`/
# `.env.prod` before pulling if they cause trouble.
```

Run `pnpm check` before committing.

## Secrets

Env load order: `process.env` (Vercel/inline) → local `.env` (via dotenv in
`app/lib/env.ts`). `DATABASE_URL` is required — no file fallback. Dev/test use
`.env` (`DATABASE_URL`, and auth: `APP_EMAIL`,
`APP_PASSWORD`, `SESSION_SECRET`); prod uses the Vercel dashboard
(`DATABASE_URL`, plus the same three auth vars). Pull
prod env with `npx vercel env pull --environment=production .env.prod` (use
`DATABASE_URL_UNPOOLED` for psql/prisma DDL; both point at the Supabase
session pooler — see “Database connections (Supabase)” above). Tests hardcode
local services (`expense_test`, image blobs in Postgres), not `.env`.

Receipts-by-email adds optional vars: `RESEND_API_KEY`, `INBOUND_EMAIL_WEBHOOK_SECRET`,
`INBOUND_EMAIL_ADDRESS`, `DEEPSEEK_API_KEY`,
`DEEPSEEK_MODEL` (default `deepseek-v4-flash`), `RECEIPT_OCR_MODE`
(`auto` default | `deepseek` | `tesseract`). All optional — the webhook route
returns 503 when unconfigured and everything else still works.

`SMOKE_TEST_SECRET` (optional) gates the post-deploy PDF/OCR/MCP smoke
check at GET `/api/smoke` (send it in the `x-smoke-secret` header); when
unset the route is disabled (404) and `scripts/deploy` skips the check with
a warning. It must also be set as a **GitHub Actions secret** (same value)
for `.github/workflows/deployment-smoke.yml`.

`PUBLIC_URL` (optional) is the public base URL the OAuth metadata advertises
as its issuer + endpoint origin. Set it when the app sits behind a
TLS-terminating proxy (e.g. a local `https://expense.localhost` setup) so
MCP clients see the public origin instead of the proxy-internal `http://`
one — otherwise they refuse to authenticate ("Protected resource … does not
match expected"). Without it, the request origin is used, honoring
`x-forwarded-proto`/`x-forwarded-host` for http requests.

`SENTRY_DSN` + `VITE_SENTRY_DSN` (optional, same DSN value twice) enable
Sentry error monitoring (server runtime + browser build-time respectively;
see `app/entry.server.tsx` / `app/entry.client.tsx` and
`app/lib/errors.server.ts`). Unset → Sentry is fully disabled. Both must be
set in Vercel; `VITE_SENTRY_DSN` is baked at build time, `SENTRY_DSN` is
read at runtime.
`.github/workflows/deployment-smoke.yml`.

`VERCEL_PROTECTION_BYPASS` (optional) is the project's Protection Bypass for
Automation secret (Vercel → Settings → Security). Deployment URLs are behind
Vercel SSO protection, so both `scripts/deploy` and the smoke workflow send
it as the `x-vercel-protection-bypass` header to reach the fresh deployment
while Deployment Checks hold it from the production alias. Set it as a Vercel
production env var (for the deploy script) and as a GitHub Actions secret.

## Stack & conventions

- **Routing**: React Router v8, flat file routes in `app/routes/`. `app/routes.ts`
  wires an index + `flatRoutes()`. Loaders/actions are server-only.
- **Types**: import route types from `./+types/<name>`. Path alias `~/*` → `app/*`.
- **State**: Postgres via Prisma (schema.prisma) — accounts, users, expenses,
  reports, categories, settings, mileage, mileage_rates, image_blobs,
  api_tokens. Required,
  everywhere.
  Never read state on the client; all reads/writes go through
  `app/lib/store.server.ts` → `app/lib/database.ts` (Prisma queries, scoped
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
  keys are rewritten automatically by `initStore` (`migrateImageBlobKeys`).
- **Maps**: Leaflet is loaded **dynamically, client-only** (it touches `navigator`
  at load and breaks SSR). Geocoding via Nominatim, routing via OSRM — no API
  keys. See `app/lib/maps.server.ts`.
- **Validation**: plain helper validators in `app/lib/validation.ts`;
  completeness rules in `app/lib/completeness.ts` (no Zod dependency).
- **Code style**: formatting, lint, React, testing, and commit conventions —
  see "Code style" below.

## Code style

Enforced by `pnpm check` (oxfmt + oxlint + tsc via `vp`) unless noted.

### TypeScript

- **Strict mode required** — code must pass `vp check` (type-aware linting:
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
  then types (see `database.ts`, `inbound-email.server.ts`).

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

### Testing (`vp test` + Playwright)

- Test files live in `test/*.test.ts` — NOT alongside source.
- Browser tests via Playwright (vitest provider); helpers in `test/helpers/`
  (`launchBrowser.ts` → `goto`/`signIn`, `seedTestData.ts` → `testPrisma` +
  seeded constants, `launchServer.ts`).
- Use `testPrisma` for DB assertions; seed with the account/user constants.
- Requires local Postgres (`expense_test`); the schema is force-reset each run.

### Git commits

- **Conventional commits**, lowercase type, optional scope:
  `type(scope): subject` — e.g. `feat(analytics): …`, `fix(monetary): …`,
  `refactor(db): …`. **No emoji prefixes in this repo.**
- Imperative mood, atomic commits, explain why not just what.
- Run `pnpm check` before committing.

## Key files

| File                               | Role                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/routes/_index.tsx`            | Main list, add buttons, paste/upload image.                                                                                                                                                                                                                                                                                                                                     |
| `app/routes/expense.$id.tsx`       | Receipt + mileage editor (save/cancel/delete).                                                                                                                                                                                                                                                                                                                                  |
| `app/routes/expense.$id.image.ts`  | Serve / replace / delete receipt image.                                                                                                                                                                                                                                                                                                                                         |
| `app/routes/api.route.ts`          | Recompute mileage distance + amount.                                                                                                                                                                                                                                                                                                                                            |
| `app/routes/export.*`              | PDF per report + ZIP of everything.                                                                                                                                                                                                                                                                                                                                             |
| `app/routes/mcp.ts`                | MCP endpoint (Streamable HTTP). OAuth bearer token → account; dual-era and fully stateless (2025-era handshake + 2026-07-28 `_meta` envelope, no sessions). `maxDuration: 60`.                                                                                                                                                                                                  |
| `app/lib/mcp.server.ts`            | MCP server: dual-era stateless handler (`createMcpHandler` + a hand-wired legacy leg), 13 tools + statement reconciliation matcher. `capture_receipt` runs the app's own extraction pipeline. OAuth access tokens only.                                                                                                                                                         |
| `app/lib/oauth.server.ts`          | OAuth authorization server: PKCE (S256), token/code hashing, RFC 8414 metadata, refresh rotation, client auth.                                                                                                                                                                                                                                                                  |
| `app/routes/oauth.authorize.tsx`   | Consent page (GET) + approve/deny (POST). Also `oauth.token.ts`, `oauth.register.ts`, `oauth.revoke.ts`, and the `[.]well-known.*` discovery routes.                                                                                                                                                                                                                            |
| `app/lib/report-pdf.server.ts`     | Report PDF builder — shared by the web export and the MCP `export_report` tool. Mileage rows show type · rate, distance + route addresses, and an embedded real route map (`app/lib/route-map.server.ts`).                                                                                                                                                                      |
| `app/routes/settings.tsx`          | Reports, categories, current IRS mileage rates (one line, from the master table), start/end location, receipts-by-email sender, Agents & API (MCP) tokens.                                                                                                                                                                                                                      |
| `app/routes/api.inbound-email.ts`  | Resend inbound webhook (public, signature-verified; `maxDuration: 60`).                                                                                                                                                                                                                                                                                                         |
| `app/routes/api.smoke.ts`          | Post-deploy PDF+OCR+MCP health check (secret-gated GET `/api/smoke`; `maxDuration: 60`). Runs the receipt pipeline (pdfkit→pdfjs→tesseract) plus a full MCP round trip (`runMcpSmoke`) in the deployed bundle. `scripts/deploy` curls it after every deploy and fails the deploy if the pipeline breaks in the serverless bundle.                                               |
| `app/routes/login.tsx`             | Sign in / create account / join by invite code.                                                                                                                                                                                                                                                                                                                                 |
| `app/routes/sign-out.ts`           | Destroys the session, redirects to /login.                                                                                                                                                                                                                                                                                                                                      |
| `app/lib/editor.server.ts`         | Editor context shared by the /expense/:id and /expense/new loaders (reports, categories, merchants, home, IRS rate table).                                                                                                                                                                                                                                                      |
| `app/lib/auth.server.ts`           | Auth: session storage, `requireUser`, login/signup.                                                                                                                                                                                                                                                                                                                             |
| `app/lib/passwords.ts`             | scrypt hashing + invite-code generation.                                                                                                                                                                                                                                                                                                                                        |
| `app/lib/prisma.server.ts`         | Prisma client singleton (PrismaPg adapter).                                                                                                                                                                                                                                                                                                                                     |
| `app/lib/inbound-email.server.ts`  | Receipt-by-email pipeline: signature, date, attachment pick, expense create, replies.                                                                                                                                                                                                                                                                                           |
| `app/lib/receipt-ai.server.ts`     | DeepSeek extraction client (text + vision attempt, JSON mode).                                                                                                                                                                                                                                                                                                                  |
| `app/lib/receipt-ocr.server.ts`    | OCR (tesseract fallback) + PDF text/render (pdfjs + @napi-rs/canvas).                                                                                                                                                                                                                                                                                                           |
| `app/lib/receipt-render.server.ts` | HTML→text + text→PNG receipt image (resvg + bundled JetBrains Mono); fallback renderer.                                                                                                                                                                                                                                                                                         |
| `app/lib/email-render.server.ts`   | Render email bodies → PNG with real headless Chromium (HTML + plain-text column; puppeteer-core + @sparticuz/chromium on Vercel, Playwright Chromium locally; RENDER_BROWSER=local/sparticuz/none overrides).                                                                                                                                                                   |
| `app/lib/reply.server.ts`          | Failure/partial reply emails via Resend.                                                                                                                                                                                                                                                                                                                                        |
| `app/data/default-categories.csv`  | Default categories seeded for every new account (IRS Schedule C, Part II lines 8–27a; `name` header, one per row, comma-containing names quoted). Loaded at build time by `app/lib/default-categories.server.ts` (Vite `?raw` import) — edit the CSV to change what new accounts get seeded with.                                                                               |
| `prisma/schema.prisma`             | Single schema source of truth (13 models).                                                                                                                                                                                                                                                                                                                                      |
| `prisma/migrations/0_init`         | Baseline migration (fresh DBs via `prisma migrate`).                                                                                                                                                                                                                                                                                                                            |
| `scripts/preflight-prod.mjs`       | Idempotent pre-account baseline SQL for prod (pre-`db push`).                                                                                                                                                                                                                                                                                                                   |
| `scripts/clone`                    | Clone prod (Supabase) DB into the local dev DB: dump `DATABASE_URL_UNPOOLED` to `prisma/backup.sql`, drop/recreate the local schema, restore.                                                                                                                                                                                                                                   |
| `scripts/import-expensify.ts`      | API-driven Expensify import: effective SmartScan fields + receipt images (needs `EXPENSIFY_PARTNER_USER_ID`/`_SECRET`; receipts are login-gated — `--cookie` or `--receipts-dir`).                                                                                                                                                                                              |
| `app/lib/store.server.ts`          | Storage entry point (Postgres only).                                                                                                                                                                                                                                                                                                                                            |
| `app/lib/database.ts`              | Postgres backend (accounts/users + scoped rows).                                                                                                                                                                                                                                                                                                                                |
| `app/lib/maps.server.ts`           | Geocode + route (Nominatim/OSRM).                                                                                                                                                                                                                                                                                                                                               |
| `app/lib/route-map.server.ts`      | Real route map for report PDFs, same look as the editor: Carto Positron light tiles fetched server-side (cached, descriptive User-Agent), white-cased blue route + dashed gray return + numbered stop bubbles, rendered with resvg + bundled JetBrains Mono. Falls back to a schematic drawing when the tile server is unreachable; `tileFetcher` injectable for offline tests. |
| `app/lib/mileage-rates.ts`         | IRS rate lookup + amount math: `mileageRateFor(entries, date, type)`, `currentMileageRates(entries, date)`, `mileageAmount(distance, rate)` (exact half-up cents), `formatRate`, `MILEAGE_TYPES`. Pure — shared by the editor (client) and server.                                                                                                                              |
| `app/data/mileage-rates.ts`        | The IRS standard rates seed for the global `mileage_rates` master table (synced by `initStore` when the seed differs) — edit this to update rates (snapshot: `docs/2026-08-04 IRS standard mileage rates.md`).                                                                                                                                                                  |

## Gotchas

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
  sizes in the Supabase dashboard and Sentry for `EMAXCONNSESSION`.

- **Auth & accounts**: multi-user access control with account-level sharing.
  Users live in Postgres (`users`, `accounts`); every expense, report,
  category, setting, and mileage row is scoped by `accountId`. Users in the
  same account share everything; other accounts are fully isolated (all
  reads and writes are scoped — see `app/lib/database.ts`).
  - Sign in with email/password (scrypt-hashed in `users.passwordHash`);
    the email is the login name — stored lowercase, unique, format-
    validated at signup/join (`isEmail` in `app/lib/validation.ts`).
  - Signup creates a new account; joining uses the account's invite code
    (shown in Settings, regenerable). Session = signed HttpOnly cookie
    (`SESSION_SECRET`, 30-day max age).
  - **Bootstrap**: on an empty database, the first account + user are
    created from `APP_EMAIL`/`APP_PASSWORD` (fail-closed if missing). On
    existing pre-email databases, `initStore` backfills the bootstrap
    (oldest) user's login from `APP_EMAIL` when their stored email is not
    a valid address (legacy username-era rows).
    Single-user era rows are adopted into that account automatically. This
    is app-side data seeding (`initStore` in database.ts, memoized per
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
- `vp check` excludes `vite.config.ts` from tsgolint (recursion limits); tsc
  still type-checks it.
- **PDF/OCR can't be fully verified locally** — local tests run against
  node_modules, where every file exists; Vercel's dependency tracer is what
  drops pdf.worker.mjs / tesseract wasm and breaks PDF/OCR in production.
  Real coverage: `test/pdf-ocr.test.ts` (text extraction + rasterization in
  `pnpm test`; tesseract round-trip opt-in via `RUN_OCR_TESTS=1`, on in CI)
  and the smoke check (`/api/smoke`, gated by `SMOKE_TEST_SECRET`), which
  runs in the deployed serverless bundle — `scripts/deploy` curls it after
  CLI deploys, and `.github/workflows/deployment-smoke.yml` runs it on every
  push to `main` (after the `check-and-test` CI job, same workflow — the
  smoke job fails fast when CI fails, so a broken build never reports a
  passing smoke check). To gate production promotion on it: Vercel → project → Settings → Build & Deployment →
  Deployment Checks → Add Checks → GitHub → require `pdf-ocr-smoke` (that
  single check is enough — it fails when CI fails; requiring `check-and-test`
  too is optional); requires `VERCEL_TOKEN`,
  `VERCEL_PROJECT_ID`, `VERCEL_ORG_ID` (team id, `team_…`), and
  `SMOKE_TEST_SECRET` GitHub secrets. The job name is the check name — keep
  it stable.
- **Receipts by email**: the `/api/inbound-email` route is public (no session) —
  it verifies Resend's webhook (standard Svix/Standard-Webhooks format:
  `svix-id` / `svix-timestamp` / `svix-signature` headers, HMAC-SHA256 of
  `id.timestamp.body` keyed with the base64-decoded `whsec_…` secret,
  replay-guarded) and maps the sender to an account via the `inbound_senders`
  table (one row per account+address, normalized lowercase). Webhook retries
  are idempotent via the `inbound_emails` table.
  - **Precedence**: when the same sender address is allowed by several
    accounts, the row with the earliest `createdAt` wins ("first added takes
    precedence"); deleting that row falls through to the next account. Manage
    lists in Settings → Receipts by email (add/remove per address).
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
