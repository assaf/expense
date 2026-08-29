# Finding things

The search box on the expense list in [Expense](https://expense.labnotes.org/?ref=labnotes.org) understands fields now. `report:`, `category:`, and `merchant:` match exactly, case-insensitive, and `description:` matches anywhere in the description. Values can contain spaces: `report:2026 travel` is one filter, not two. Repeating a key ORs (`merchant:shell merchant:chevron`), mixing keys ANDs, and an unknown prefix just stays free text, so typing `10:30` doesn't suddenly break everything. Plain words keep ANDing against everything searchable, as always.

Two things that make this faster than it sounds.

The suggestions under the box come from your own history: your merchants, categories, and reports, most-used first. "How much on XYZ" becomes a pick instead of typing, and the operator forms (`report:`, `merchant:`) are right there in the list.

The total under the list is computed from exactly what you filtered. Search "dentist" and the total is your dental spending; no squinting at rows, no spreadsheet arithmetic.

Small touches while you type: the list shows a filtering state while the query settles instead of flashing stale results for a beat, and `?` (or the command palette) drops you straight into the box.
