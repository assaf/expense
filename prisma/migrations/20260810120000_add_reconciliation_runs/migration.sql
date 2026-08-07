-- Add reconciliation runs (uploaded credit card / bank statements) and the
-- reconciled flags on expenses. Matches what `prisma db push` applies on
-- deploy — recorded here for migration history.
CREATE TABLE "reconciliation_runs" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "matchedCount" INTEGER NOT NULL,
    "createdCount" INTEGER NOT NULL,
    "skipped" JSONB NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TEXT NOT NULL,
    "completedAt" TEXT,
    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- Expenses gain the reconciliation flags (nullable — nothing backfilled).
ALTER TABLE "expenses" ADD COLUMN "reconciledAt" TEXT,
ADD COLUMN "reconciledInRunId" TEXT;

-- Indexes
CREATE INDEX "reconciliation_runs_accountId_fileHash_idx" ON "reconciliation_runs"("accountId", "fileHash");
CREATE INDEX "reconciliation_runs_accountId_status_idx" ON "reconciliation_runs"("accountId", "status");

-- Foreign keys
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_reconciledInRunId_fkey" FOREIGN KEY ("reconciledInRunId") REFERENCES "reconciliation_runs"("id") ON UPDATE CASCADE ON DELETE SET NULL;
