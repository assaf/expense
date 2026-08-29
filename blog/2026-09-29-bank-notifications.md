# Two emails, one charge

Buying something usually generates two emails: the bank's "a new transaction was charged to your account" alert, and the merchant's receipt. Same charge, two emails. The review screen in [Expense](https://expense.labnotes.org/?ref=labnotes.org) used to offer both, which meant either a duplicate expense or an ignore habit that could smother the real receipt.

Now the app pairs them up. The trick is arrival timing, because it mirrors how a charge actually unfolds: the bank's alert lands within a couple of minutes of the post, and the merchant's receipt follows within the hour. A notification counts as covered when the receipt's email arrived after it, within two hours. Covered notifications are marked superseded: they show up in a "Bank notifications skipped" audit section, each linked to the receipt that covered them, and the emails stay in your inbox the whole time.

It errs on the side of showing you things. Two same-amount charges ten minutes apart with only one receipt? Only the first notification is covered. The second stays listed, because nothing proves what it belongs to. Delete the receipt and the notification comes back. Nothing is silently dropped.

The other direction matters just as much: some merchants never send receipts (a self-storage place, say, that only emits bank alerts). Those stay visible under "Bank charges with no expense" until you turn them into an expense or dismiss them. That's where card-only charges used to get lost.

One more thing: connecting a mailbox now scans the last 90 days of your inbox, up to 500 emails, instead of just the 50 most recent. The backlog shows up for review instead of only new mail being processed.
