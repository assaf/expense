-- CreateTable
CREATE TABLE "inbound_senders" (
    "accountId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,

    CONSTRAINT "inbound_senders_pkey" PRIMARY KEY ("accountId","address")
);

-- CreateIndex
CREATE INDEX "inbound_senders_address_idx" ON "inbound_senders"("address");

-- AddForeignKey
ALTER TABLE "inbound_senders" ADD CONSTRAINT "inbound_senders_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
