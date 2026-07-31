# Expensify

Personal expense tracking with receipts and mileage. Built with React Router
v8 (framework mode) + Tailwind v4. State lives in Postgres with receipt
images in Vercel Blob (prod) or Postgres BYTEA (dev/test, no extra service).
`DATABASE_URL` is required — there is no file-based fallback; `data/` exists
only as the migration source for `pnpm migrate-data`.

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

Storage is Postgres-only. `DATABASE_URL` is required at startup (the app
exits with a clear error otherwise). Receipt images go to Vercel Blob when
`BLOB_READ_WRITE_TOKEN` is set (prod), or into Postgres BYTEA when
`IMAGE_BACKEND=pg` (dev/tests — no separate service). A missing image backend
is an error, never a silent disk fallback.

| Data                        | Images                                |
| --------------------------- | ------------------------------------- |
| `expenses` / `reports` /    | Vercel Blob (`BLOB_READ_WRITE_TOKEN`) |
| `categories` / `settings` / | Postgres BYTEA (`IMAGE_BACKEND=pg`)   |
| `mileage` tables            |                                       |

All reads/writes go through `app/lib/store.server.ts` (→
`app/lib/store/database.ts`); image storage is behind
`app/lib/images.server.ts` (`@vercel/blob` vs Postgres `image_blobs`). Keys
are `images/...` pathnames on every backend, so data is portable between them.

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

Load order: real `process.env` (Vercel dashboard, Coolify app settings, or
inline) wins; a local `.env` file fills the gaps. `DATABASE_URL` is required;
`.env` is gitignored.

**dev / test — local `.env`:**

```bash
# .env (project root, gitignored)
DATABASE_URL=postgres://localhost/expensify_dev
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

Tests intentionally hardcode `expensify_test` (Postgres incl. image blobs) and
ignore the local database.

**prod — Vercel:** set env vars in the project dashboard (Settings →
Environment Variables): `DATABASE_URL` (Vercel Postgres / Neon pooled URL),
`BLOB_READ_WRITE_TOKEN` (Vercel Storage → Blob → Tokens), `SESSION_SECRET`,
and (only until the first user exists) `APP_USERNAME` / `APP_PASSWORD`.
Vercel injects them at runtime; `.env` never exists there.

**Coolify deploy — Infisical:** `scripts/deploy` mirrors Rentail and pulls
prod secrets from [Infisical](https://infisical.com) (`infisical export --env
prod > .env` + `infisical --env prod run -- coolify-ghcr-deploy --env-file
.env`); `GHCR_TOKEN` comes from the Infisical `dev` env. Requires `infisical
login` / `infisical init` once (writes `.infisical.json`). The one-off prod
migrations also run this way: `pnpm migrate-data:prod`.

## Quick start

Prerequisites: Postgres running locally (`brew services start postgresql@18`).

```bash
createdb expensify_dev          # once
pnpm install
# create .env with the local values above
pnpm dev                        # reads .env
```

Running the server without `DATABASE_URL` exits immediately with a clear
error — there is no file-based fallback.

```bash
pnpm check        # typegen + format + lint + typecheck
pnpm build        # production build
pnpm start        # serve the production build (port 3000)
pnpm test         # runs against expensify_test (Postgres only)
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
   infisical --env prod run -- pnpm migrate-data   # or pnpm migrate-data:prod
   ```

   It imports the CSVs under `data/` into Postgres and uploads `data/images/*`
   to the configured image store (Blob or Postgres BYTEA with
   `IMAGE_BACKEND=pg`), keeping the same `images/<filename>` keys;
   already-uploaded files are skipped. Idempotent.

5. Deploy. Test the app is behind Deployment Protection or basic auth — the
   app has no built-in login (single-user personal tool).

**Coolify (Docker):** `./scripts/deploy` — mirrors Rentail: `pnpm check`,
tests, build/push to GHCR, then `infisical export --env prod > .env` and
`infisical --env prod run -- coolify-ghcr-deploy --env-file .env`. Requires the
Infisical `dev` env to hold `GHCR_TOKEN` and the `prod` env to hold the runtime
secrets (`DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`) plus `COOLIFY_TOKEN`.

```bash
./scripts/deploy            # check + tests + deploy
./scripts/deploy --skip-tests
```

Vercel has its own environment management (dashboard), independent of
Infisical — set `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` there directly.

## Maps & geocoding

Uses free OpenStreetMap services (Nominatim for geocoding, OSRM for routing,
OSM raster tiles for the map). Rate-limited but fine for personal use. If OSRM
is unavailable, distance falls back to straight-line (marked "approx.").
