-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "bodyFormat" TEXT NOT NULL DEFAULT 'TEXT';

-- AlterTable
ALTER TABLE "Email" ADD COLUMN     "bodyIsHtml" BOOLEAN NOT NULL DEFAULT false;
