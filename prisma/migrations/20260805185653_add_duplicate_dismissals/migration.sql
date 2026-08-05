-- CreateTable
CREATE TABLE "duplicate_dismissals" (
    "id" TEXT NOT NULL,
    "expenseAId" TEXT NOT NULL,
    "expenseBId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,

    CONSTRAINT "duplicate_dismissals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "duplicate_dismissals_accountId_expenseAId_expenseBId_key" ON "duplicate_dismissals"("accountId", "expenseAId", "expenseBId");

-- AddForeignKey
ALTER TABLE "duplicate_dismissals" ADD CONSTRAINT "duplicate_dismissals_expenseAId_fkey" FOREIGN KEY ("expenseAId") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_dismissals" ADD CONSTRAINT "duplicate_dismissals_expenseBId_fkey" FOREIGN KEY ("expenseBId") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_dismissals" ADD CONSTRAINT "duplicate_dismissals_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
