-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "bounceMinSends" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "bounceThresholdPercent" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "pauseReason" TEXT;

-- AlterTable
ALTER TABLE "Email" ADD COLUMN     "bouncedAt" TIMESTAMP(3);
