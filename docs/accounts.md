# Auth & accounts

Multi-user access control with account-level sharing.
Users live in Postgres (`users`, `accounts`); every expense, report,
category, setting, and mileage row is scoped by `accountId`. Users in the
same account share everything; other accounts are fully isolated (all
reads and writes are scoped; see `app/lib/db/`).

- Sign in with email/password (scrypt-hashed in `users.passwordHash`);
  the email is the login name: stored lowercase, unique, format-
  validated at signup/join (`isEmail` in `app/lib/validation.ts`).
- Signup creates a new account; joining uses the account's invite code
  (shown in Settings, regenerable). Session = signed HttpOnly cookie
  (`SESSION_SECRET`, 30-day max age).
- **Email verification gates sign-in**: signup/join create a _pending_
  account and email a single-use verification link (`/verify-email?token=`,
  sha256 of the token at rest on `users.verificationTokenHash`, 7-day TTL,
  resend button on the login page, rate-limited to once a day). The user
  can't sign in until it's clicked (`login` throws EmailNotVerifiedError).
  **FastMail onboarding (`/onboarding`) is the exception**: a valid FastMail API
  token proves mailbox control (stronger than a link click), so the
  resolved address is stamped `emailVerifiedAt` without an emailed link
  (see docs/email-connections.md → FastMail onboarding).
  Re-signing up with the same email while the account is still unverified
  deletes the throwaway account and its old link (`deleteUnverifiedUser`)
  and starts fresh, unless the verification email went out within the last
  day: then the re-signup is refused and the sent link stays live, so the
  replace flow can't be used to re-send email on demand. Users created
  before this requirement (and the
  APP_EMAIL bootstrap user) are grandfathered as verified (`emailVerifiedAt`
  backfilled by the migration / `scripts/migrate-prod`).
- **Password recovery** (`/reset-password`, public): "Forgot password?"
  on the login page and on the onboarding attach step emails a single-use
  reset link (7-day TTL, once-a-day resend, sha256 of the token at rest on
  `users.passwordResetTokenHash`). The request always reports the same
  outcome (no account enumeration); unverified accounts are skipped (their
  verification link is the recovery). The token is consumed on use, and the
  password contract matches signup (`validateSignup` rules).
- **Bootstrap**: on an empty database, the first account + user are
  created from `APP_EMAIL`/`APP_PASSWORD` (fail-closed if missing). On
  existing pre-email databases, `initStore` backfills the bootstrap
  (oldest) user's login from `APP_EMAIL` when their stored email is not
  a valid address (legacy username-era rows).
  Single-user era rows are adopted into that account automatically. This
  is app-side data seeding (`initStore` in `app/lib/db/seed.ts`, memoized per
  process); the SCHEMA itself is managed by Prisma (no runtime DDL).
- Every loader/action calls `requireUser(request)` and passes
  `user.accountId` to the store; the root loader guards all routes.
- Tests seed two accounts + three users; `launchBrowser.ts` signs in as
  `testuser`; `test/auth.test.ts` covers login, signup, invite-code join,
  sign-out, and cross-account isolation.
