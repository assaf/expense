# Introducing Expense: receipts, filed themselves

Every freelancer I know has a shoebox problem. Not an actual shoebox, necessarily. It's a June spreadsheet, a camera roll full of crumpled receipts, a downloads folder with PDFs named `invoice-final2.pdf`, and an inbox they swear they'll search "later". Come tax season, all of it turns into an evening (or three) of data entry, and a nagging feeling that some deductions slipped through.

I built Expense (https://expense.labnotes.org) to end that. It's a receipt and mileage tracker for freelancers and self-employed people, and its whole design can be summed up in one sentence: the receipt should file itself, and you should only confirm it.

## Getting a receipt in should take one click

Most expense apps make you do the work. Open the app, start an entry, type the merchant, type the amount, pick a date, snap a photo for the audit trail, save. Repeat forty times.

Expense flips that. You get the receipt in however the receipt comes to you:

- Take a photo, paste a screenshot, or drop a PDF onto the page.
- Forward or send the receipt by email to your private intake address. Attach a photo from your phone and it lands as a drafted expense.
- Connect a FastMail mailbox and receipts arriving in your inbox are filed automatically, before you've opened them.

Under the hood, OCR reads the image, a language model pulls out the merchant, the amount, and the date, and the category is suggested from IRS Schedule C lines. The model checks your own spending history first, so after a few weeks the suggestions are mostly right, and approving a receipt is one press instead of a form. If the same receipt shows up twice, the app notices and tells you instead of double-counting it.

Foreign currency receipts convert to dollars at the official ECB rate for the purchase date, with the conversion saved alongside the original amount for your records. Nothing to look up, nothing to compute.

## Mileage without a logbook

Business drives are their own tax category, and their own guilt. Expense handles them from the same one-click idea: you describe the drive, it draws the route on a map, and it computes the distance at the IRS rate for the date you drove (the rate changes mid-year some years; the app keeps that straight for you). Past drives can be saved as regular trips, so the weekly client visit becomes a one-tap entry.

## Reconciliation: the deductions you forgot

This is the feature that finds real money. Export a statement from your bank, upload it, and Expense matches the charges against what you already logged, by amount and date. What's left over is the interesting part: the software subscription you never photographed, the parking fee, the domain renewal. The matcher is deliberately conservative and never deletes anything; it proposes, you confirm. For anyone who bills by the calendar year, it's the difference between the receipts you saved and the expenses you actually claim.

## Your assistant can do your bookkeeping

Expense speaks MCP, the protocol that lets AI assistants use external tools. Connect Claude (or any MCP client) to your account and you can ask "how much did I spend on software this quarter", "log the drive to the client's office on Tuesday", or "reconcile last month" in plain English. Your data stays in your account; the assistant only sees what you ask about, over an authenticated connection.

## The part I'm proudest of: your email is not my business

Almost every receipt app solves capture by asking for your Gmail password. That always struck me as a terrible trade. Expense takes a different route: it connects directly to your own FastMail account with a token you create and can revoke anytime, and it only reads the mail it's importing for you. If you don't use FastMail, the email intake address still works with any provider: forward a receipt, it arrives, it's filed.

There's no ads, no data selling, no "anonymized aggregates". Receipt images are stored for your audit trail, in your account, and that's it.

## Free while it proves itself

Expense is free until the app reaches 100 users. After that a paid plan starts, but a free tier stays (up to 25 invoices a month), so nobody gets locked out of their own records. No credit card to sign up, and the landing page shows exactly how many spots are left, because I'd rather say the number than imply scarcity I don't have.

If you file a Schedule C, a 1099, or you've just been meaning to deal with that shoebox: https://expense.labnotes.org

Questions welcome. I read everything.
