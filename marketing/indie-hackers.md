# Indie Hackers product page + launch post

## Tagline

Receipts that file themselves. Expense reads the receipt, picks the category, and files it; you just approve.

## Product page description

Expense is a receipt, mileage, and deduction tracker for freelancers and the self-employed. Get a receipt in by photo, paste, PDF, email, or automatic import from a FastMail mailbox. OCR and an AI model extract merchant, amount, and date; the category is suggested from IRS Schedule C lines using your own spending history first. Draw a drive and it's logged at the IRS mileage rate for that date. Upload a bank statement and reconciliation surfaces the charges you never logged. Connect Claude or any MCP client and ask your books questions in plain English. Receipts stay yours: no Gmail passwords, no ads, no data selling.

## Launch post

For the last few years, my tax prep was the same evening every April: a shoebox of receipts, a folder of PDFs, a camera roll, and a spreadsheet that hadn't been touched since June. The receipts apps that were supposed to fix this all had the same shape: a subscription, a request for my Gmail password, and a form to fill out per receipt. The data entry, the part I actually hate, was still mine.

So I built Expense, and I gave it one rule: the receipt files itself.

There are four ways a receipt gets in. Photograph it or paste a screenshot; the OCR reads it and the model files it. Drop a PDF. Email it to the private intake address every account gets, which means I can send a receipt from my phone's share sheet without opening the app. Or connect a FastMail mailbox, and receipts arriving in the inbox get filed on their own, before I've even seen them. I picked FastMail for the auto-import because their JMAP API lets the app authenticate with a token I can revoke, instead of the Gmail-password trade every other app makes.

Filing means something specific: merchant, amount, and date extracted; category picked from IRS Schedule C lines, favoring my own history so the suggestions converge on right; duplicates caught by image hash; foreign currency converted at the ECB rate for the purchase date. My job shrinks to pressing save on a review card, once per receipt.

Two features do the work I didn't even know needed doing. Mileage draws the route on a map and prices it at the IRS rate for the day I drove. And reconciliation takes a bank statement export and matches it against what I logged, which reliably surfaces the subscriptions and fees I never photographed. That one pays for the app every year.

I'm distributing it the slow way: free until 100 users, then paid, with a free tier that stays. The counter is on the landing page. It's at three of a hundred as I write this, and every one of those users arrived without a marketing budget, which tells me the pitch works when people see it.

If you file a Schedule C: https://expense.labnotes.org
