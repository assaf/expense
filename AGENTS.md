# Agent guide — Expensify

Personal expense tracker (receipts + mileage). React Router v8 framework mode,
Tailwind v4. Storage is a facade in `app/lib/store.server.ts`: Postgres + cloud
images when `DATABASE_URL`/`BLOB_READ_WRITE_TOKEN` (Vercel Blob) or
`S3_ENDPOINT`+`S3_BUCKET` (MinIO/R2/S3) are set; file-based CSVs under `data/`
otherwise. Dev/tests run on local Postgres (`expensify_dev`/`expensify_test`)

- MinIO (`docker compose up -d`). Deployed to Coolify.

## Commands

```bash
pnpm dev        # dev server (port 5173)
pnpm check      # react-router typegen + vp check (format/lint/typecheck)
pnpm build      # production build
pnpm start      # serve production build (port 3000)
```

Run `pnpm check` before committing.

## Stack & conventions

- **Routing**: React Router v8, flat file routes in `app/routes/`. `app/routes.ts`
  wires an index + `flatRoutes()`. Loaders/actions are server-only.
- **Types**: import route types from `./+types/<name>`. Path alias `~/*` → `app/*`.
- **State**: Postgres (`expenses`, `reports`, `categories`, `settings`,
  `mileage` tables) in prod and in local dev/tests; CSVs under `data/` only in
  the no-infra fallback. Never read state on the client; all reads/writes go
  through `app/lib/store.server.ts` (facade) → `app/lib/store/local.server.ts`
  or `app/lib/store/pg.server.ts`.
- **Images**: Vercel Blob `images/…` pathnames, S3-compatible (MinIO locally)
  via `@aws-sdk/client-s3`, or local `data/images/`. See `app/lib/images.server.ts`.
  Named `YYYY-MM-DD_REPORT_FILE.ext` once a receipt has a date + report;
  otherwise a temp id-based name (renamed on save).
- **Maps**: Leaflet is loaded **dynamically, client-only** (it touches `navigator`
  at load and breaks SSR). Geocoding via Nominatim, routing via OSRM — no API
  keys. See `app/lib/maps.server.ts`.
- **Validation**: Zod in `app/lib/validation.ts`; completeness rules in
  `app/lib/completeness.ts`.
- **Formatting**: double quotes, 2-space indent, 80 cols (Oxfmt via `vp`).
  No `console.log` (use `.info/.warn/.error/.assert`). Functional components,
  no enums, prefer early returns.

## Key files

| File                              | Role                                               |
| --------------------------------- | -------------------------------------------------- |
| `app/routes/_index.tsx`           | Main list, add buttons, paste/upload image.        |
| `app/routes/expense.$id.tsx`      | Receipt + mileage editor (save/cancel/delete).     |
| `app/routes/expense.$id.image.ts` | Serve / replace / delete receipt image.            |
| `app/routes/api.route.ts`         | Recompute mileage distance + amount.               |
| `app/routes/export.*`             | PDF per report + ZIP of everything.                |
| `app/routes/settings.tsx`         | Reports, categories, mileage rates, home location. |
| `app/lib/store.server.ts`         | Storage facade (local CSV vs Postgres).            |
| `app/lib/store/local.server.ts`   | File-based backend (dev/tests).                    |
| `app/lib/store/pg.server.ts`      | Postgres backend (prod).                           |
| `app/lib/maps.server.ts`          | Geocode + route (Nominatim/OSRM).                  |

## Gotchas

- **No auth** — a single-user personal app. Put it behind Coolify basic auth,
  Vercel Deployment Protection, or a private network in production.
- Tests and dev require local Postgres and MinIO up (`docker compose up -d`);
  without them the suite fails to connect. `pnpm test` uses `expensify_test`.
- When renaming a report, expenses update but image files are **not** auto-renamed
  (they keep their old convention name). Re-saving each receipt rewrites the name.
- `vp check` excludes `vite.config.ts` from tsgolint (recursion limits); tsc
  still type-checks it.
