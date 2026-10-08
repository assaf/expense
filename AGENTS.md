# Repository Guidelines

## Project Overview

Expense is a personal expense tracker for people filing taxes as individuals
(freelancers, self-employed, side hustlers). One app, one Postgres database, no
monorepo.

What it does, how it works, and the pages a person uses are in
**[PRODUCT.md](PRODUCT.md)** — read it first. This file is the rules that bind a
change, not the tour.

## Architecture & Data Flow

The diagrams (system shape, data model, the connected-mailbox drain, and the
deploy path) are in [PRODUCT.md](PRODUCT.md#how-it-is-built). The rules that
shape the code:

- **Framework**: React Router v8 framework mode, SSR. `app/routes.ts` is just
  `flatRoutes()`, so the URL tree comes from filenames in `app/routes/`:
  `_index.tsx` -> `/` (the marketing landing page), `expenses.tsx` ->
  `/expenses` (the signed-in home), `expense.$id.tsx` -> `/expense/:id`,
  `[_]highlights.tsx`
  -> `/highlights`, and `[.]` is a literal dot (`mileage-rates[.]md.ts` ->
  `/mileage-rates.md`).
- **Route contract**: a route exports `loader`, `action`, `default` (component),
  `meta`, `headers`, `ErrorBoundary`. A route with `loader`/`action` but **no**
  `default` export is a **resource route** and returns `Response` directly
  (`api.*`, `oauth.*`, `.well-known.*`, `export.*[.]pdf|zip`, `mcp.ts`).
- **Auth gate is route middleware** on the root route (`middleware` in
  `app/root.tsx`): a hard-coded public set plus `PUBLIC_PAGES` (`/about`, `/ai`,
  `/connect`, `/faq`, `/mileage-rates`, `/schedule-c-categories`,
  `/alternatives`, `/privacy`, `/terms`, `/support`, `/llms.txt`) and the
  resource routes that gate themselves. It resolves the session once and
  publishes the user on `context` (`userContext`), and a route reads it with
  `requireContextUser(context, request)`, which redirects to `/login?next=...`
  when the gate let the request through without a user. The lists are pinned by
  `test/public-paths.test.ts`; the gate strips `.data` and `.md` before
  matching, because client loader fetches append `.data`.
- **Middleware runs for resource routes too**, which is why the gate moved
  there: React Router runs no ancestor loader for one, so they used to have to
  authenticate themselves and nothing caught one that forgot. A self-gating
  route must be listed in `SELF_GATED_PATHS`/`SELF_GATED_PREFIXES` or the gate
  bounces it to `/login` (fatal for `/oauth/token`, which carries no cookie).
  Where the credential is not a session they still self-gate: `assertCronSecret`
  (cron and dev routes), OAuth bearer inside `handleMcpRequest` (`/mcp`), and
  PKCE in `oauth.token.ts`.
- **All persistence goes through `app/lib/db/<domain>.ts`**, never from a route,
  over the Prisma 8 client exported as `db` from `app/lib/prisma.server.ts`.
  Three lanes: `db.orm.public.<Model>` (typed ORM), `db.sql.public.<table>`
  (SQL builder with `.outerLeftJoin` / `.select` / `.build()`, executed via
  `db.runtime().query(plan)`), and `db.transaction(fn)` (not `$transaction`).
- **`accountId` scoping is enforced in the db layer**, not the routes: every
  query filters by `accountId`, and updates match
  `and(id.eq(...), accountId.eq(...))`.
- **Prisma is contract-first**: `prisma/contract.prisma` is the source of truth;
  `prisma contract emit` writes `prisma/contract.json` + `contract.d.ts` (both
  committed). There is no runtime DDL and no `prisma migrate deploy`.
- **Images live in Postgres** (`image_blobs` BYTEA, dev and prod), stored under
  `images/{accountId}/YYYY-MM-DD_REPORT_FILE.ext`. No external object storage.
- **Ingest pipeline**: inbound email or webhook -> attachment, or the body
  rendered to an image -> OCR (tesseract, pdfjs) or LLM vision -> extraction
  cache -> expense row plus image blob. Idempotent on email id.

## Key Directories

The annotated map is [PRODUCT.md](PRODUCT.md#where-things-live); every notable
file has a line in [docs/files.md](docs/files.md). The ones worth knowing before
you touch anything: `app/routes/` (the URL tree is the filesystem), `app/lib/`
(`*.server.ts` never reaches the client), `app/lib/db/` (every query in the app
is written here), `app/data/` (all public copy plus the seeds),
`prisma/contract.prisma` (the schema), `scripts/check` (the gate), and
`.github/workflows/deployment-checks.yml` (CI, which deploys).

## Development Commands

| Command                                           | Runs                                                             | Notes                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| `pnpm dev`                                        | `portless run -- react-router dev`                               | Dev server behind `expense.localhost` (emits the table)        |
| `pnpm build`                                      | `react-router build --force`                                     | `prebuild` emits the contract + the policies table             |
| `pnpm start`                                      | `NODE_ENV=production react-router-serve ./build/server/index.js` | Serves the build on :3000                                      |
| `pnpm check`                                      | `./scripts/check`                                                | **Gate.** Static pipeline; fails on any issue (no auto-fix)    |
| `pnpm test`                                       | `react-router build --force && vp test run`                      | **Gate.** Build then the full suite                            |
| `pnpm test:changed [ref]`                         | `vp test run --changed ${1:-HEAD}`                               | Fast lane over the static import graph                         |
| `pnpm test:related <file>`                        | `vp test related --run`                                          | Fast lane for tests importing the named files                  |
| `pnpm test:ocr`                                   | `RUN_OCR_TESTS=1 vpr test run test/pdf-ocr.test.ts ...`          | Real OCR round trip (script still says `vpr`; use `vp`)        |
| `pnpm test:db:push`                               | `bash scripts/reset-test-db`                                     | Drops and recreates `expense_test`                             |
| `pnpm db:push`                                    | `prisma db update`                                               | **Gate.** Syncs a DB to the contract (dev now, prod on deploy) |
| `pnpm build:prisma`                               | `prisma contract emit`                                           | Regenerates `contract.json` / `contract.d.ts`                  |
| `pnpm build:policies`                             | `tsx scripts/build-warranty-policies.ts`                         | Emits the merchant coverage table                              |
| `pnpm screenshot`                                 | `SCREENSHOT=1 vp test run test/screenshot.test.ts`               | Regenerates README screenshots                                 |
| `pnpm screenshots:review`                         | `tsx scripts/screenshots.ts`                                     | :3456 baseline-vs-new review UI                                |
| `pnpm setup:push` / `infer:rules` / `drain:email` | `tsx scripts/...`                                                | Fastmail push setup, email-rule inference, dev drain           |
| `./scripts/deploy`                                | check -> test -> prod db sync -> vercel -> smoke                 | The only production writer; `--skip-tests`, `--skip-db-sync`   |
| `./scripts/clone`                                 | prod dump -> local DB                                            | Read-only against prod; `LOCAL_DB_URL` overrides               |
| `./scripts/smoke-check <url>`                     | `GET /api/smoke`, fails unless `ok === true`                     | Shared by `scripts/deploy` and CI                              |
| `./scripts/upgrade`                               | bump all -> install -> suite -> commit                           | **Commits itself** (see below)                                 |

`pnpm check` runs, in order: `prisma contract emit` -> the merchant coverage
table emit (`tsx scripts/build-warranty-policies.ts`) ->
`react-router typegen` -> `vp check` (oxfmt + oxlint with type-aware
tsgolint + `tsc`) -> `node scripts/check-dark-mode.mjs` -> `secretlint` ->
a tesseract patch probe -> `knip`. Nothing is auto-fixed: a nonzero exit
means some finding needs a real edit. The pre-commit hook runs
`vp staged` over the staged files plus the same secretlint scan.

`scripts/upgrade` is the one script that writes to the repo's history. It
bumps every dependency to latest, re-installs, reinstalls chromium, runs
`vpr check` and the full suite, and only then stages `package.json`,
`pnpm-lock.yaml` and `pnpm-workspace.yaml` (all three: a catalog or override
edit is a normal outcome of a bump, and CI installs with a frozen lockfile) and
runs `omp commit` with a generated message. A failing suite aborts before the
staging, so the bumped tree is left dirty for inspection rather than committed.
`pnpm audit --prod` runs after the commit and exits 1 if it found anything, so
a vulnerable bump still lands as a commit you have to look at. Nothing else in
the repo auto-commits, and `pnpm test`/`./scripts/deploy` never do.

## Code Conventions & Common Patterns

**Language and style.** TypeScript strict, `no any`, `verbatimModuleSyntax`.
`interfaces` over `type`, string unions over enums, no classes, early returns,
grouped imports, conventional commits. Path aliases: `~/*` -> `app/*`,
`~/test/*` -> `test/*`, `+types/*` -> `.react-router/types/*`. See
`docs/code-style.md`. Prose (comments, docs, commit messages) goes easy on em
dashes.

**File names.** A root document is `BASE.md`: the base name upper case, the
extension lower case (`README.md`, `AGENTS.md`, `PRODUCT.md`). Links to one
must match that case exactly — GitHub paths are case-sensitive even though a
macOS working tree is not, so a lowercase link to `PRODUCT.md` 404s there while
still resolving locally.

**Routes and mutations.** Loaders `throw redirect(...)`; actions `return
redirect(...)`. Mutations are FormData POSTs keyed by an `intent` string:
authenticated actions start with `const { user, form, intent } = await
requireIntent(request)`, anonymous ones with `parseIntent`. Expected failures are
returned as envelopes from `app/lib/validation.ts`: `badRequest(error)` (400),
`notFound()` (404), `unknownIntent()` (400). Loaders `throw notFound()`.
Unhandled errors bubble to the root `ErrorBoundary`. The client submits with
`useFetcher`; there is no client state library.

**Route types.** Run `react-router typegen` after adding or renaming a route,
then `import type { Route } from "./+types/<basename>"` and type against
`Route.LoaderArgs` / `Route.ActionArgs` / `Route.ComponentProps`.

**Server-only modules.** The `.server.ts` suffix marks a module that must never
enter the client bundle (67 under `app/lib/`). Do not import one from a
component. Non-`.server` modules that touch Node APIs need discipline, e.g.
`app/lib/env.ts` uses `process.loadEnvFile` and is only ever imported
server-side.

**Errors and logging.** Only `console.assert`, `.error`, `.info`, `.warn` are
allowed (`no-console` is a lint error, `console.log` is banned). Prefix messages
with a bracketed context tag (`[auth]`, `[mcp]`, `[inbound]`, `[email]`,
`[receipt-ocr]`, ...). Server-side reporting goes through `captureError` /
`captureWarning` / `captureErrorOnce` in `app/lib/errors.server.ts` (console
plus Sentry).

Two rules that are not guessable from the code: a recoverable failure's
`errorSummary` rides in the Sentry **message** as well as in `extra`, because
Sentry's server-side scrubber is free to replace `extra` values with
`[Filtered]` (EXPENSE-1B lost its message, stack and summary that way) — so
the diagnosis has to live in the field that survives; and anything that quotes
a provider response body into a message redacts it first, through
`redactCredentials` in `app/lib/error-text.ts`, because a Fastmail session
hands its credential to the endpoint in the URL.

**Validation.** Hand-rolled helpers are the default for forms and domain rules
(`app/lib/validation.ts`, `app/lib/completeness.ts`). Zod is for tool contracts
and untrusted-wire boundaries only: MCP tool `inputSchema`, the isomorphic
read-tool schema converted with `z.toJSONSchema`
(`app/lib/expense-read-tools.ts`), and `safeParse` on every provider response
(JMAP, Gmail, Nominatim, OSRM).

**Timezone.** The server runs UTC; never compute a user-facing "today" in a
loader or action. `todayDate()` is client-only, and `useToday()` is null until
mounted. Timestamps render through `<LocalDate>` / `<LocalDateTime>`
(`app/components/ui/LocalTime.tsx`), which print ISO until mount. Prefer
`performance.now()` over `Date.now()` for deadlines.

**UI.** Tailwind v4 utilities, system-only dark mode, and **every color class
needs a `dark:` twin** (enforced by `scripts/check-dark-mode.mjs`). Use the
shared primitives in `app/components/ui/` (`Button`, `Input`, `Select`, `Card`,
`EmptyState`, `Alert`, `Badge`, `ConfirmDialog`, `DatePicker`, `Field`,
`Textarea`, `OrDivider`, `LocalTime`); style with `cva` plus `cn`. Design for
~320px first and widen at `sm:`. Icon-only controls need `aria-label`; controls
that back a keyboard shortcut need `data-shortcut="<kbar-action-id>"`.

**Database changes.** Edit `prisma/contract.prisma`, run `pnpm build:prisma`,
then `pnpm db:push` locally. DDL uses `DATABASE_URL_UNPOOLED` (session pooler);
runtime uses the transaction pooler with `max: 2`. Never raise the pool above
80% of `max_connections` (see the `(EMAXCONN)` incident in `docs/operations.md`).

**`app/lib/jmap.server.ts` stays env-free.** It must not import `app/lib/env.ts`,
or anything that does (`app/lib/images.server.ts`, hence `app/lib/upload-limits.ts`
is its own dependency-free module). `env.ts` re-wraps `globalThis.fetch` in the
test network guard whenever a test's `vi.resetModules()` re-imports it, which
breaks the stubbed fetches in `test/token-crypto.test.ts`.

**Heavy dependencies stay lazy.** `pdfkit`, `pdfjs-dist`, `tesseract.js`,
`@napi-rs/canvas`, `@resvg/resvg-js`, `puppeteer-core`/`@sparticuz/chromium`,
and the MCP SDK all load through dynamic `import()` inside the module that needs
them. Each has a shipping shim because Vercel's tracer cannot follow them: the
pdfjs worker global, the tesseract wasm-core patch, and the
`vendor/pdfkit-standard-fonts` package. Read
[`docs/operations.md`](docs/operations.md) before adding a heavy dependency.

**Cron routes.** Create `app/routes/api.<name>-cron.ts` and run the work through
`cronTick` (`app/lib/cron.server.ts`), which owns the Sentry `withMonitor`
wrapping and the explicit `Sentry.flush()` before returning. Guard inbound
webhooks with `assertCronSecret`. Never hand-roll a cron route.

**Adding an MCP tool.** Register it in `createMcpServer(accountId)` in
`app/lib/mcp.server.ts` with a zod `inputSchema`; reuse
`app/lib/expense-read.server.ts` and the write helpers rather than querying
directly.

**Record editors share one container.** The receipt, mileage and warranty
editors all render `Shell` and drive their save/cancel/delete through
`useEditorFlow` + `useFormKeys` + `EditorActions` + `DeleteConfirmDialog` +
`TransitionOverlay` (`app/components/editor/editor-shared.tsx`). That is what
makes Cmd/Ctrl+Enter save, Escape leave, the Delete button ask first, and the
buttons behave the same everywhere; a new record editor joins them rather than
hand-rolling a `PageShell` form. The only things an editor supplies are its
fields, its submit (the warranty editor submits the form element itself, so the
browser does the multipart encoding for picked files) and `cancelTo`. Anything
a shared piece cannot express (e.g. the noun in the delete prompt) becomes a
prop with the expense wording as the default.

**File drops cover the whole page.** `useDropTarget` installs its listeners on
the document, so a file can be let go anywhere, margins included; what wears the
dashed outline is still the content column, which is what makes the target
obvious without shrinking it to a box. A page arms a zone by calling the hook
and passing the result to `PageShell`/`Shell` (or reading `over` for its own
`<main>`): the callbacks are the hook's own now, so never spread handlers on a
container, and keep it to one zone per page.

**Feature highlights.** Every new user-facing feature or page ships with a "Did
you know?" card in `app/components/FeatureHighlight.tsx`, picked per request on
the home page; gate data-dependent ones in `availableHighlights` and pin the
gating in `test/highlights.test.ts`.

**Changelog.** Every user-facing feature, bug fix or improvement gets a line in
`app/data/changelog.yaml` as part of the same change, before the work is called
done. It renders as `/changelog` and the `/changelog.md` mirror that assistants
read; the file's header comment and the `expense-public-content-pages` skill
carry the details. Write the line for someone using the app, not for someone
reading the commit: what they can do now, what got better, what stopped being
wrong. Under the date it shipped, with a type (`feature` / `improvement` /
`fix`) and one sentence. Two to four lines per date, and one line when a day's
work is one story. Plumbing, refactors, protocol detail and polish on a single
control stay out; the file is validated at build time by `changelogReleases()`.
The oldest group is a summary of the pre-launch build, not a day.

**Domain rules that bite.** `amount` is always the USD number every consumer
uses; `currency`, `originalAmount`, and `fxRate` on a receipt are provenance
only. Foreign receipts convert at the ECB reference rate for the expense date
(weekends roll back to the prior business day); the note is composed by
`app/lib/fx-note.ts` with strip-and-append, so re-saves replace it in place
instead of stacking copies, and the editor re-converts on a date change unless
the amount was hand-edited. Completeness is a display badge only (missing date,
amount, merchant, category, or report; the image does not count, and mileage
needs 2+ stops), never a save gate. Renaming a report updates expenses but not
stored image filenames until they are re-saved. Fastmail API tokens cannot
submit mail (403 on the submission scope), so connected-mailbox confirmations
are written to the owner's Inbox via `Email/import`; a valid token also proves
mailbox control, so onboarding stamps `emailVerifiedAt` without an emailed link.
An amount, distance, printed (pre-conversion) amount or FX rate the column
cannot hold is refused with a message, never a 500: `exceedsMaxMoney` in
`app/lib/money.ts` is the one guard, and every writer calls it (the chat's
resolve and confirm, MCP `capture_receipt`, the editor, the inbound pipeline,
which files a partial row instead of failing after the blob is saved, and the
reconcile row gate). Keep `prisma/backup.sql` (~300MB) out of Vercel uploads
through the `.vercelignore` `backup*.sql` entries.

**Security invariants.** Every mail-importing path gates on the delivered
authentication verdict before it writes: the receipts pipeline and the
connected-mailbox pipeline both run `evaluateAuthChain` over the provider's own
stamp, and a new transport MUST register its authserv-id with `authResultsChain`
(a filter keyed to one provider turns the gate into a silent no-op on another,
because an empty chain reads as "legacy, allowed"). Any new session or token path
MUST stamp and check `User.credentialsChangedAt`: a password reset bumps it,
revokes that user's OAuth tokens and busts the user cache, and the OAuth
callbacks resolve their user through the exported `sessionUser` rather than
reading `SESSION_USER_KEY` and `findUserById` by hand. Untrusted input is bounded
at every ingress: uploads pass the zip/entry/PDF budget pre-scans, arrays that
fan out to outbound calls are capped (`MAX_TRIP_STOPS`), and LLM-provided
arguments are length-bounded before parsing. Never call `db` from inside a
`db.transaction`: the pool is `max: 2`, so a nested call starves a concurrent
request and splits the commit. Use the `tx` handle (the reconcile completion was
fixed for this; `renameNamedRow` in `app/lib/db/names.ts` still is not).

**Marketing and LLM copy.** All public copy lives in `app/data/`, one content
file per page: markdown with YAML front matter for the prose documents,
name/value YAML for the rest, plus the shared `site.yaml` and `mcp.yaml`.
`app/lib/content.server.ts` parses those files and fills their `{{tokens}}`; the
marketing routes read the parsed bundles as loader data and the `.md` /
`/llms.txt` mirrors are assembled from the same fields. Edit the content files,
not the route files or the builders. `app/lib/seo-content.ts` keeps only the
site config (`SITE_URL`, `MCP_ENDPOINT`, `OG_IMAGE`), the shared meta helpers,
and the computed mileage helpers. Every link in `llms.txt` must also exist in
`public/sitemap.xml` (`test/llms-txt.test.ts`), and auth-gated pages must stay
out of both.

## Important Files

| Path                                  | Role                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `app/routes.ts`                       | `flatRoutes()` manifest; the route tree is the filesystem                      |
| `app/root.tsx`                        | Root route: auth gate, theme script, `ErrorBoundary`, security headers         |
| `app/lib/prisma.server.ts`            | Prisma 8 client (`db`) over a `pg.Pool` with `max: 2`                          |
| `app/lib/db/expenses.ts`              | Representative data module: CRUD, image join, duplicate and neighbor reads     |
| `app/lib/db/shared.ts`                | Row mappers, `cachedRead`/`bust`, test-mode helpers                            |
| `app/lib/auth.server.ts`              | Session cookie storage, the middleware's user context, login/signup, throttles |
| `app/lib/route-helpers.server.ts`     | `requireIntent`, `parseIntent`, `assertCronSecret`                             |
| `app/lib/validation.ts`               | Form validators plus the `badRequest`/`notFound`/`unknownIntent` envelopes     |
| `app/lib/errors.server.ts`            | `captureError` and friends (console + Sentry)                                  |
| `app/lib/env.ts`                      | Env constants; server-only (reads `.env` via `process.loadEnvFile`)            |
| `app/lib/cron.server.ts`              | `cronTick`, the only supported cron wrapper                                    |
| `app/lib/mcp.server.ts`               | MCP tool registry and OAuth `authenticateRequest`                              |
| `app/data/`                           | The public copy, plus the merchant coverage table (`warranty-policies.yaml`)   |
| `app/lib/content.server.ts`           | Parses `app/data/`, exports the parsed bundles and the `.md` mirrors           |
| `app/lib/seo-content.ts`              | Site config, shared meta helpers, and the computed mileage helpers             |
| `app/lib/images.server.ts`            | BYTEA image storage and `images/{accountId}/...` keys                          |
| `app/global.css`                      | Tailwind v4 entry: `@theme` tokens and the `.dark` variant                     |
| `prisma/contract.prisma`              | Schema source of truth; `prisma.config.ts` points the CLI here                 |
| `vite.config.ts`                      | Build config plus the `fmt`/`lint` rules and the vitest project split          |
| `scripts/check`, `scripts/deploy`     | The gate and the production deploy path                                        |
| `test/helpers/globalSetup.ts`         | Once per run: recreate `expense_test`, seed, spawn the test server             |
| `test/helpers/launchBrowser.ts`       | Playwright browser plus signed-in context, hydration wait                      |
| `docs/files.md`, `docs/operations.md` | File map; env, pooler, Sentry, and incident history                            |

## Git workflow

Assaf reviews every change before it lands. Never run `git commit`, `git
push`, or trigger a deploy on your own initiative in this repo: make the
change, verify it (targeted tests, `pnpm check`, browser checks as
appropriate), then stop and report what changed, how it was verified, and
that it is uncommitted. Assaf commits and pushes — or explicitly asks; only
then commit/push. CI auto-deploys `main` to production, so a push IS a
deploy. This applies to every change however small, including screenshot
baselines, migrations and generated files; if a change needs a commit
mid-task (e.g. to exercise a deploy-specific path), ask first.

## Runtime/Tooling Preferences

- **Node >= 24** (`engines`), **pnpm 12.9.1** (`packageManager`, authoritative;
  CI reads it and installs the matching version). Bun is not used anywhere in
  this repo.
- **One toolchain: vite-plus.** `pnpm-workspace.yaml` catalogs `vite-plus`
  (binary `vp`; `vpr` is the `vp run` shorthand) and aliases `vite` to
  `@voidzero-dev/vite-plus-core`, plus `vitest` to the exact version vite-plus
  bundles, with matching `overrides` so one runner copy exists. The standalone
  `oxfmt`/`oxlint` wrappers are gone in 1.0: reach them through `vp fmt` and
  `vp lint` (editors want `vp lint --lsp` / `vp fmt --lsp`). There is **no**
  eslint, prettier, tailwind, or postcss config file: the `fmt` and `lint`
  blocks in `vite.config.ts` are the config, with `printWidth: 80`,
  `singleQuote: false`, and semicolons.
- **TypeScript** is a single root `tsconfig.json`: `strict`, `noEmit`,
  `moduleResolution: bundler`, `jsx: react-jsx`, `target: ES2022`, with the
  aliases above re-declared as Vite `resolve.alias`.
- **Tailwind v4 is CSS-first** via the `@tailwindcss/vite` plugin. The theme
  lives in `app/global.css` (`@theme` tokens, `@custom-variant dark
  (&:is(.dark *))`), not a JS config.
- **Postgres everywhere**, including images. Runtime connects through the
  Supabase transaction pooler (port 6543, `max: 2` per instance); DDL and the
  test reset use the unpooled/session URL.
- **Env contract**: `DATABASE_URL` is required at boot or the app crashes;
  `SESSION_SECRET`. Names, by purpose: DB (`DATABASE_URL`,
  `DATABASE_URL_UNPOOLED`, `LOCAL_DB_URL`); auth (`APP_EMAIL`, `SESSION_SECRET`,
  `CRON_SECRET`, `PUBLIC_URL`); email (`FASTMAIL_TOKEN`,
  `FASTMAIL_OAUTH_CLIENT_ID`, `INBOUND_EMAIL_ADDRESS`, `RECEIPTS_FOLDER`,
  `PUSH_PRIVATE_KEY`, `PUSH_AUTH`, `EMAIL_TOKEN_ENCRYPTION_KEY`); Google
  (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
  `GOOGLE_PUBSUB_TOPIC`, `GOOGLE_PUBSUB_AUDIENCE`,
  `GOOGLE_PUSH_SERVICE_ACCOUNT`); LLM/OCR (`LLM_BASE_URL`, `LLM_API_KEY` (alias
  `DEEPSEEK_API_KEY`), `LLM_MODEL`, `LLM_VISION_MODEL`, `RECEIPT_OCR_MODE`);
  observability (`SENTRY_DSN`, `VITE_SENTRY_DSN`, `UMAMI_SCRIPT_URL`,
  `UMAMI_WEBSITE_ID` — both are needed or the script does not load). `.env*` is
  gitignored; read [`docs/operations.md`](docs/operations.md) before touching
  any of them.

## Testing & QA

- **vitest v5** through `vp`, split into two projects from `vite.config.ts`.
  Tests import their runner API from `vite-plus/test` (the entry point Vite+
  re-exports vitest through); the `vitest` package itself is not a dependency,
  and its version is pinned by the catalog so the runner has one copy:
  - `main` (`vitest.main.config.ts`): `test/**/*.test.ts(x)` minus an explicit
    exclude list. Real Postgres, a spawned app server, Playwright, and the email
    pipeline. `pool: "forks"`, one worker, `testTimeout: 30s`.
  - `unit` (`vitest.unit.config.ts`): an explicit 53-file list of pure-logic
    suites, some of them property-based (fast-check, via `assertProperty` in
    `test/helpers/property.ts`; see `docs/testing.md`). `pool: "threads"`,
    parallel, no DB and no server.
  - `vitest.noglobal.config.ts` is an ad-hoc runner that skips the DB reset; it
    is deliberately outside `projects`.
- **Browser tests use the Playwright library, not `@playwright/test`.** There is
  no `playwright.config.*`. `test/helpers/launchBrowser.ts` shares one chromium
  and one signed-in context per file, and each file runs in its own fork.
- **A real Postgres is required.** Tests hardcode `expense_test` (passwordless
  user `assaf`), ignore the dev database, and recreate the schema from the
  contract on every run: `globalSetup` drops the public schema
  (`scripts/reset-test-db`), seeds, and spawns the built server on port 5199;
  `testSuiteSetup` reseeds per file. Start Postgres first
  (`brew services start postgresql@18`).
- **The clock is pinned** to `2026-07-15T12:00:00Z` across the test process, the
  browser page, and the server, ticking in real time. Use `performance.now()`
  for polling or deadlines. Never assert on wall-clock time.
- **Layout**: tests live in `test/`, never beside source, and mirror the module
  name (`app/lib/duplicates.ts` <-> `test/duplicates.test.ts`). Component tests
  use `.tsx`. Route-action unit tests type their args as
  `Parameters<typeof action>[0]` and import types relatively, because
  `~/routes/+types/...` does not resolve from `test/`.
- **Fixtures** live in `test/fixtures/` (emails, PDFs, images, bank statements)
  and are redacted with `scripts/redact-*.py`. Nothing in the suite may make a
  live network call: stub `fetch` and rely on the local mock JMAP server.
- **Hydration is the main flake source.** React Router remounts route components
  shortly after navigation, so wait for the fiber to attach
  (`waitForHydration`) or use `waitForEditorSettle(page)` before uploads.
- **Screenshots**: `test/screenshot.test.ts` compares against the committed
  `screenshots/` baselines (delta-E 2.3) and is skipped under `CI`. Review
  changes with `pnpm screenshots:review`.
- **Coverage is not configured.** No `coverage` block or thresholds exist in any
  vitest config; do not assume a coverage gate.

## Known Drift

Docs and comments occasionally outlive what they describe. Verify a claim
against the tree before acting on it, and add what you find here. Nothing is
outstanding at the moment; the last three were fixed on 2026-10-05 (the demo
doc's two invented `pnpm demo:*` scripts, the deleted `prisma/migrations/`
reference, and the registry namespace in `docs/mcp-directories.md`, which is
`org.labnotes/expense` to match `server.json`).

One thing that looks like drift and is not: `vpr` is a real vite-plus binary,
the shorthand for `vp run`, so `pnpm test:ocr` and `scripts/upgrade` are fine
as written.
