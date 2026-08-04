-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "mileageType" TEXT NOT NULL DEFAULT 'business';

-- CreateTable
CREATE TABLE "mileage_rates" (
    "id" BIGSERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "rate" DECIMAL(5,3) NOT NULL,
    "createdAt" TEXT NOT NULL,

    CONSTRAINT "mileage_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mileage_rates_type_startDate_idx" ON "mileage_rates"("type", "startDate");
