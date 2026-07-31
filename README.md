# Expensify

Personal expense tracking with receipts and mileage.

What it does:

- Log expenses two ways: receipt-based (upload/scan an image, add date, report,
  category, merchant, amount) and mileage (drive route on a map — Leaflet + OSRM
  — with configurable per-year mileage rates)
- Organize into reports and categories; every receipt image is stored and
  auto-renamed to a convention (YYYY-MM-DD_Report_Name.jpg)
- Export: PDF per report (with embedded receipt images) and a ZIP of everything
- Settings: reports, categories, mileage rates, home location for mileage routes

Stack:

- React Router v8 (framework mode) + Tailwind v4, TypeScript
- Postgres via Prisma — accounts, users, expenses, reports, categories,
  settings, mileage, image blobs
- Images: Vercel Blob in prod, Postgres BYTEA in dev/test
- Deployed on Vercel + Neon (git push to main auto-deploys)

Auth & accounts (the recent work):

- Username/password login (scrypt-hashed), sessions via signed cookies
- Multi-user accounts: each account has its own data, users in the same account
  share everything, other accounts fully isolated
- New users join an account via an 8-char invite code (shown in Settings,
  regenerable); anyone can self-signup into a fresh account
- Image keys are namespaced per account so two accounts can never collide

## Accounts & sharing

Login is username/password (scrypt-hashed). Every expense, report, category,
and setting belongs to an **account**; everyone in an account shares them,
and accounts are fully isolated from each other.

- **Sign up** → creates a brand-new account (starts empty).
- **Join** → enter an account's invite code (Settings → Account) to share
  that account's data.
- The first account/user is bootstrapped from `APP_USERNAME`/`APP_PASSWORD`
  when the database is empty.

## What it does

- Track **receipt** expenses (date, merchant, amount, image, category, report)
  and **mileage** expenses (date, 2+ addresses, distance, amount, report).
- Mileage routes run **Home → stops → Home**; distance is computed via OSRM and
  the amount from a per-year mileage rate. Maps use Leaflet + OpenStreetMap —
  **no API keys required**.
- Incomplete expenses are highlighted so they're easy to finish.
- Paste (⌘V) or upload an image anywhere to start a new receipt.
- **Export**: each report as a PDF (grouped by category, with all receipt
  images), or everything as a ZIP (CSV + images named `YYYY-MM-DD_REPORT_FILE.ext`).

## State

Storage is Postgres-only via **Prisma** (`prisma/schema.prisma` is the
single schema source of truth; the client is generated to
`prisma/generated` by `pnpm build:prisma`). `DATABASE_URL` is required at
startup (the app exits with a clear error otherwise). Receipt images go to
Vercel Blob when `BLOB_READ_WRITE_TOKEN` is set (prod), or into Postgres
BYTEA when `IMAGE_BACKEND=pg` (dev/tests — no separate service). A missing
image backend is an error, never a silent disk fallback.

| Data                        | Images                                |
| --------------------------- | ------------------------------------- |
| `accounts` / `users` /      | Vercel Blob (`BLOB_READ_WRITE_TOKEN`) |
| `expenses` / `reports` /    | Postgres BYTEA (`IMAGE_BACKEND=pg`)   |
| `categories` / `settings` / |                                       |
| `mileage` / `image_blobs`   |                                       |

All reads/writes go through `app/lib/store.server.ts` (→
`app/lib/database.ts`, Prisma queries scoped by `accountId`); image storage
is behind `app/lib/images.server.ts` (`@vercel/blob` vs Prisma `imageBlob`).
Keys are `images/{accountId}/...` pathnames on every backend — namespaced
per account so two accounts can never collide on the same filename — and
data is portable between them. Schema changes: edit
`prisma/schema.prisma`, then `prisma migrate dev --name …` locally and
`pnpm db:push` (or `pnpm db:migrate`) before deploying.

### `data/` — migration source only

`data/` is gitignored and no longer read at runtime. It holds the original
CSVs + receipt images that `pnpm migrate-data` imports into Postgres/Blob:

| File             | Contents                                                     |
| ---------------- | ------------------------------------------------------------ |
| `expenses.csv`   | Every expense (receipt + mileage), the source of truth.      |
| `reports.csv`    | Report names.                                                |
| `categories.csv` | Tax category names.                                          |
| `mileage.csv`    | Derived: date, report, locations, distance for mileage rows. |
| `settings.csv`   | Home location + mileage rate per calendar year.              |
| `images/`        | Receipt images, named `YYYY-MM-DD_REPORT_FILE.ext`.          |

`data/` is gitignored. Not needed at runtime — the app only requires Postgres
(+ a cloud image backend).

## Quick start

## Environment variables

Load order: real `process.env` (Vercel dashboard, or inline) wins; a local
`.env` file fills the gaps. `DATABASE_URL` is required; `.env` is gitignored. if
(!hasDatabase()) {

**dev / test — local `.env`:**

```bash
# .env (project root, gitignored)
DATABASE_URL=postgres://assaf@localhost/expensify_dev   # include the local user
IMAGE_BACKEND=pg        # receipt images live in Postgres — no extra service
SESSION_SECRET=…         # signs the session cookie (random hex)
APP_USERNAME=…           # bootstrap: first account's username (empty DB only)
APP_PASSWORD=…           # bootstrap: first account's password (empty DB only)
```

On an empty database the first account + user are bootstrapped from
`APP_USERNAME`/`APP_PASSWORD` (fail-closed if missing); afterwards users are
created through the app's signup/join flow. `SESSION_SECRET` is always
required. `APP_USERNAME`/`APP_PASSWORD` can be removed from `.env` once you
have at least one user.

Tests intentionally hardcode `expensify_test` (Postgres incl. image blobs),
ignore the local database, and reset the schema from Prisma on each run
(`pnpm test:db:push` in the test setup).

**prod — Vercel:** set env vars in the project dashboard (Settings →
Environment Variables): `DATABASE_URL` (Vercel Postgres / Neon pooled URL),
`BLOB_READ_WRITE_TOKEN` (Vercel Storage → Blob → Tokens), `SESSION_SECRET`,
and (only until the first user exists) `APP_USERNAME` / `APP_PASSWORD`.
Vercel injects them at runtime; `.env` never exists there.

## Quick start

Prerequisites: Postgres running locally (`brew services start postgresql@18`).

```bash
createdb expensify_dev          # once
pnpm install
# create .env with the local values above
pnpm db:push                    # create the schema from prisma/schema.prisma
pnpm dev                        # reads .env
```

Running the server without `DATABASE_URL` exits immediately with a clear
error — there is no file-based fallback.

```bash
pnpm check        # prisma generate + typegen + format + lint + typecheck
pnpm build        # production build (build:prisma runs first)
pnpm start        # serve the production build (port 3000)
pnpm test         # resets expensify_test from Prisma and runs the suite
```

Node 26+ and pnpm 11+.

## Deployment

**Vercel (recommended):** the app deploys with Vercel's zero-config React
Router support — no preset needed. (`@vercel/react-router`'s `vercelPreset()`
is still pinned to React Router v7 as of this writing — track
[vercel/vercel#16730](https://github.com/vercel/vercel/issues/16730); the
zero-config path builds one SSR function that serves every route.)

1. Push to GitHub (already configured: `origin` → `assaf/expensify`).
2. In Vercel: **Add New → Project → Import `assaf/expensify`**. Framework is
   auto-detected as React Router; `vercel.json` pins the build command.
3. Set env vars in the project (Settings → Environment Variables):
   - `DATABASE_URL` — Vercel Postgres / Neon pooled URL. Tables are created
     automatically on first request.
   - `BLOB_READ_WRITE_TOKEN` — Vercel Storage → Blob → Tokens.
   - Node 26 is required (`engines`); pick it in project settings if Vercel
     doesn't match automatically.
4. Migrate the existing data once (from a machine with the CSVs):

   ```bash
   pnpm migrate-data   # or pnpm migrate-data:prod
   ```

   It imports the CSVs under `data/` into Postgres and uploads `data/images/*`
   to the configured image store (Blob or Postgres BYTEA with
   `IMAGE_BACKEND=pg`), keeping the same `images/<filename>` keys;
   already-uploaded files are skipped. Idempotent.

5. Deploy. Test the app is behind Deployment Protection or basic auth — the
   app has no built-in login (single-user personal tool).

```bash
./scripts/deploy            # check + tests + deploy
./scripts/deploy --skip-tests
```

Vercel has its own environment management (dashboard) — set `DATABASE_URL` and
`BLOB_READ_WRITE_TOKEN` there directly.

## Maps & geocoding

Uses free OpenStreetMap services (Nominatim for geocoding, OSRM for routing,
OSM raster tiles for the map). Rate-limited but fine for personal use. If OSRM
is unavailable, distance falls back to straight-line (marked "approx.").
