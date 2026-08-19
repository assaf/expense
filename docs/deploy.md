# Deployment, CI, and smoke checks

Local tests run against
node_modules, where every file exists; Vercel's dependency tracer is what
drops pdf.worker.mjs / tesseract wasm and breaks PDF/OCR in production.
Real coverage: `test/pdf-ocr.test.ts` (text extraction + rasterization in
`pnpm test`; tesseract round-trip opt-in via `RUN_OCR_TESTS=1`, on in CI)
and the smoke check (`/api/smoke`, gated by `SMOKE_TEST_SECRET`), which
runs in the deployed serverless bundle — `scripts/deploy` curls it after
CLI deploys, and `.github/workflows/deployment-smoke.yml` runs it on every
push to `main`. The workflow: `secretlint` runs first and gates the whole
pipeline, then `check` + `test` run in parallel, then
`migrate-db` (runs `./scripts/migrate-prod --ci` against prod via the
`DATABASE_URL_UNPOOLED` GitHub secret, only after tests pass — never
before) → `pdf-ocr-smoke`. The smoke job fails fast when
CI or the migration fails, so a broken build or an unmigrated schema never
reports a passing smoke check. Job timeouts (2/2/4/1/2 minutes) bound the
whole run to a ~10m ceiling; typical runs are ~5m.
**Deployment Checks gate: REMOVED (Aug 2026).** Production promotion is no
longer gated on a Vercel Deployment Check — the alias follows the latest
READY production deployment automatically. The gate broke twice: a stale
required check name ("Check & Test" — split into separate "Check" +
"Test" jobs in 6037bcb, leaving Vercel waiting on a check-run that never
existed, so every deployment's `deployment-alias` check stayed pending
forever) kept the alias frozen on a pre-migration build for ~23h (P2021
500s), then kept newer deployments un-promoted entirely. The smoke check
still runs and fails loudly in CI (now also reporting whether the server
Sentry SDK initialized in the deployed bundle); it just doesn't block the
alias. To inspect/re-add checks: `vercel project checks` /
`vercel project checks remove <id>` (API: GET/POST/DELETE
`/v2/projects/…/checks`); the Vercel dashboard path is Settings → Build &
Deployment → Deployment Checks. Requires `VERCEL_TOKEN`,
`VERCEL_PROJECT_ID`, `VERCEL_ORG_ID` (team id, `team_…`), and
`SMOKE_TEST_SECRET` GitHub secrets. The job name is the check name — keep
it stable.
