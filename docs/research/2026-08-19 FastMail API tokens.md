# Fastmail API tokens: how users create them

Access date: 2026-08-19. Sources (mutable; this is the point-in-time
snapshot the connect flow's instructions rely on):

- Help article: <https://www.fastmail.help/hc/en-us/articles/5254602856719-API-tokens>
- Developer docs: <https://www.fastmail.com/dev/> and
  <https://www.fastmail.com/for-developers/oauth/>
- Direct "new token" URL (from github.com/joelparkerhenderson/demo-fastmail-api-jmap,
  verified against the help article): <https://app.fastmail.com/settings/security/tokens/new>

## Steps (from the help article)

1. Log in to the Fastmail web interface and go to Settings → Privacy &
   Security.
2. Find the **Connected apps & API tokens** section. Click **Manage API
   tokens**.
3. Click **New API token**.
4. A "Verify it's you" box may appear (password-protected action); enter
   password and continue.
5. Enter a name to identify the token, choose scopes, and create it.
6. Copy the token (shown once).

Token format: `fmu1-…` (unverifiable from the snapshot pages how long;
the demo repo shows a ~70-char example, not reproduced verbatim since
secretlint flags `fmu1-` tokens).

Scope note: the developer docs describe API tokens as "for JMAP access".
The demo repo's walkthrough checks the "Email Submission" scope; mail read
scopes exist alongside it. **Unverified detail:** the exact scope names
shown in the FastMail API help article (listing them is gated
behind the article's dynamic content). The connect UI instructs "Read mail
and Compose"; if the real labels differ, adjust
`app/components/settings/email-accounts.tsx`.

Session endpoint for verification:
`https://api.fastmail.com/jmap/session` with
`Authorization: Bearer <token>` (fastmail.com/dev).
