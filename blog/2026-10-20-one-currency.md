# One currency

The IRS wants foreign-currency expenses in dollars, converted at the rate for the day you paid, not the day you file. [Expense](https://expense.labnotes.org/?ref=labnotes.org) now does that conversion itself.

Foreign-currency receipts convert to USD at the ECB's daily reference rate for the expense date. The rates come from Frankfurter, an ECB mirror that needs no API key, the same no-key pattern as the maps stack. Bought something on a Saturday? There's no weekend rate, so it rolls back to Friday's. A future date, or a currency the ECB doesn't publish, means no rate exists: the receipt is stored as-is with a note saying so, rather than inventing a conversion.

The provenance lives in the description, in a strict little format:

> (Converted from EUR 50.00 at 1.1699 USD/EUR, ECB rate for 2026-08-27.)

Strict because the app rewrites it in place: save again, or change the date, and the old note is replaced, never stacked. The `amount` field stays the one number every report, total, and reconciliation uses, so nothing downstream has to know about currencies at all.

Change the date in the editor and the receipt re-converts at the new rate, unless you've edited the amount by hand; then it's yours. It works on every route in: the editor, receipts by email, and the MCP tool. Older expenses aren't backfilled; they stay exactly as they were captured.
