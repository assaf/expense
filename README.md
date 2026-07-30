# Expensify

Personal expense tracking with receipts and mileage. Replaces Expensify for a
single user. Built with React Router v8 (framework mode) + Tailwind v4, deployed
to Coolify via a Docker image, the same flow as the Rentail project.

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

All state is file-based on disk (no database), under `data/`:

| File             | Contents                                                     |
| ---------------- | ------------------------------------------------------------ |
| `expenses.csv`   | Every expense (receipt + mileage), the source of truth.      |
| `reports.csv`    | Report names.                                                |
| `categories.csv` | Tax category names.                                          |
| `mileage.csv`    | Derived: date, report, locations, distance for mileage rows. |
| `settings.csv`   | Home location + mileage rate per calendar year.              |
| `images/`        | Receipt images, named `YYYY-MM-DD_REPORT_FILE.ext`.          |

In production, mount a **persistent volume** at `/app/data` (set `DATA_DIR` to
override). The directory is created automatically on first run.

## Quick start

```bash
pnpm install
pnpm dev          # http://localhost:5173
```

```bash
pnpm check        # typegen + format + lint + typecheck
pnpm build        # production build
pnpm start        # serve the production build (port 3000)
```

Node 26+ and pnpm 11+.

## Deployment (Coolify)

Same flow as Rentail: build a Docker image, push to GHCR, deploy with
`coolify-ghcr-deploy`.

1. Mount a persistent volume at `/app/data`.
2. (Optional) Put the service behind Coolify basic auth or a private network —
   the app has no built-in login, since it's a single-user personal tool.
3. Build & deploy:

```bash
GHCR_TOKEN=… COOLIFY_URL=… COOLIFY_TOKEN=… COOLIFY_APP_ID=… ./scripts/deploy
```

The `Dockerfile` is a two-stage build (no database, no build-time secrets).

## Maps & geocoding

Uses free OpenStreetMap services (Nominatim for geocoding, OSRM for routing,
OSM raster tiles for the map). Rate-limited but fine for personal use. If OSRM
is unavailable, distance falls back to straight-line (marked "approx.").
