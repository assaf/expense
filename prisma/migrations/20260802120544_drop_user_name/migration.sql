-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "closed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" DROP COLUMN "name";
