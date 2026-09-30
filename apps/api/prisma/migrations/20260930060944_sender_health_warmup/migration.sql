-- AlterTable
ALTER TABLE "Sender" ADD COLUMN     "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "pauseReason" TEXT,
ADD COLUMN     "pausedUntil" TIMESTAMP(3),
ADD COLUMN     "warmupEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "warmupIncrement" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "warmupStart" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "warmupStartedAt" TIMESTAMP(3),
ADD COLUMN     "warmupTarget" INTEGER NOT NULL DEFAULT 50;
