# Expensify

Personal expense tracking with receipts and mileage. Replaces Expensify for a
single user. Built with React Router v8 (framework mode) + Tailwind v4. State
lives in Postgres with receipt images in Vercel Blob when `DATABASE_URL` +
`BLOB_READ_WRITE_TOKEN` are set (Vercel/Coolify production); otherwise it falls
back to local files under `data/` (dev and tests).

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

Two interchangeable storage backends, selected by environment:

| Backend      | Selected when                   | Data                        | Images                                |
| ------------ | ------------------------------- | --------------------------- | ------------------------------------- |
| **Postgres** | `DATABASE_URL` set              | `expenses` / `reports` /    | Vercel Blob if                        |
|              |                                 | `categories` / `settings` / | `BLOB_READ_WRITE_TOKEN` set,          |
|              |                                 | `mileage` tables            | else S3 (`S3_ENDPOINT` + `S3_BUCKET`) |
| **Local**    | `DATABASE_URL` unset (no-infra) | CSVs under `data/`          | `data/images/`                        |

Both expose the same API through `app/lib/store.server.ts` (a facade over
`app/lib/store/local.server.ts` and `app/lib/store/pg.server.ts`); image
storage is behind `app/lib/images.server.ts` (local fs vs `@vercel/blob` vs
S3-compatible via `@aws-sdk/client-s3` — MinIO locally, or R2/S3). Keys are
`images/...` pathnames on both cloud backends, so data is portable between them.

Local files:

| File             | Contents                                                     |
| ---------------- | ------------------------------------------------------------ |
| `expenses.csv`   | Every expense (receipt + mileage), the source of truth.      |
| `reports.csv`    | Report names.                                                |
| `categories.csv` | Tax category names.                                          |
| `mileage.csv`    | Derived: date, report, locations, distance for mileage rows. |
| `settings.csv`   | Home location + mileage rate per calendar year.              |
| `images/`        | Receipt images, named `YYYY-MM-DD_REPORT_FILE.ext`.          |

`data/` is gitignored; in Docker/Coolify production mount a persistent volume
at `/app/data` (set `DATA_DIR` to override). The directory is created
automatically on first run.

## Quick start

## Environment variables

Load order: real `process.env` (Vercel dashboard, Coolify app settings, or
inline) wins; a local `.env` file fills the gaps; otherwise the app falls
back to file-based storage. `.env` is gitignored.

**dev / test — local `.env`:**

```bash
# .env (project root, gitignored)
DATABASE_URL=postgres://localhost/expensify_dev
S3_ENDPOINT=http://localhost:9000
S3_BUCKET=expensify
```

Tests intentionally hardcode `expensify_test` + MinIO (no `.env` needed) and
ignore the local database.

**prod — Vercel:** set env vars in the project dashboard (Settings →
Environment Variables): `DATABASE_URL` (Vercel Postgres / Neon pooled URL) and
`BLOB_READ_WRITE_TOKEN` (Vercel Storage → Blob → Tokens). Vercel injects them
at runtime; `.env` never exists there.

**Coolify deploy — Infisical:** `scripts/deploy` mirrors Rentail and pulls
prod secrets from [Infisical](https://infisical.com) (`infisical export --env
prod > .env` + `infisical --env prod run -- coolify-ghcr-deploy --env-file
.env`); `GHCR_TOKEN` comes from the Infisical `dev` env. Requires `infisical
login` / `infisical init` once (writes `.infisical.json`). The one-off prod
migrations also run this way: `pnpm migrate-data:prod`.

## Quick start

Prerequisites: Postgres running locally (`brew services start postgresql@18`),
MinIO (`docker compose up -d`; first run creates the `expensify` bucket).

```bash
createdb expensify_dev          # once
pnpm install
# create .env with the local values above
pnpm dev                        # reads .env
```

Running the server without env vars falls back to local files (CSVs under
`data/`).

```bash
pnpm check        # typegen + format + lint + typecheck
pnpm build        # production build
pnpm start        # serve the production build (port 3000)
pnpm test         # runs against expensify_test + MinIO (both must be up)
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
   to Blob (keeping the same `images/<filename>` keys; already-uploaded files
   are skipped). Idempotent.

5. Deploy. Test the app is behind Deployment Protection or basic auth — the
   app has no built-in login (single-user personal tool).

**Coolify (Docker):** `./scripts/deploy` — mirrors Rentail: `pnpm check`,
tests, build/push to GHCR, then `infisical export --env prod > .env` and
`infisical --env prod run -- coolify-ghcr-deploy --env-file .env`. Requires the
Infisical `dev` env to hold `GHCR_TOKEN` and the `prod` env to hold the runtime
secrets (`DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, or `S3_ENDPOINT`/`S3_BUCKET`
for local-file storage) plus `COOLIFY_TOKEN`.

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
