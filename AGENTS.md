# Agent guide — Expense

Personal expense tracker (receipts + mileage). React Router v8 framework mode, Tailwind v4, Postgres via **Prisma 8** (contract-first: `prisma/contract.prisma` = source of truth, emitted to `prisma/contract.json` + `contract.d.ts` by `prisma contract emit`; runtime client in `app/lib/prisma.server.ts`, query lanes `db.orm.public.<Model>` / `db.sql`). Reads/writes go through per-domain modules in `app/lib/db/` (file map: `docs/files.md`); receipt images in Postgres BYTEA (`app/lib/images.server.ts`); no runtime DDL. Deployed to Vercel + Supabase (project ref `ldtqjzfftjbzcvgktgbt`, us-west-2; push to `main` auto-deploys).

**Before deploying, touching DB config, or changing env vars: read [`docs/operations.md`](docs/operations.md)**; env contracts, secrets, Supabase pooler URLs, `sslmode`, DDL (`DATABASE_URL_UNPOOLED`) vs runtime URLs.

## Commands

```sh
pnpm dev            # dev server
pnpm check          # prisma contract emit + typegen + oxfmt/oxlint/tsc — run before committing
pnpm test           # force-resets expense_test + suite (needs local Postgres: brew services start postgresql@18)
pnpm db:push        # sync dev DB to the contract (prisma db update)
pnpm db:migrate     # apply planned migrations (prisma db migrate)
pnpm build && pnpm start   # prod build + serve on :3000
```

`./scripts/deploy` (check → tests → db sync → vercel prod), `./scripts/clone` (prod → local), `pnpm setup:push` (FastMail push): `docs/operations.md` / `docs/deploy.md`.

## Conventions that shape every edit

- **Dark mode**: system-only; **every component adds `dark:` variants for all color classes** (map: `docs/dark-mode.md`). Use shared primitives (`Button`, `Input`, `Select`, `Card`, `EmptyState`).
- **State**: all reads/writes via `app/lib/db/`, scoped by `accountId`; never read state client-side. Route types from `./+types/<name>`; alias `~/*` → `app/*`.
- **MCP**: `/mcp` (Streamable HTTP, OAuth 2.1, Settings → Agents & API) exposes the store: capture_receipt (OCR/DeepSeek, sha256 cache), log_mileage, list_expenses, reports, reconcile. `docs/mcp.md`.
- **Maps**: Leaflet client-only dynamic import; Nominatim/OSRM, no keys.
- **Validation**: plain helpers (`app/lib/validation.ts`, `app/lib/completeness.ts`); Zod only for MCP arg schemas.
- **Security**: scrypt hashing; escape untrusted text (`escapeHtml`); sanitize filenames; authenticated responses `Cache-Control: private`; HTML denies framing (HSTS from Vercel); untrusted URL fetches only via `fetchPublicUrl` (SSRF checks per redirect hop).
- **Logging**: only `.assert`/`.error`/`.info`/`.warn`, prefixed with a context tag.

## Code style

`pnpm check` enforces oxfmt + oxlint + tsc (strict, no `any`, hooks rules, no `console.log`). Judgment conventions (interfaces over types, string unions not enums, no classes, early returns, import grouping, a11y contract, conventional commits): **[`docs/code-style.md`](docs/code-style.md)**.

Prose voice (comments, docs, commit messages): go easy on em dashes. Prefer commas, colons, semicolons, or parentheses, and vary the choice; an em dash here and there is fine, a habit is not. Comments explain why, not what.

## Gotchas (current-state rules)

- **Timezone**: the server runs UTC (Vercel); never compute a user-facing "today" server-side (`todayDate()` in a loader/action is a bug: PST evenings get tomorrow). Client code owns all timezone math: forms default dates from `todayDate()` in the browser; dashboard future-badge/rate lines are computed post-mount; reconciliation sends its local `today` with the complete request. MCP tools store UTC-today when `date` is omitted and return `serverUtcNow` for the client to convert. No server timezone config exists; keep it that way.
- **Completeness badge**: incomplete when missing date/amount/merchant/category/report (image NOT a factor); mileage needs 2+ route addresses. Display-only, no save gate.
- **FX conversion**: foreign-currency receipts convert to USD at the ECB reference rate for the expense date (IRS payment-date rule), via Frankfurter (`app/lib/fx.server.ts`, no key; weekends roll back to the prior business day; future dates/unsupported currencies → no rate → stored as-is with a note). `amount` is ALWAYS the USD number every consumer uses; `currency`/`originalAmount`/`fxRate` on a receipt are provenance. The editor re-converts on date change unless the amount was hand-edited (the mileage manual-amount rule). No historical backfill: pre-feature rows stay as captured.
- **Pooler caps**: runtime uses transaction pooler (port 6543, per-instance `max: 2`, 30s user cache); DDL uses `DATABASE_URL_UNPOOLED` (5432). Never push `pool_size` above 80% of `max_connections`; see the `(EMAXCONN)` incident in `docs/operations.md`.
- **Auth**: rows scoped by `accountId` (full isolation); email verification gates sign-in (7-day TTL, resend 1/day); `APP_EMAIL` bootstrap for empty DBs; every loader/action calls `requireUser(request)`.
- **FastMail onboarding & recovery**: `/onboarding`: a valid FastMail API token proves mailbox control, so `emailVerifiedAt` is stamped without an emailed link; attach = sign in with YOUR account (the email may differ from the mailbox, so never force the token-address account, e.g. a bootstrap account). Password recovery at `/reset-password` (single-use link, 7-day TTL, once/day). Home-page `connect-email` highlight is gated on no connected mailbox (`FeatureHighlight`). Welcome panel gated by the `welcomePending` setting. See `docs/email-connections.md` → FastMail onboarding + Discovery surfaces, `docs/accounts.md` → Password recovery.
- **`prisma/backup.sql`** (~300MB) stays out of Vercel uploads; keep the `.vercelignore` `backup*.sql` entries.
- **Report rename**: expenses update; image filenames don't (re-save rewrites them).
- **PDF/OCR stack is lazy**: pdfkit, pdfjs, tesseract, the canvas, resvg, puppeteer/chromium, and the MCP SDK all load via dynamic imports only when used (see `app/lib/receipt-ocr.server.ts`, `email-render.server.ts`, `mcp.server.ts`). Vercel's tracer drops what it can't follow statically, so each has a shipping shim: pdf.worker.mjs (dynamic import + `globalThis.pdfjsWorker`), tesseract's wasm core (patched to the base64-embedded `.wasm.js`, `patches/tesseract.js@7.0.0.patch`), and pdfkit's standard fonts (the `vendor/pdfkit-standard-fonts` tracer-bridge package, see its comment). Real coverage is `test/pdf-ocr.test.ts` + post-deploy `/api/smoke`, which now gates deploys: `scripts/deploy` and the `pdf-ocr-smoke` workflow job both roll the deployment back when it fails (broken code is live for minutes, not hours). Deploy order: secretlint → check & test → migrate-db (never before tests) → smoke.
- **Sentry cron monitors**: `withMonitor` needs an explicit `Sentry.flush()` before the route returns; the SDK's auto-flush is Edge-runtime-only, so on Node serverless the ok check-in is dropped when the lambda freezes and every run times out (both daily crons follow the pattern; see `docs/operations.md`).
- **deepmerge-ts 7.1.5** advisory (transitive via `@prisma/config`): unfixed by design, ~zero practical risk; if `npm audit` flags it, override `^8.0.0` and verify prisma still works.
- **FastMail API tokens can't submit mail** (`EmailSubmission`/`Identity` → 403 `urn:ietf:params:jmap:submission` disallowed): connected-mailbox confirmations are _written to the owner's Inbox_ via `Email/import`, never sent. See `docs/email-connections.md`.
- Reconciliation (`docs/reconciliation.md`), receipts-by-email (`docs/receipts-by-email.md`), connected email accounts (`docs/email-connections.md`), accounts (`docs/accounts.md`), image keys `images/{accountId}/…` named `YYYY-MM-DD_REPORT_FILE.ext` (legacy migration: `scripts/migrate-legacy`).
