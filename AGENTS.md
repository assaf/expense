# Agent guide — Expense

Personal expense tracker (receipts + mileage). React Router v8 framework mode, Tailwind v4, Postgres via **Prisma** (`prisma/schema.prisma` = source of truth; client in `app/lib/prisma.server.ts`). Reads/writes go through per-domain modules in `app/lib/db/` (file map: `docs/files.md`); receipt images in Postgres BYTEA (`app/lib/images.server.ts`); no runtime DDL. Deployed to Vercel + Supabase (project ref `ldtqjzfftjbzcvgktgbt`, us-west-2; push to `main` auto-deploys).

**Before deploying, touching DB config, or changing env vars: read [`docs/operations.md`](docs/operations.md)** — env contracts, secrets, Supabase pooler URLs, `sslmode`, DDL (`DATABASE_URL_UNPOOLED`) vs runtime URLs.

## Commands

```sh
pnpm dev            # dev server
pnpm check          # prisma generate + typegen + oxfmt/oxlint/tsc — run before committing
pnpm test           # force-resets expense_test + suite (needs local Postgres: brew services start postgresql@18)
pnpm db:push        # sync dev DB to schema.prisma
pnpm db:migrate     # apply prisma/migrations (deploy)
pnpm build && pnpm start   # prod build + serve on :3000
```

`./scripts/deploy` (check → tests → db sync → vercel prod), `./scripts/clone` (prod → local), `pnpm setup:push` (FastMail push): `docs/operations.md` / `docs/deploy.md`.

## Conventions that shape every edit

- **Dark mode**: system-only; **every component adds `dark:` variants for all color classes** (map: `docs/dark-mode.md`). Use shared primitives (`Button`, `Input`, `Select`, `Card`, `EmptyState`).
- **State**: all reads/writes via `app/lib/db/`, scoped by `accountId`; never read state client-side. Route types from `./+types/<name>`; alias `~/*` → `app/*`.
- **MCP**: `/mcp` (Streamable HTTP, OAuth 2.1, Settings → Agents & API) exposes the store — capture_receipt (OCR/DeepSeek, sha256 cache), log_mileage, list_expenses, reports, reconcile. `docs/mcp.md`.
- **Maps**: Leaflet client-only dynamic import; Nominatim/OSRM, no keys.
- **Validation**: plain helpers (`app/lib/validation.ts`, `app/lib/completeness.ts`); Zod only for MCP arg schemas.
- **Security**: scrypt hashing; escape untrusted text (`escapeHtml`); sanitize filenames; authenticated responses `Cache-Control: private`; HTML denies framing (HSTS from Vercel); untrusted URL fetches only via `fetchPublicUrl` (SSRF checks per redirect hop).
- **Logging**: only `.assert`/`.error`/`.info`/`.warn`, prefixed with a context tag.

## Code style

`pnpm check` enforces oxfmt + oxlint + tsc (strict, no `any`, hooks rules, no `console.log`). Judgment conventions (interfaces over types, string unions not enums, no classes, early returns, import grouping, a11y contract, conventional commits): **[`docs/code-style.md`](docs/code-style.md)**.

## Gotchas (current-state rules)

- **Completeness badge**: incomplete when missing date/amount/merchant/category/report (image NOT a factor); mileage needs 2+ route addresses. Display-only, no save gate.
- **Pooler caps**: runtime uses transaction pooler (port 6543, per-instance `max: 2`, 30s user cache); DDL uses `DATABASE_URL_UNPOOLED` (5432). Never push `pool_size` above 80% of `max_connections` — see the `(EMAXCONN)` incident in `docs/operations.md`.
- **Auth**: rows scoped by `accountId` (full isolation); email verification gates sign-in (7-day TTL, resend 1/day); `APP_EMAIL` bootstrap for empty DBs; every loader/action calls `requireUser(request)`.
- **`prisma/backup.sql`** (~300MB) stays out of Vercel uploads — keep the `.vercelignore` `backup*.sql` entries.
- **Report rename**: expenses update; image filenames don't (re-save rewrites them).
- **PDF/OCR**: Vercel's tracer drops pdf.worker/tesseract wasm — real coverage is `test/pdf-ocr.test.ts` + post-deploy `/api/smoke`. Deploy order: secretlint → check & test → migrate-db (never before tests) → pdf-ocr-smoke. `docs/deploy.md`.
- **deepmerge-ts 7.1.5** advisory (transitive via `@prisma/config`): unfixed by design, ~zero practical risk; if `npm audit` flags it, override `^8.0.0` and verify prisma still works.
- **FastMail API tokens can't submit mail** (`EmailSubmission`/`Identity` → 403 `urn:ietf:params:jmap:submission` disallowed): connected-mailbox confirmations are _written to the owner's Inbox_ via `Email/import`, never sent. See `docs/email-connections.md`.
- Reconciliation (`docs/reconciliation.md`), receipts-by-email (`docs/receipts-by-email.md`), connected email accounts (`docs/email-connections.md`), accounts (`docs/accounts.md`), image keys `images/{accountId}/…` named `YYYY-MM-DD_REPORT_FILE.ext` (legacy migration: `scripts/migrate-legacy`).
