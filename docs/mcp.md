# Expense MCP server

The expense tracker speaks the [Model Context Protocol](https://modelcontextprotocol.io)
over HTTP at `POST /mcp`. Any MCP client (Claude Code, Claude Desktop,
Cursor, Windsurf, …) can connect — and with OAuth, connecting is just
**signing in with your account**. An agent connected to your account can do
what the web app does, without the form:

- **Capture a receipt** — drop a photo or PDF into the chat; it runs the same
  OCR + extraction pipeline as the web app (DeepSeek, falling back to
  tesseract), reuses the merchant's previous category from your own history,
  stores the image, and creates the expense.
- **Log a drive** — give it stops in plain English; it geocodes, routes, and
  prices the trip at the year's IRS rate.
- **Answer spending questions** — "how much did I spend on flights last
  quarter?" gets the exact total from your data.
- **Build reports** — create/close reports, move expenses into them, export a
  report PDF.
- **Reconcile** — paste a bank statement CSV; it finds every charge with no
  matching receipt (read-only analysis).

## Setup

Connecting is **signing in with your account** — there are no API keys. OAuth
clients (Claude Code, Claude Desktop, Cursor, …) do this automatically:

1. Point the client at `https://<your-host>/mcp`.
2. The client fetches `/.well-known/oauth-authorization-server`, registers
   itself, and opens your browser.
3. You sign in with your normal account (or you're already signed in) and
   click **Allow** on the consent page.
4. The client gets tokens and connects. Consent is remembered, so
   reconnecting is a one-click approval.

Manage connected apps in **Settings → Agents & API (MCP)**: delete individual
access or refresh tokens (kills a session now, or stops the app getting new
sessions), or disconnect an app entirely to revoke everything.

### Claude Code

Add to your Claude Code MCP config (`.mcp.json` in the project, or the
user-level config):

```json
{
  "mcpServers": {
    "expense": {
      "type": "http",
      "url": "https://expense.example.com/mcp"
    }
  }
}
```

Claude Code performs OAuth discovery automatically — it registers itself and
opens your browser for the sign-in flow.

### Claude Desktop

Add the server in the Claude Desktop settings. It registers itself and opens
your browser for the sign-in flow — no configuration file needed.

### Cursor

Settings → Integrations → MCP servers → add the server. Cursor performs
OAuth discovery automatically; approve the connection in your browser.

### Anything else

Any MCP client that supports **Streamable HTTP + OAuth** works. The handshake
is standard: discovery → register → authorize → token exchange →
`initialize` → `notifications/initialized` → `tools/list` / `tools/call`.

## Tools

| Tool              | Writes | What it does                                                                                                                                                                                                                                 |
| ----------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture_receipt` | ✓      | Capture a receipt from base64 image/PDF data or a URL; extract merchant/amount/category (reusing the merchant's history), store the image, create the expense. Optional overrides for merchant, amount, category, date, report, description. |
| `log_mileage`     | ✓      | Log a driving trip from ordered stops (address strings or pre-geocoded `{address, lat, lng}`); geocodes, routes, and computes distance + amount at the year's IRS rate.                                                                      |
| `list_expenses`   |        | Query expenses: date range, category, merchant, report, unreported-only, type, limit. Newest first, amounts as decimal strings.                                                                                                              |
| `expense_summary` |        | Totals + per-category breakdown for the same filters — the "how much did I spend on X?" tool.                                                                                                                                                |
| `list_reports`    |        | Reports with expense counts and exact totals.                                                                                                                                                                                                |
| `create_report`   | ✓      | Create a report (fails if the name exists).                                                                                                                                                                                                  |
| `close_report`    | ✓      | Close (or reopen) a report; closed reports refuse new expenses.                                                                                                                                                                              |
| `add_to_report`   | ✓      | Move an expense into an open report; renames the stored receipt image to the dated convention name.                                                                                                                                          |
| `export_report`   |        | Render a report as a PDF (same layout as the web export) and return it base64-encoded.                                                                                                                                                       |
| `list_categories` |        | The account's categories — use these when categorizing.                                                                                                                                                                                      |
| `list_merchants`  |        | Merchant names previously used, most recent first.                                                                                                                                                                                           |
| `get_settings`    |        | Per-year mileage rates and home address.                                                                                                                                                                                                     |
| `reconcile`       |        | Match a bank statement CSV against logged expenses: matched pairs (with confidence), unmatched statement lines, and logged receipts with no statement line. Pure analysis — nothing is written.                                              |

Write tools return `isError` with a clear message when a report is closed
or doesn't exist.

## Reconciling a statement

`reconcile` accepts CSV with a header row (`date,description,amount` — column
names containing "date", "desc", "amount" are detected) or plain rows in that
order. Dates can be `YYYY-MM-DD` or `MM/DD/YYYY`; amounts may include `$`,
commas, and parentheses for negatives (`(12.34)`). Matching is date +
absolute amount, scored by merchant-token overlap with the description
("high" when the merchant name appears in the statement line, "medium" when
only date + amount agree). It never writes, dismisses, or deletes anything.

## Auth & security

- **OAuth only** — authorization-code flow with PKCE (S256), per the MCP
  authorization spec. There are no API keys; every `/mcp` request carries an
  OAuth access token (`oat_…`, 1-hour TTL) obtained by signing in. Refresh
  tokens (`ort_…`) live 30 days and rotate on every grant, so a leaked token
  only works briefly. Only the SHA-256 hashes are stored.
- A token only ever reaches **its own account** — other accounts are fully
  isolated. Tokens bind to the signing-in user; users in the same account
  share the connection, other accounts never see it.
- **Revocation**: Settings → Agents & API lets you delete individual access
  or refresh tokens (revoking an access token doesn't kill the refresh token,
  per RFC 7009) or disconnect an app, which revokes everything. The next
  request gets `401`.
- Sessions are bound to the token's account: reusing a session id with a
  different account's token is rejected.
- `capture_receipt` accepts URLs — the server fetches them (like the
  existing Nominatim/OSRM/DeepSeek calls); treat credentials as secrets that
  can read your expenses.

## Operational notes

- The endpoint is `maxDuration: 60` (same as the draft-image route) because
  receipt extraction can be slow.
- **Public origin / proxies**: the OAuth metadata derives its issuer from
  the request origin, honoring `x-forwarded-proto`/`x-forwarded-host` when
  the app sits behind a TLS-terminating proxy (e.g. a local
  `https://expense.localhost` Caddy setup). If that isn't enough, set
  `PUBLIC_URL` to the public base URL and every advertised URL (issuer,
  endpoints, protected-resource metadata) uses it. Without one of these, a
  proxied client sees the proxy-internal `http://` origin and fails with
  "Protected resource … does not match expected".
- Sessions live in memory. On a serverless cold start a session is lost and
  the client gets `404 No such session` — spec-compliant clients re-initialize
  automatically. A fresh initialize is also how you'd test connectivity.
- `tools/call` responses are JSON (the transport runs with
  `enableJsonResponse`) — no SSE stream to babysit.
- OAuth authorization codes are single-use, 10-minute TTL, and bound to the
  client, redirect URI, and PKCE challenge. Refresh tokens rotate; the old
  token dies on every grant.
- The post-deploy smoke check (`GET /api/smoke`, gated by
  `SMOKE_TEST_SECRET`) runs a real MCP initialize → tools/list → tools/call
  round trip inside the deployed serverless bundle (`runMcpSmoke` in
  `app/lib/mcp.server.ts`) using an OAuth access token issued straight to
  the store for a throwaway client that is deleted right after — it catches
  the SDK or zod being dropped by Vercel's dependency tracer.

### Smoke-testing from a terminal

```bash
# initialize (a session id comes back in the Mcp-Session-Id header)
curl -s -D - https://expense.example.com/mcp \
  -H "Authorization: Bearer oat_…" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# list tools (repeat with the session id header)
curl -s https://expense.example.com/mcp \
  -H "Authorization: Bearer oat_…" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: <session-id>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

## How it's built

- `app/routes/mcp.ts` — the HTTP endpoint (loader + action → `handleMcpRequest`).
- `app/lib/mcp.server.ts` — the MCP server: session registry, OAuth bearer
  auth, the 13 tools, and the reconciliation matcher.
- `app/lib/oauth.server.ts` — the OAuth authorization server: PKCE (S256),
  token/code generation + hashing, RFC 8414 metadata, refresh rotation, and
  client authentication.
- `app/routes/[.]well-known.oauth-authorization-server.ts` (+ openid-
  configuration, oauth-protected-resource) — discovery metadata.
- `app/routes/oauth.{register,authorize,token,revoke}.ts(x)` — the OAuth
  endpoints; `oauth.authorize` renders the consent page.
- `prisma/schema.prisma` — `ApiToken` and the OAuth models (`OAuthClient`,
  `OAuthConsent`, `OAuthCode`, `OAuthToken`).
- `app/routes/settings.tsx` → **Agents & API (MCP)** — connected apps with
  per-token delete and full disconnect, endpoint URL.
- `app/lib/report-pdf.server.ts` — the report PDF builder shared by the web
  export and `export_report`.
- Tests: `test/mcp.test.ts` (OAuth access tokens + smoke round trip) and
  `test/oauth.test.ts` (discovery, registration, the full PKCE flow through
  the real consent page, refresh rotation, revocation, user isolation).
