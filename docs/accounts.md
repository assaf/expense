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
  **Fastmail onboarding (`/onboarding`) is the exception**: a valid Fastmail API
  token proves mailbox control (stronger than a link click), so the
  resolved address is stamped `emailVerifiedAt` without an emailed link
  (see docs/email-connections.md → Fastmail onboarding).
  Re-signing up with the same email while the account is still unverified
  deletes the throwaway account and its old link (`deleteUnverifiedUser`)
  and starts fresh, unless the verification email went out within the last
  day: then the re-signup is refused and the sent link stays live, so the
  replace flow can't be used to re-send email on demand. Users created
  before this requirement (and the
  APP_EMAIL bootstrap user) are grandfathered as verified (`emailVerifiedAt`
  backfilled by the schema update that added the column).
- **Password recovery** (`/reset-password`, public): "Forgot password?"
  on the login page and on the onboarding attach step emails a single-use
  reset link (7-day TTL, once-a-day resend, sha256 of the token at rest on
  `users.passwordResetTokenHash`). The request always reports the same
  outcome (no account enumeration); unverified accounts are skipped (their
  verification link is the recovery). The token is consumed on use, and the
  password contract matches signup (`validateSignup` rules).
- **Changing your password** is self-serve (Settings → Password): the current
  password goes through `confirmPassword` (login's lockout key and constant-time
  comparison, so a stolen session can't grind passwords through this form),
  then `changeUserPassword` (`app/lib/db/accounts.ts`) writes the new hash with
  a fresh `credentialsChangedAt`. The epoch bump ends every session minted
  under the old password, `revokeAllUserOAuthTokens` ends the connected apps,
  and the response re-mints this device's cookie from the epoch Postgres
  actually stored, so the person who made the change stays signed in. A reset
  link requested earlier is dropped in the same write: it is a credential that
  would otherwise still set a password without the new one. The length bounds
  come from `validatePassword`, the contract signup, join and the reset link
  use as well. `/.well-known/change-password` publishes the section
  as the origin's change-password URL (W3C WebAppSec): a 302, the only redirect
  kind that spec allows, to `/settings#change-password`.
- **Changing your sign-in email** is self-serve too (Settings → Emails): the
  new address plus the current password. It lands immediately, because the
  address is a login identifier on an already-verified account, and it reuses
  the rule signup applies (`claimEmailAddress`): an unverified signup holding
  the address yields, a verified account makes it refuse. `users.email` moves
  (normalized; the id→user cache is busted and the settings card reads the
  address through `readUserEmail`, so it can't show the old one), while the
  password, the credentials epoch and the sessions stay put, so the device
  that made the change stays signed in. Two emails go out:
  `sendEmailChangeNotice` tells the OLD address what happened and names the new
  one (that notice is the security half, since whoever still reads that mailbox
  can act), and the new address becomes the default receipts-by-email sender,
  so it gets its own verification link before receipts from it are accepted.
  Sender rows are keyed by address, so the old address keeps importing until it
  is removed in Emails.
- **Closing your own account** is self-serve (Settings → Close account): the
  user re-enters their password (`confirmPassword` in `app/lib/auth.server.ts`
  reuses login's lockout key and constant-time comparison), then
  `closeUserAccount` (`app/lib/db/accounts.ts`) runs. The last member's
  account is deleted outright: the `Account` cascade plus the rows no FK
  reaches (`email_rules`, and the user's OAuth tokens/consents/codes and
  insights conversations). Any other member loses only their own login, the
  address claim, and those user-keyed rows. Deletion is immediate and
  permanent, and the closed session dies with it: `readCredentialsEpoch`
  answers a sentinel when the user row is gone, so a cookie for a deleted
  user is refused on every instance instead of surviving for the 30-second
  `findUserById` cache. `deleteUnverifiedUser` (the re-signup path) is the
  same primitive behind its guards.
- **Marketing emails are opt-out per user** (`users.marketingUnsubscribedAt`):
  every marketing email carries one permanent unsubscribe link
  (`/unsubscribe/<token>`, also in the `List-Unsubscribe` header for
  RFC 8058 one-click). The token is stateless — an HMAC signature over the
  user id (`app/lib/unsubscribe.server.ts`, purpose-salted so tokens can't
  be reused across flows), never expires, and IS the credential: no login.
  GET renders a confirmation (mail scanners follow links; the write is
  POST-only), the same POST serves one-click, and Settings → Emails can
  re-subscribe. Any future marketing sender must gate on
  `readMarketingUnsubscribed(userId)` and use `marketingFooter` +
  `marketingEmailHeaders` from `email-layout.server.ts`. Transactional
  email (verification, password reset, receipts-by-email notices) ignores
  the flag.
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
