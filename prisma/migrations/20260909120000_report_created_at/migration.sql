-- Report creation timestamps (2026-09-09): surfaced in the AI context and
-- available for display. Nullable — reports that predate the column keep
-- NULL (their creation date is unknown; id order approximates age).
ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3);

-- Backfill: approximate each existing report's creation date from its
-- earliest expense (a report can't be younger than its first expense).
-- Reports with no expenses keep NULL.
UPDATE "reports" SET "createdAt" = sub.first_created
FROM (
  SELECT "accountId", report, MIN("createdAt") AS first_created
  FROM expenses
  WHERE report <> ''
  GROUP BY "accountId", report
) sub
WHERE "reports"."accountId" = sub."accountId"
  AND "reports".name = sub.report
  AND "reports"."createdAt" IS NULL;
