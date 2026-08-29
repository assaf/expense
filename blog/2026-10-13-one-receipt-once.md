# One receipt, once

There are many ways for the same receipt to enter [Expense](https://expense.labnotes.org/?ref=labnotes.org): forward it by email, drag the file into the editor, let the MCP tool fetch it, connect a mailbox and have it imported for you. Each route used to look at metadata on its own, so the same PDF arriving twice could become two expenses.

Now every stored image is fingerprinted: a SHA-256 of the bytes, stamped on the image and copied onto the expense. The same file, arriving by any route, is recognized as the same receipt. The second copy gets skipped or flagged rather than filed: forwarded email plus downloaded copy, retry plus import, whatever the combination.

The fingerprint is the strongest check, and content matching backs it up for the cases where bytes differ. Two photos of the same paper receipt, or the same purchase typed in by hand, count as duplicates when the date, merchant, and amount agree to the cent, and the category, report, and description don't contradict each other. Mileage compares the date, route, and distance instead.

The same-date requirement keeps the honest cases honest: a monthly subscription shares merchant and amount but never the date, so it doesn't false-positive, and a refund never matches the charge it refunds.

And when two entries only look alike but are real, mark them "not a duplicate" and the app remembers that pair.
