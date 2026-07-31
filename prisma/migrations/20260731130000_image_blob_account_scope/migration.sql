-- AlterTable
ALTER TABLE "image_blobs" ADD COLUMN "accountId" TEXT NOT NULL DEFAULT '';

-- Adopt existing blobs into their expense's account (single-user era: all
-- rows belong to one account at this point).
UPDATE "image_blobs" SET "accountId" = e."accountId"
FROM (SELECT DISTINCT "imageFile", "accountId" FROM "expenses" WHERE "imageFile" <> '') e
WHERE "image_blobs"."key" = e."imageFile" AND "image_blobs"."accountId" = '';

-- Orphans (no expense references them) go to the oldest account.
UPDATE "image_blobs" SET "accountId" = a."id"
FROM (SELECT "id" FROM "accounts" ORDER BY "createdAt" LIMIT 1) a
WHERE "image_blobs"."accountId" = '';

-- AlterTable
ALTER TABLE "image_blobs" DROP CONSTRAINT "image_blobs_pkey",
ALTER COLUMN "accountId" DROP DEFAULT,
ADD CONSTRAINT "image_blobs_pkey" PRIMARY KEY ("accountId", "key");

-- AddForeignKey
ALTER TABLE "image_blobs" ADD CONSTRAINT "image_blobs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
