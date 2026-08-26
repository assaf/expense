-- EmailProcessLog: expenseId + reason columns (additive).
-- Rerun-safe. The backfill converts the error-column marker strings
-- (written by the pre-column code) into the new columns; run it again
-- after the new code deploys to catch rows created in the window.

ALTER TABLE email_process_log
  ADD COLUMN IF NOT EXISTS "expenseId" TEXT,
  ADD COLUMN IF NOT EXISTS "reason" TEXT;

-- Receipt-email stamps: "expense:<id>" or "expense:<id>; Missing: ..."
UPDATE email_process_log
SET "expenseId" = substring(error from 8),
    "reason"    = NULLIF(trim(split_part(error, ';', 2)), ''),
    error       = NULL
WHERE error LIKE 'expense:%';

-- Notification-derived expenses: "notification-expense:<id>[; Missing: ...]"
UPDATE email_process_log
SET "expenseId" = substring(error from 20),
    "reason"    = NULLIF(trim(split_part(error, ';', 2)), ''),
    error       = NULL
WHERE error LIKE 'notification-expense:%';

-- Superseded notifications: "superseded:<coverExpenseId>"
UPDATE email_process_log
SET "expenseId" = substring(error from 11),
    "reason"    = 'superseded',
    error       = NULL
WHERE error LIKE 'superseded:%';

-- Hand-ignored review items: "user ignored"
UPDATE email_process_log
SET "reason" = 'user ignored',
    error    = NULL
WHERE error = 'user ignored';

-- Bank-feed view: the parsed charge amount on notification rows.
ALTER TABLE email_process_log
  ADD COLUMN IF NOT EXISTS "chargeAmount" TEXT;
