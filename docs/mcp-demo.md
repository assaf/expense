# The 60-second demo

One take, four moves: each one shows a different capability and all of them
run live against a real account. Record at 1080p, screen + webcam optional,
no cuts. The point of the demo: **an assistant does the work the app's forms
used to, and the user just signs in.**

## Running it

The demo is run by hand against a real account; there is no demo seeder or
demo driver script. Prereqs: local Postgres up, a running server (`pnpm dev` or
`pnpm start`), and a `.env` with `DATABASE_URL`.

1. Sign in as the account you want to film with, and give it the data each
   move needs (a merchant with history, a report with a known total, some
   unreported expenses, one mileage trip).
2. Connect the assistant: **Settings -> Agents & API**, or hand the client the
   endpoint from [docs/mcp.md](mcp.md) and let it open the OAuth consent page.
3. Run the four moves below in order, in one take.

The data each move leans on:

- **Blue Bottle Coffee history** (3 receipts), so `capture_receipt` reuses
  the merchant's previous category instead of guessing.
- **Q2 Travel: $391.30** across two United flights, the spending question's
  exact answer.
- **Four unreported June expenses** to feed the report move.
- **A mileage trip + 2026 rate**: mileage is priced at the IRS rate.

`capture_receipt` accepts merchant, amount and date overrides, so the first
move can be made deterministic without a model key; with `LLM_API_KEY` set the
real OCR extraction runs instead.

## The four moves

**0–5s: "Here's my receipt."**
Drop the receipt PDF into the chat. "Log this under Q3." The assistant calls
`capture_receipt`, the OCR/extraction runs, and the expense appears, with merchant,
amount, and category straight from the account's own history.

**5–20s: "How much did I spend on flights last quarter?"**
`expense_summary` answers with the exact total, per category. This is the
"it knows your numbers" moment: no report to download, no math.

**20–40s: "Move all unreported June expenses into the Q2 report and export
the PDF."**
`list_expenses` (unreported filter) → `add_to_report` → `export_report` →
the assistant saves the PDF. Shows the read-query and write tools composing
into a real workflow.

**40–60s: "Reconcile this statement."**
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
