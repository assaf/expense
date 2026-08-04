/*
  Warnings:

  - You are about to drop the `api_tokens` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_accountId_fkey";

-- DropTable
DROP TABLE "api_tokens";
