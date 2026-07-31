# Agent guide — Expensify

Personal expense tracker (receipts + mileage). React Router v8 framework mode,
Tailwind v4. Storage is Postgres-only (required): all reads/writes go through
`app/lib/store.server.ts` → `app/lib/store/database.ts`; receipt images via
`app/lib/images.server.ts` (Vercel Blob when `BLOB_READ_WRITE_TOKEN` is set,
or Postgres BYTEA with `IMAGE_BACKEND=pg` — the dev/test default; no separate
service needed).
Dev/tests run on local Postgres (`expensify_dev`/`expensify_test`) only.
Deployed to Coolify.

## Commands

```bash
pnpm dev        # dev server (port 5173) — env from Infisical (--env dev)
pnpm check      # react-router typegen + vp check (format/lint/typecheck)
pnpm build      # production build
pnpm start      # serve production build (port 3000)
pnpm test       # 30 tests against local Postgres (expensify_test, incl. image blobs)
./scripts/deploy [--skip-tests]  # check + tests + GHCR push + Coolify (Infisical)
```

Run `pnpm check` before committing.

## Secrets

Env load order: `process.env` (Vercel/Coolify/inline) → local `.env` (via
dotenv in `app/lib/env.ts`). `DATABASE_URL` is required — no file fallback.
Dev/test use `.env`
(`DATABASE_URL`, `IMAGE_BACKEND=pg`); prod uses the Vercel dashboard
(`DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`); `scripts/deploy` and
`pnpm migrate-data:prod` pull prod secrets from Infisical (`.infisical.json`,
same pattern as Rentail). Tests hardcode local services (`expensify_test`,
image blobs in Postgres), not `.env`/Infisical.

## Stack & conventions

- **Routing**: React Router v8, flat file routes in `app/routes/`. `app/routes.ts`
  wires an index + `flatRoutes()`. Loaders/actions are server-only.
- **Types**: import route types from `./+types/<name>`. Path alias `~/*` → `app/*`.
- **State**: Postgres (`expenses`, `reports`, `categories`, `settings`,
  `mileage` tables) — required, everywhere. `data/` CSVs exist only as the
  migration source for `pnpm migrate-data`. Never read state on the client;
  all reads/writes go through `app/lib/store.server.ts` →
  `app/lib/store/database.ts`.
- **Images**: Vercel Blob `images/…` pathnames when `BLOB_READ_WRITE_TOKEN`
  is set, or Postgres BYTEA (`image_blobs` table) with `IMAGE_BACKEND=pg` —
  used by dev/tests. No local fallback. See `app/lib/images.server.ts`.
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
| `app/lib/store.server.ts`         | Storage entry point (Postgres only).               |
| `app/lib/store/database.ts`       | Postgres backend.                                  |
| `app/lib/maps.server.ts`          | Geocode + route (Nominatim/OSRM).                  |

## Gotchas

- **No auth** — a single-user personal app. Put it behind Coolify basic auth,
  Vercel Deployment Protection, or a private network in production.
- Tests and dev require local Postgres up (`brew services start postgresql@18`);
  without it the suite fails to connect. `pnpm test` uses `expensify_test`.
  No MinIO/other services needed — images live in Postgres (`IMAGE_BACKEND=pg`).
- When renaming a report, expenses update but image files are **not** auto-renamed
  (they keep their old convention name). Re-saving each receipt rewrites the name.
- `vp check` excludes `vite.config.ts` from tsgolint (recursion limits); tsc
  still type-checks it.
