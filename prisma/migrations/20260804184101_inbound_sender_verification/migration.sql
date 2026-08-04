-- AlterTable
ALTER TABLE "inbound_senders" ADD COLUMN     "verificationSentAt" TEXT,
ADD COLUMN     "verificationTokenHash" TEXT;

-- CreateTable
CREATE TABLE "inbound_sender_verifications" (
    "address" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "verifiedAt" TEXT NOT NULL,

    CONSTRAINT "inbound_sender_verifications_pkey" PRIMARY KEY ("address")
);

-- AddForeignKey
ALTER TABLE "inbound_sender_verifications" ADD CONSTRAINT "inbound_sender_verifications_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
