# Agent guide — Expensify

Personal expense tracker (receipts + mileage). React Router v8 framework mode,
Tailwind v4. Storage is Postgres-only (required), accessed through **Prisma**
(schema in `prisma/schema.prisma` — the single source of truth; client in
`app/lib/prisma.server.ts`). Domain reads/writes go through
`app/lib/store.server.ts` → `app/lib/database.ts`; receipt images via
`app/lib/images.server.ts` (Vercel Blob when `BLOB_READ_WRITE_TOKEN` is set,
or Postgres BYTEA with `IMAGE_BACKEND=pg` — the dev/test default; no separate
service needed). There is **no runtime DDL** — schema changes go through
Prisma (`prisma migrate dev` locally, `pnpm db:push` on deploy).
Dev/tests run on local Postgres (`expensify_dev`/`expensify_test`) only.
Deployed to **Vercel** (Neon Postgres; GitHub push to `main` auto-deploys).

## Commands

```bash
pnpm dev             # dev server
pnpm check           # prisma generate + react-router typegen + vp check
pnpm build           # production build
pnpm build:prisma    # prisma generate (writes prisma/generated, gitignored)
pnpm start           # serve production build (port 3000)
pnpm db:push         # sync the dev database to schema.prisma
pnpm db:migrate      # apply prisma/migrations (deploy)
pnpm test            # force-resets expensify_test schema + 79 tests (incl. image blobs)
./scripts/deploy [--skip-tests]  # check + tests + prod db sync + vercel deploy --prod + open site
# NOTE: prod runs on Vercel (Neon Postgres) — `./scripts/deploy` handles schema
# sync (preflight + db push, via `vercel env pull`), CLI deploy, and opening the
# site. `git push origin main` also auto-deploys. Schema changes: `prisma migrate
# dev` locally, then run deploy to sync prod (migration history exists since Jul
# 2026).
```

Run `pnpm check` before committing.

## Secrets

Env load order: `process.env` (Vercel/inline) → local `.env` (via dotenv in
`app/lib/env.ts`). `DATABASE_URL` is required — no file fallback. Dev/test use
`.env` (`DATABASE_URL`, `IMAGE_BACKEND=pg`, and auth: `APP_USERNAME`,
`APP_PASSWORD`, `SESSION_SECRET`); prod uses the Vercel dashboard
(`DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, plus the same three auth vars). Pull
prod env with `npx vercel env pull --environment=production .env.prod` (use
`DATABASE_URL_UNPOOLED` for psql/prisma DDL). Tests hardcode local services
(`expensify_test`, image blobs in Postgres), not `.env`.

Receipts-by-email adds optional vars: `RESEND_API_KEY`, `INBOUND_EMAIL_WEBHOOK_SECRET`,
`INBOUND_EMAIL_FROM`, `INBOUND_EMAIL_ADDRESS`, `DEEPSEEK_API_KEY`,
`DEEPSEEK_MODEL` (default `deepseek-v4-flash`), `RECEIPT_OCR_MODE`
(`auto` default | `deepseek` | `tesseract`). All optional — the webhook route
returns 503 when unconfigured and everything else still works.

## Stack & conventions

- **Routing**: React Router v8, flat file routes in `app/routes/`. `app/routes.ts`
  wires an index + `flatRoutes()`. Loaders/actions are server-only.
- **Types**: import route types from `./+types/<name>`. Path alias `~/*` → `app/*`.
- **State**: Postgres via Prisma (schema.prisma) — accounts, users, expenses,
  reports, categories, settings, mileage, image_blobs. Required, everywhere.
  Never read state on the client; all reads/writes go through
  `app/lib/store.server.ts` → `app/lib/database.ts` (Prisma queries, scoped
  by `accountId`). `prisma/generated` is the generated client (gitignored,
  produced by `pnpm build:prisma`).
- **Images**: Vercel Blob `images/…` pathnames when `BLOB_READ_WRITE_TOKEN`
  is set, or Postgres BYTEA (`image_blobs` table) with `IMAGE_BACKEND=pg` —
  used by dev/tests. No local fallback. See `app/lib/images.server.ts`.
  **Keys are namespaced per account** (`images/{accountId}/…`) so the same
  filename in two accounts never collides on either backend; every
  save/read/rename/delete takes the owning `accountId`. Named
  `YYYY-MM-DD_REPORT_FILE.ext` once a receipt has a date + report;
  otherwise a temp id-based name (renamed on save). Legacy (pre-account)
  keys are rewritten automatically by `initStore` (`migrateImageBlobKeys`).
- **Maps**: Leaflet is loaded **dynamically, client-only** (it touches `navigator`
  at load and breaks SSR). Geocoding via Nominatim, routing via OSRM — no API
  keys. See `app/lib/maps.server.ts`.
- **Validation**: Zod in `app/lib/validation.ts`; completeness rules in
  `app/lib/completeness.ts`.
- **Formatting**: double quotes, 2-space indent, 80 cols (Oxfmt via `vp`).
  No `console.log` (use `.info/.warn/.error/.assert`). Functional components,
  no enums, prefer early returns.

## Key files

| File                               | Role                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `app/routes/_index.tsx`            | Main list, add buttons, paste/upload image.                                                                             |
| `app/routes/expense.$id.tsx`       | Receipt + mileage editor (save/cancel/delete).                                                                          |
| `app/routes/expense.$id.image.ts`  | Serve / replace / delete receipt image.                                                                                 |
| `app/routes/api.route.ts`          | Recompute mileage distance + amount.                                                                                    |
| `app/routes/export.*`              | PDF per report + ZIP of everything.                                                                                     |
| `app/routes/settings.tsx`          | Reports, categories, mileage rates, home location, receipts-by-email sender.                                            |
| `app/routes/api.inbound-email.ts`  | Resend inbound webhook (public, signature-verified; `maxDuration: 60`).                                                 |
| `app/routes/login.tsx`             | Sign in / create account / join by invite code.                                                                         |
| `app/routes/sign-out.ts`           | Destroys the session, redirects to /login.                                                                              |
| `app/lib/auth.server.ts`           | Auth: session storage, `requireUser`, login/signup.                                                                     |
| `app/lib/passwords.ts`             | scrypt hashing + invite-code generation.                                                                                |
| `app/lib/prisma.server.ts`         | Prisma client singleton (PrismaPg adapter).                                                                             |
| `app/lib/inbound-email.server.ts`  | Receipt-by-email pipeline: signature, date, attachment pick, expense create, replies.                                   |
| `app/lib/receipt-ai.server.ts`     | DeepSeek extraction client (text + vision attempt, JSON mode).                                                          |
| `app/lib/receipt-ocr.server.ts`    | OCR (tesseract fallback) + PDF text/render (pdfjs + @napi-rs/canvas).                                                   |
| `app/lib/receipt-render.server.ts` | HTML→text + text→PNG receipt image (resvg + bundled JetBrains Mono).                                                    |
| `app/lib/reply.server.ts`          | Failure/partial reply emails via Resend.                                                                                |
| `prisma/schema.prisma`             | Single schema source of truth (9 models).                                                                               |
| `prisma/migrations/0_init`         | Baseline migration (fresh DBs via `prisma migrate`).                                                                    |
| `scripts/preflight-prod.mjs`       | Idempotent pre-account baseline SQL for prod (pre-`db push`).                                                           |
| `scripts/import-expensify.ts`      | API-driven Expensify import: effective SmartScan fields + receipt images (login-gated; `--cookie` or `--receipts-dir`). |
| `app/lib/store.server.ts`          | Storage entry point (Postgres only).                                                                                    |
| `app/lib/database.ts`              | Postgres backend (accounts/users + scoped rows).                                                                        |
| `app/lib/maps.server.ts`           | Geocode + route (Nominatim/OSRM).                                                                                       |

## Gotchas

- **Auth & accounts**: multi-user access control with account-level sharing.
  Users live in Postgres (`users`, `accounts`); every expense, report,
  category, setting, and mileage row is scoped by `accountId`. Users in the
  same account share everything; other accounts are fully isolated (all
  reads and writes are scoped — see `app/lib/database.ts`).
  - Sign in with username/password (scrypt-hashed in `users.passwordHash`).
  - Signup creates a new account; joining uses the account's invite code
    (shown in Settings, regenerable). Session = signed HttpOnly cookie
    (`SESSION_SECRET`, 30-day max age).
  - **Bootstrap**: on an empty database, the first account + user are
    created from `APP_USERNAME`/`APP_PASSWORD` (fail-closed if missing).
    Single-user era rows are adopted into that account automatically. This
    is app-side data seeding (`initStore` in database.ts, memoized per
    process) — the SCHEMA itself is managed by Prisma (no runtime DDL).
  - Every loader/action calls `requireUser(request)` and passes
    `user.accountId` to the store; the root loader guards all routes.
  - Tests seed two accounts + three users; `launchBrowser.ts` signs in as
    `testuser`; `test/auth.test.ts` covers login, signup, invite-code join,
    sign-out, and cross-account isolation.
- Tests and dev require local Postgres up (`brew services start postgresql@18`);
  without it the suite fails to connect. `pnpm test` uses `expensify_test`.
  No MinIO/other services needed — images live in Postgres (`IMAGE_BACKEND=pg`).
- When renaming a report, expenses update but image files are **not** auto-renamed
  (they keep their old convention name). Re-saving each receipt rewrites the name.
- `vp check` excludes `vite.config.ts` from tsgolint (recursion limits); tsc
  still type-checks it.
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
    email body (text or HTML→text) becomes the receipt image.
  - PDF attachments are stored as rendered PNGs; the stored image is always
    browser-displayable (HEIC/BMP/TIFF → PNG via sharp).
  - The hosted DeepSeek API is text-only today — image OCR falls back to
    tesseract.js (CDN worker/lang at runtime). `RECEIPT_OCR_MODE=deepseek`
    forces vision-only. Don't expect image input to work until DeepSeek ships
    it on the hosted API.
  - Heavy deps (sharp, @resvg/resvg-js, @napi-rs/canvas, tesseract.js,
    pdfjs-dist) are Node-runtime only; native modules must stay external in
    the server build (Vite SSR externalizes node_modules by default).
