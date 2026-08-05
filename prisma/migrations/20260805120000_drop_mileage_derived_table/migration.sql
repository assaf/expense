/*
  Warnings:

  - You are about to drop the `mileage` table. It is a derived artifact
    (mirrors the old mileage.csv) with no production readers — expenses
    store all mileage fields themselves. Dropped with the per-row
    upsert change (expense writes no longer rebuild it).

*/
-- DropForeignKey
ALTER TABLE "mileage" DROP CONSTRAINT "mileage_accountId_fkey";

-- DropTable
DROP TABLE "mileage";
