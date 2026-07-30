# Agent guide — Expensify

Personal expense tracker (receipts + mileage). React Router v8 framework mode,
Tailwind v4, file-based persistence (no database). Deployed to Coolify.

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
- **State**: file-based under `data/` — see README. Source of truth is
  `expenses.csv`; `mileage.csv` is derived. Never read state on the client; all
  reads/writes go through `app/lib/store.server.ts`.
- **Images**: stored in `data/images/`, named `YYYY-MM-DD_REPORT_FILE.ext` once a
  receipt has a date + report; otherwise a temp id-based name (renamed on save).
  See `app/lib/images.server.ts`.
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
| `app/lib/store.server.ts`         | All CSV read/write.                                |
| `app/lib/maps.server.ts`          | Geocode + route (Nominatim/OSRM).                  |

## Gotchas

- There is **no auth** — a single-user personal app. Put it behind Coolify basic
  auth or a private network in production.
- When renaming a report, expenses update but image files are **not** auto-renamed
  (they keep their old convention name). Re-saving each receipt rewrites the name.
- `vp check` excludes `vite.config.ts` from tsgolint (recursion limits); tsc
  still type-checks it.
