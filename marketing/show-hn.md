# Show HN copy

## Title

Show HN: Expense – receipt tracker that files receipts as they arrive (FastMail, MCP)

## Text

I kept losing deductions to data entry, so I built the tool I wanted: a receipt tracker where the receipt files itself and you just confirm it.

How capture works:

- Drop in a photo, paste a screenshot, or upload a PDF. OCR extracts the fields, a model picks the category from IRS Schedule C lines (it prefers your own spending history, so suggestions get better as it learns), and you press save.
- Email intake: every account gets a private address. Forward a receipt or send it a photo from your phone; it arrives as a drafted expense.
- FastMail integration: connect your mailbox with a JMAP token you create and revoke yourself, and incoming receipts are filed automatically. I deliberately did not build a Gmail connector; asking freelancers for their email password felt like the wrong trade, and FastMail's JMAP API made it avoidable.

Other pieces:

- Mileage: draw the route, computed at the IRS rate for the drive date.
- Reconciliation: upload a bank statement export and it matches charges against logged expenses (amount and date, deliberately conservative, never deletes), which surfaces the subscriptions and fees you never photographed.
- MCP server: connect Claude or any MCP client over OAuth and ask things like "how much did I spend on software this quarter" or "log the drive to the client on Tuesday".
- Duplicate detection (SHA-256 on the receipt image), ECB reference-rate FX conversion, reports organized by Schedule C line.

Stack: React Router, Postgres (receipt images as BYTEA), Prisma, Vercel + Supabase. No native apps; it's a web app you can install to your home screen.

Free until the app reaches 100 users, then a paid plan starts and a free tier remains. No credit card, no ads: https://expense.labnotes.org

Happy to answer questions about the extraction pipeline, the JMAP integration, or why the reconciliation matcher refuses to be clever.
