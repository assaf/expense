-- Account billing tier (2026-09-07): "paid" | "gratis" unlock conversational
-- AI (insights); NULL = signed up without a plan, AI shows an upgrade prompt.
-- Existing accounts are grandfathered to "gratis". Nullable, no default, so
-- hand-ALTER before deploy is safe (old code ignores the column).
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "plan" TEXT;
UPDATE "accounts" SET "plan" = 'gratis' WHERE "plan" IS NULL;
