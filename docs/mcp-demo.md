# The 60-second demo

One take, four moves — each one shows a different capability and all of them
run live against a real account. Record at 1080p, screen + webcam optional,
no cuts. The point of the demo: **an assistant does the work the app's forms
used to, and the user just signs in.**

## Running it (scripted, reproducible)

Two scripts make the demo repeatable — no manual data prep:

```bash
pnpm demo:seed   # seed (or reset) the "Demo Account" with realistic data
pnpm demo:run    # drive the four moves over the MCP endpoint, print a
                 # transcript, and save the exported PDF to demo-output/
```

Prereqs: local Postgres up, a running server (`pnpm dev` or `pnpm start`),
and `.env` with `DATABASE_URL`. Point the driver elsewhere with
`DEMO_URL=http://localhost:3000 pnpm demo:run`.

`demo:run` authenticates with an OAuth access token issued straight to the
store for the demo user — the same token type a browser sign-in produces.
`capture_receipt` passes merchant/amount/date overrides so the move is
deterministic without a DeepSeek key; with `LLM_API_KEY` set, the real
OCR extraction runs instead.

The seeded account makes each move land:

- **Blue Bottle Coffee history** (3 receipts) — so `capture_receipt` reuses
  the merchant's previous category instead of guessing.
- **Q2 Travel: $391.30** across two United flights — the spending question's
  exact answer.
- **Four unreported June expenses** — work for the report move.
- **A mileage trip + 2026 rate** — mileage is priced at the IRS rate.

## The four moves

**0–5s — "Here's my receipt."**
Drop the receipt PDF into the chat. "Log this under Q3." The assistant calls
`capture_receipt`, the OCR/extraction runs, and the expense appears — merchant,
amount, and category straight from the account's own history.

**5–20s — "How much did I spend on flights last quarter?"**
`expense_summary` answers with the exact total, per category. This is the
"it knows your numbers" moment — no report to download, no math.

**20–40s — "Move all unreported June expenses into the Q2 report and export
the PDF."**
`list_expenses` (unreported filter) → `add_to_report` → `export_report` →
the assistant saves the PDF. Shows the read-query and write tools composing
into a real workflow.

**40–60s — "Reconcile this statement."**
Paste the CSV. `reconcile` matches date + amount, flags the charge with no
matching receipt. Close by showing Settings → Agents & API: the connection is
right there, with its tokens, one click from revoked.

## The closing line

"That's Expense — your receipts, mileage, and reports, on speaking terms
with your own assistant. No API keys; you just sign in."

## Where the demo lives

- `/ai` marketing page: the copy and the four use cases.
- `docs/mcp.md`: the full tool reference for the deep-dive version.
- The landing page "Bring your own AI assistant" section links the same
  story in one screen.
