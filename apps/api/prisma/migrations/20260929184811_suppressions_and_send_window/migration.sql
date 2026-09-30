-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "sendWindow" JSONB,
ADD COLUMN     "skipRecentDays" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "SuppressedEmail" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuppressedEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SuppressedEmail_userId_createdAt_idx" ON "SuppressedEmail"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SuppressedEmail_userId_email_key" ON "SuppressedEmail"("userId", "email");

-- AddForeignKey
ALTER TABLE "SuppressedEmail" ADD CONSTRAINT "SuppressedEmail_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
