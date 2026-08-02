-- Money columns: TEXT → NUMERIC(10,2), nullable. Empty string "" is the
-- app's "no amount set" sentinel and becomes NULL; the domain layer maps
-- NULL back to "".
--
-- The in-place USING casts are deliberate: Prisma's own diff for a
-- String → Decimal? change is DROP COLUMN + ADD COLUMN, which would destroy
-- every stored amount. These ALTERs preserve data.
ALTER TABLE "expenses"
  ALTER COLUMN "amount" DROP NOT NULL,
  ALTER COLUMN "amount" SET DATA TYPE DECIMAL(10,2)
    USING CASE WHEN "amount" = '' THEN NULL ELSE "amount"::decimal(10,2) END,
  ALTER COLUMN "distanceMiles" DROP NOT NULL,
  ALTER COLUMN "distanceMiles" SET DATA TYPE DECIMAL(10,2)
    USING CASE WHEN "distanceMiles" = '' THEN NULL ELSE "distanceMiles"::decimal(10,2) END;

ALTER TABLE "mileage"
  ALTER COLUMN "distanceMiles" DROP NOT NULL,
  ALTER COLUMN "distanceMiles" SET DATA TYPE DECIMAL(10,2)
    USING CASE WHEN "distanceMiles" = '' THEN NULL ELSE "distanceMiles"::decimal(10,2) END;
