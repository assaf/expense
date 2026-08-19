# Agent guide — Expense

Personal expense tracker (receipts + mileage). React Router v8 framework mode,
Tailwind v4. Storage is Postgres-only (required), accessed through **Prisma**
(schema in `prisma/schema.prisma` — the single source of truth; client in
`app/lib/prisma.server.ts`). Domain reads/writes go through the per-domain
modules in `app/lib/db/` (accounts, expenses, reports, categories, settings,
oauth, inbound, reconcile — see `docs/files.md`); receipt images via
`app/lib/images.server.ts` (Postgres BYTEA — prod and local both; no separate
storage service). There is **no runtime DDL** — schema changes go through Prisma
(`prisma migrate dev` locally, `pnpm db:push` on deploy). Dev/tests run on local
Postgres (`expense_dev`/`expense_test`) only. Deployed to **Vercel** with a
**Supabase** Postgres database (project ref `ldtqjzfftjbzcvgktgbt`, region
us-west-2; GitHub push to `main` auto-deploys).

## Operations reference

Env vars / secrets and the Supabase connection setup (pooler URLs,
`sslmode`, pool sizing, `DATABASE_URL_UNPOOLED` for DDL) live in
**[`docs/operations.md`](docs/operations.md)** — read it before deploying,
touching DB config, or changing env vars.

Key one-liners: env load order is `process.env` → local `.env`;
`DATABASE_URL` is required; runtime uses the **transaction-mode pooler
(port 6543)** with `?sslmode=no-verify`, DDL uses `DATABASE_URL_UNPOOLED`
(session pooler, port 5432); never raise a pooler above 80% of
`max_connections`; never migrate before the test suite passes.

## Commands

```sh
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
./scripts/clone              # clone the prod (Supabase) DB into the local dev DB (prisma/backup.sql)
```

Run `pnpm check` before committing.

## Stack & conventions

- **Dark mode**: system-only via `prefers-color-scheme`; an inline
  `<script>` in `app/root.tsx` applies `.dark` before first paint
  (FOUC-free). **Every new component must add `dark:` variants for all
  color classes** — the full color mapping is in
  [`docs/dark-mode.md`](docs/dark-mode.md); shared primitives
  (`Button`, `Input`, `Textarea`, `Select`, `Card`, `EmptyState`) already
  have dark variants — use them instead of raw elements.
- **Routing**: React Router v8, flat file routes in `app/routes/`. `app/routes.ts`
  wires an index + `flatRoutes()`. Loaders/actions are server-only.
- **Types**: import route types from `./+types/<name>`. Path alias `~/*` → `app/*`.
- **State**: Postgres via Prisma — `prisma/schema.prisma` is the source of
  truth (15 models); `prisma/generated` is the gitignored generated client.
  Never read state on the client; all reads/writes go through the per-domain
  modules in `app/lib/db/` (Prisma queries, scoped by `accountId`).
- **MCP (agents)**: `/mcp` (Streamable HTTP) exposes the store to any MCP
  client. Auth is OAuth 2.1 only (authorization-code + PKCE — clients sign
  in with their normal account and approve a consent page; no API keys).
  Settings → Agents & API lists connected apps (name, client id, last used,
  expires) with a per-app remove that revokes all its tokens. Tools:
  capture_receipt (reuses the OCR/DeepSeek pipeline
  - known-merchant skip + sha256 cache keep repeat receipts at zero LLM
    tokens — see docs/extraction.md), log_mileage, list_expenses/expense_summary, report
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
- **Validation**: plain helper validators in `app/lib/validation.ts`;
  completeness rules in `app/lib/completeness.ts`. Domain validation is
  Zod-free; the `zod` dependency is used only for MCP tool argument
  schemas in `app/lib/mcp.server.ts`.
- **Code style**: formatting, lint, React, testing, and commit conventions —
  see "Code style" below.

## Code style

Enforced by `pnpm check` (oxfmt + oxlint + tsc via `vp`) — run it before
committing (`vp check --fix` also runs on staged files): strict mode +
type-aware linting (`typeAware: true`, `typeCheck: true`), oxfmt formatting
(double quotes, 2-space indent, 80-col, semicolons — never hand-wrap or
hand-sort), `react-hooks/rules-of-hooks` + `exhaustive-deps`,
`typescript/no-explicit-any`, `no-console` (only `.assert`/`.error`/`.info`/
`.warn`), `unicorn/no-array-for-each` / `prefer-array-flat-map`,
`react/no-danger`.

Judgment conventions (not tool-enforced):

### TypeScript

- **Prefer interfaces over types** for object shapes; `type` for
  unions/aliases (`type Expense = ReceiptExpense | MileageExpense`).
- **No enums** — string unions (`type ExpenseType = "receipt" | "mileage"`).
- **Avoid `any`** — narrow with `unknown`.
- **Descriptive names** — auxiliary-verb booleans: `isComplete`, `hasAmount`.
- **No classes** — pure functions; only error subclasses (`class DeepSeekError extends Error`).
- **Early returns** — handle errors/guards at the top of functions.

### Imports & organization

- **Path alias** `~/*` → `app/*`; relative imports only for same-directory
  siblings (`./x`), never `../`.
- **Group imports by origin**: `node:` builtins → external packages → `~/*` →
  relative — `./+types/<name>` last where present.
- **`import type`** for type-only imports.
- **No barrel files** — import from the concrete module.
- **File structure**: exports at top, then module-level helpers/constants,
  then types (see `app/lib/db/accounts.ts`, `inbound-email.server.ts`).

### React & components

- **Functional components only** — no classes.
- **Named exports** for shared components (`export function Button`); route
  modules `export default` the page.
- **Component naming**: PascalCase; files in `app/components/` (`ui/` for
  primitives).
- No `dangerouslySetInnerHTML` — escape untrusted text with `escapeHtml`
  (`app/lib/escape.ts`).

### Accessibility

The a11y smoke tests (`test/a11y.test.ts`) enforce the contract — skip-link,
page titles, keyboard shortcuts, focus trapping, `aria-invalid`,
`aria-pressed`, `aria-expanded` — and the shared primitives already follow
it. The rules:

- Icons carry `aria-hidden="true"` (standalone icon buttons get an
  `aria-label` on the `<button>`).
- Inputs set `aria-invalid={true}` when invalid (shared `Input`/`Textarea`
  do this automatically); pair error text with `aria-describedby`.
- Overlays trap focus on open, restore it on close, close on Escape
  (`ConfirmDialog`, `Lightbox` are the pattern).
- WCAG AA contrast: nothing below `text-gray-500` on white (placeholder,
  helper text, functional icons included).
- Touch targets ≥ 24×24 CSS px (small icon-only buttons need at least `p-1`).
- Every route exports a `meta` with a descriptive `<title>`; pages use
  `<main id="main-content">` + exactly one `<h1>`; sections get `<h2>`.
- Primary actions have keyboard shortcuts (editor: Enter saves, Escape cancels).
- Respect `prefers-reduced-motion` (guard any new animation/smooth scroll).
- Tests use accessible selectors (`getByRole`/`getByLabel`/`getByText`).

### Conditionals & logic

- **Prefer early returns** over nested if/else.
- No `forEach` — `for...of`, `.map()`, `.filter()`, `.flatMap()`.

### Error handling & validation

- **Validate at the boundary** — plain helper validators in
  `app/lib/validation.ts`, completeness rules in `app/lib/completeness.ts`.
- Handle errors first (guard clauses); return early on bad input.
- Catch at boundaries and log with `console.warn`/`console.error` (see Logging).

### Logging

- Allowed methods: `.assert`, `.error`, `.info`, `.warn` (no `console.log`).
- Prefix runtime logs with a context tag: `console.warn("[draft-upload] …")`.

### Security

- **scrypt** for password hashing (`app/lib/passwords.ts`); never store plaintext.
- Escape untrusted text before embedding in HTML/SVG/email (`escapeHtml`).
- Sanitize free-text filenames (`sanitizeFilenamePart`).
- **Authenticated responses must not be shared-cacheable.** Receipt images
  use `Cache-Control: private` — never flip to `public`. Every HTML document
  denies framing (`X-Frame-Options: DENY` + `CSP: frame-ancestors 'none'` in
  the root loader headers). HSTS comes from Vercel.
- Server-side fetches of untrusted URLs go through `fetchPublicUrl`
  (`app/lib/ssrf.server.ts`) — literal + DNS-resolved private-address checks,
  re-checked on every redirect hop. Never raw-fetch an attacker-controlled URL.

### Testing (`vpr test` + Playwright)

- Test files live in `test/*.test.ts` (not alongside source); browser tests
  via Playwright with helpers in `test/helpers/` (`launchBrowser` →
  `goto`/`signIn`, `seedTestData` → `testPrisma`, `launchServer`); DB
  assertions via `testPrisma`. Requires local Postgres (`expense_test`,
  force-reset each run).
- **The suite runs on a pinned clock** (`2026-07-15T12:00:00Z`, ticking) —
  never use `Date.now()`/`new Date()` for real-time deadlines or polling
  loops (use `performance.now()`); derive webhook timestamps from
  `Date.now()`. Full pinned-clock mechanics and unit-test patterns:
  [`docs/testing.md`](docs/testing.md).

### Git commits

- **Conventional commits**, lowercase type, optional scope:
  `type(scope): subject` — e.g. `feat(analytics): …`. **No emoji prefixes.**
- Imperative mood, atomic commits, explain why not just what.
- Run `pnpm check` before committing.

## Key files

Full map: [`docs/files.md`](docs/files.md). The unusual entry points:
`prisma/schema.prisma` (schema source of truth), `app/lib/db/` (per-domain
store modules), `app/routes.ts` (flat-routes wiring),
`app/lib/images.server.ts` (image storage — Postgres BYTEA),
`app/lib/env.ts` (env contracts), and the `docs/*.md` files (mcp,
operations, deploy, testing, receipts-by-email, reconciliation, accounts,
dark-mode).

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

- **Pooler caps and serverless pools**: full details in
  [`docs/operations.md`](docs/operations.md) — the short version: the Supavisor
  poolers cap connections (never raise `pool_size` above 80% of
  `max_connections` — see the 2026-08-16 `(EMAXCONN)` incident), the runtime
  `DATABASE_URL` uses the transaction-mode pooler (port 6543), DDL uses
  `DATABASE_URL_UNPOOLED` (session pooler, port 5432), and
  `app/lib/prisma.server.ts` keeps the per-instance pool small (`max: 2`,
  4s idle release) with `findUserById` cached for 30s. If 500s reappear under
  load, check the pooler sizes in the Supabase dashboard and Sentry for
  `EMAXCONNSESSION` / `EMAXCONN`.

- **Auth & accounts**: account-level sharing — every row is scoped by
  `accountId`, other accounts fully isolated; email/password sign-in
  (scrypt), invite-code join, **email verification gates sign-in**
  (`/verify-email?token=`, 7-day TTL, resend rate-limited once a day),
  and the `APP_EMAIL` bootstrap for empty databases. Every loader/action
  calls `requireUser(request)` and passes `user.accountId`. Details:
  [`docs/accounts.md`](docs/accounts.md).
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
- **PDF/OCR can't be fully verified locally**: Vercel's dependency tracer
  drops pdf.worker.mjs / tesseract wasm in production — real coverage is
  `test/pdf-ocr.test.ts` + the post-deploy smoke check (`/api/smoke`,
  `SMOKE_TEST_SECRET`-gated). Deploy ordering contract: secretlint →
  check & test → migrate-db (never before tests) → pdf-ocr-smoke; the
  Deployment Checks alias gate is REMOVED (Aug 2026). Details:
  [`docs/deploy.md`](docs/deploy.md).
- **Reconciliation**: `/reconcile` matches a statement (CSV/QFX/PDF)
  against receipt expenses (date ±2d, amount $0.50/1%, merchant-token
  overlap; refunds never auto-match; mileage is never a card transaction);
  completing marks `reconciledAt` + creates new rows in **one transaction**
  and never deletes anything; drafts persist decisions and re-uploads
  resume by file sha256; `reconciledAt` is only written by this flow.
  Details: [`docs/reconciliation.md`](docs/reconciliation.md).

- **Receipts by email**: FastMail-only inbound (the Resend
  webhook path was removed Aug 2026). A delivery rule files mail for
  `INBOUND_EMAIL_ADDRESS` into the Receipts folder; the encrypted RFC
  8291 push (`/api/inbound-push`) + daily cron (`/api/inbound-cron`,
  CRON_SECRET-gated) drain it via `processUnprocessedReceipts` (mark
  `$receipt-processed` → process → destroy on non-error; the
  `inbound_emails` row is the idempotency guard). Sender verification:
  From must have a verified `inbound_senders` row; the self-reply guard
  compares From against the outbound address. Details (push-subscription
  gotchas, sender verification + exclusivity, attachment picking, date
  extraction, rendering): [`docs/receipts-by-email.md`](docs/receipts-by-email.md).
