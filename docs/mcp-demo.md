# The 60-second demo

One take, four moves — each one shows a different capability and all of them
run live against a real account. Record at 1080p, screen + webcam optional,
no cuts. The point of the demo: **an assistant does the work the app's forms
used to, and the user just signs in.**

## Setup (before recording)

- A fresh test account with a few seeded expenses (so "how much did I spend"
  has a real answer).
- Claude Code (or any MCP client) connected via
  `https://expense.labnotes.org/mcp` — sign in, Allow. Have a receipt PDF
  handy (e.g. an emailed invoice) and a bank statement CSV.
- Pre-warm: run one tools/call so the first response isn't slow.

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
