# r/SideProject post

## Title

I built a receipt tracker where the receipt files itself: photo, email, or automatic import from FastMail

## Body

For years my tax prep was one bad evening in April: a folder of PDFs, a camera roll of crumpled receipts, and a spreadsheet I'd abandoned in June. The existing apps all wanted a subscription plus my Gmail password, and I still had to type the merchant and amount into a form per receipt.

So I built Expense (web app, works on phone and desktop): https://expense.labnotes.org

The idea: the receipt should file itself, and I should only confirm it.

How receipts get in:

- Photo, screenshot paste, or PDF drop. OCR reads the merchant, amount, and date; a model picks the category from IRS Schedule C lines, and it learns from my own history, so after a couple of weeks the suggestions are mostly right.
- Every account gets a private email address. I forward a receipt, or send a photo from the iOS share sheet, and it lands as a drafted expense.
- FastMail users can connect their mailbox and receipts get filed as they arrive. I chose FastMail over Gmail on purpose: a revocable JMAP token beats handing over an email password.

It also does mileage (draw the route, priced at the IRS rate for that date) and reconciliation: upload a bank statement and it matches the charges against what I logged, which surfaces the subscriptions and fees I forgot to photograph. That feature finds real money every year.

There's an MCP server too, so I can ask Claude "how much did I spend on software this quarter" without opening a dashboard.

Free until the app reaches 100 users (the counter is on the landing page), then a paid plan with a free tier that stays. No credit card, no ads.

Happy to answer anything about the stack (React Router, Postgres, Vercel/Supabase) or the receipt extraction pipeline.
