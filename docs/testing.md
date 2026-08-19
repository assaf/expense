# Testing (`vpr test` + Playwright)

- Test files live in `test/*.test.ts` — NOT alongside source.
- To unit-test a route action directly (no browser), type the args object as
  `Parameters<typeof action>[0]` — the generated `+types/<route>` module
  only resolves via tsconfig `rootDirs` for relative imports inside `app/`,
  so `~/routes/+types/…` does NOT resolve from `test/`. See
  `test/api-inbound-push.test.ts` for the pattern (mock the route's
  network-facing collaborators with `vi.mock`, keep real decryption).
- The FastMail flows are unit-tested offline: `test/fastmail-send.test.ts`
  drives `sendEmailViaJmap` through its injectable `JmapSendDeps`
  (identity match → upload → import → submit; the submit step retries once
  on a transient failure with the same email id; failures return false),
  and `test/api-inbound-push.test.ts` forges RFC 8291 payloads encrypted to
  throwaway keys from a `vi.mock`'d `~/lib/env` (generated lazily in
  getters — `vi.hoisted` runs before `node:crypto` initializes), so the
  decrypt cases run everywhere, CI included (PushVerification echo,
  StateChange drain, unknown type, undecryptable body).
- Browser tests via Playwright (vitest provider); helpers in `test/helpers/`
  (`launchBrowser.ts` → `goto`/`signIn`, `seedTestData.ts` → `testPrisma` +
  seeded constants, `launchServer.ts`).
- Use `testPrisma` for DB assertions; seed with the account/user constants.
- Requires local Postgres (`expense_test`); the schema is force-reset each run.
- **The suite runs on a pinned clock** — `2026-07-15T12:00:00Z`, ticking in
  real time from that base, shared by the test process, browser pages, and
  the test server (`test/helpers/frozen-time.ts`, `pinned-time.ts`,
  `pinned-clock.mjs`, `launchBrowser.ts::freezePageClock`). Consequence for
  test writers:
  - `Date.now()` / `new Date()` return pinned base + elapsed — NEVER use them
    for real-time deadlines or polling loops (they hang); use
    `performance.now()` (see `launchServer.ts`, `auth.test.ts` polling).
  - Derive webhook timestamps (`svix-timestamp`) from `Date.now()`, not
    absolute wall-clock values, so they stay inside the server's replay guard.
  - The browser pin is a `context.addInitScript` Date override — NOT
    Playwright's `page.clock` (`setFixedTime` never fires page timers;
    `install()` doesn't survive navigations).
  - The server pin loads via `NODE_OPTIONS=--import ./test/helpers/pinned-clock.mjs`
    in `launchServer.ts`; keep the pinned instant in sync across all files.
  - The test server blanks `PUBLIC_URL` in its env (like the live-service
    keys) so the OAuth metadata issuer follows the request/forwarded origin.
    A `.env` `PUBLIC_URL` (set for the FastMail push URL) changed the issuer
    to the prod origin locally and prompted a bad hardcode in `531e814` —
    keep OAuth test expectations origin-derived, never hardcoded.
- **React Router remounts route components when a data navigation settles**
  (~1ms after the URL changes): the create-editor mounts, unmounts, and
  remounts, replacing the file input in between. A Playwright
  `setInputFiles` landing in that window sets files on the instance about to
  be torn down and the change event is silently lost (no request ever
  fires — the suite caught this as a flaky 30s `waitForResponse` timeout).
  Upload tests must wait for the settle before setting files:
  `waitForEditorSettle(page)` (`test/expenses.test.ts`), a 100ms beat that
  lands well past the ~1ms remount. Drag-drop uploads are exempt (the
  editor's `useEffect` upload fires from mount #1 and `draftUploadsInFlight`
  dedupes the remount).
