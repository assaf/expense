# Reconciliation

`/reconcile` matches an uploaded credit-card statement
(CSV / QFX/OFX / PDF) against the account's receipt expenses. The matcher
(`app/lib/reconcile.server.ts`) only considers receipt expenses with a
date + non-zero amount that are **not already reconciled** (mileage is
never a card transaction); date tolerance ±2 days, amount within $0.50 /
1%, and refund/credit/payment lines never auto-match. Exact date+amount+
a shared merchant token = high-confidence auto match; a close match with
a different merchant, several candidates, or two lines claiming the same
expense goes to review where the user picks (or discards). Completing
marks matched expenses `reconciledAt` and creates any “add as new
expense” rows (with a rendered statement receipt as the image) in **one
transaction**; undecided rows are discarded. **Nothing existing is ever
deleted by reconciliation.** Draft runs store rows/matches/decisions in a
`reconciliation_runs.data` JSON column (survives reloads); the file sha256
(`fileHash`) makes re-uploads idempotent (resume the draft, or refuse when
already completed). `Expense.reconciledAt` is only ever written by the
reconciliation flow; `expenseData` deliberately omits it so a normal save
can't wipe the status. The home page shows a green “Reconciled” badge and
a Reconcile entry point. The MCP `reconcile` tool is the same matcher in
read-only mode (adds a `needsReview` tier). PDF support is text-layer
only: scanned statements can't be parsed; the UI says so and points at
the CSV/QFX export.
