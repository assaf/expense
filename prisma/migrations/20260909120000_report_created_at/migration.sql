-- Report creation timestamps (2026-09-09): surfaced in the AI context and
-- available for display. Nullable — reports that predate the column keep
-- NULL (their creation date is unknown; id order approximates age).
ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3);
