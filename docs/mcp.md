# Expense MCP server

The expense tracker speaks the [Model Context Protocol](https://modelcontextprotocol.io)
over HTTP at `POST /mcp` — the same endpoint any MCP client (Claude Code,
Claude Desktop, Cursor, Windsurf, …) can connect to. An agent connected to
your account can do what the web app does, without the form:

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

1. Open **Settings → Agents & API (MCP)**.
2. **Create a token** — give it a name (e.g. "Claude Desktop") and optionally
   mark it **read-only** (query-only; write tools refuse).
   The token is shown **once** — copy it immediately; only its hash is stored.
3. Point your client at `https://<your-host>/mcp` with the token as a bearer
   token.

The endpoint URL is shown in Settings.

### Claude Code

Add to your Claude Code MCP config (`.mcp.json` in the project, or the
user-level config):

```json
{
  "mcpServers": {
    "expense": {
      "type": "http",
      "url": "https://expense.example.com/mcp",
      "headers": {
        "Authorization": "Bearer exp_your-token-here"
      }
    }
  }
}
```

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "expense": {
      "type": "http",
      "url": "https://expense.example.com/mcp",
      "headers": {
        "Authorization": "Bearer exp_your-token-here"
      }
    }
  }
}
```

### Cursor

Settings → Integrations → MCP servers → add server with the same URL +
Authorization header.

### Anything else

Any MCP client that supports **Streamable HTTP** works. The handshake is
standard: `initialize` → `notifications/initialized` → `tools/list` /
`tools/call`.

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

Write tools return `isError` with a clear message when the token is
read-only, a report is closed, or a report doesn't exist.

## Reconciling a statement

`reconcile` accepts CSV with a header row (`date,description,amount` — column
names containing "date", "desc", "amount" are detected) or plain rows in that
order. Dates can be `YYYY-MM-DD` or `MM/DD/YYYY`; amounts may include `$`,
commas, and parentheses for negatives (`(12.34)`). Matching is date +
absolute amount, scored by merchant-token overlap with the description
("high" when the merchant name appears in the statement line, "medium" when
only date + amount agree). It never writes, dismisses, or deletes anything.

## Auth & security

- Tokens look like `exp_…`; only their SHA-256 hash is stored, so a leaked
  database never exposes usable tokens.
- Every request must present `Authorization: Bearer <token>`. A token only
  ever reaches **its own account** — other accounts are fully isolated.
- **Read-only tokens** can call every query tool but every write tool
  returns an error.
- Revoke a token in Settings → Agents & API; the next request gets `401`.
- Sessions are bound to the token's account + capabilities: reusing a
  session id with a different token is rejected.
- `capture_receipt` accepts URLs — the server fetches them (like the
  existing Nominatim/OSRM/DeepSeek calls); treat the token as a secret that
  can read your expenses.

## Operational notes

- The endpoint is `maxDuration: 60` (same as the draft-image route) because
  receipt extraction can be slow.
- Sessions live in memory. On a serverless cold start a session is lost and
  the client gets `404 No such session` — spec-compliant clients re-initialize
  automatically. A fresh initialize is also how you'd test connectivity.
- `tools/call` responses are JSON (the transport runs with
  `enableJsonResponse`) — no SSE stream to babysit.
- The post-deploy smoke check (`GET /api/smoke`, gated by
  `SMOKE_TEST_SECRET`) runs a real MCP initialize → tools/list → tools/call
  round trip inside the deployed serverless bundle (`runMcpSmoke` in
  `app/lib/mcp.server.ts`) using a one-off token that is revoked right after
  — it catches the SDK or zod being dropped by Vercel's dependency tracer.

### Smoke-testing from a terminal

```bash
# initialize (a session id comes back in the Mcp-Session-Id header)
curl -s -D - https://expense.example.com/mcp \
  -H "Authorization: Bearer exp_…" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# list tools (repeat with the session id header)
curl -s https://expense.example.com/mcp \
  -H "Authorization: Bearer exp_…" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: <session-id>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

## How it's built

- `app/routes/mcp.ts` — the HTTP endpoint (loader + action → `handleMcpRequest`).
- `app/lib/mcp.server.ts` — the MCP server: session registry, bearer auth,
  the 13 tools, and the reconciliation matcher.
- `app/lib/api-tokens.server.ts` — token generation + SHA-256 hashing.
- `prisma/schema.prisma` → `ApiToken` — tokens are account-scoped rows
  (`api_tokens` table).
- `app/routes/settings.tsx` → **Agents & API (MCP)** — create/revoke tokens,
  shown-once token, endpoint URL.
- `app/lib/report-pdf.server.ts` — the report PDF builder shared by the web
  export and `export_report`.
