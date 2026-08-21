-- Inbox review flow (/email-review): the user scans a connected inbox and
-- decides per receipt-like email — process (→ expense, Trash) or ignore.
--
-- EmailProcessLog gains the email's receivedAt + full From header for the
-- review list display, and two new outcome values ("pending-review",
-- "review-ignored") ride on the existing `outcome` column — no enum change.
ALTER TABLE "email_process_log" ADD COLUMN "receivedAt" TEXT,
ADD COLUMN "fromDisplay" TEXT;

-- Stamp of the last review scan, so the page knows whether the pending list
-- is current (and can auto-scan a freshly connected account).
ALTER TABLE "email_connections" ADD COLUMN "reviewScannedAt" TEXT;
