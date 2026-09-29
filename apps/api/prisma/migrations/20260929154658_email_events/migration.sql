-- CreateEnum
CREATE TYPE "EmailEventType" AS ENUM ('SCHEDULED', 'RATE_LIMITED', 'SEND_ERROR', 'SENT', 'FAILED', 'RETRIED', 'CANCELLED', 'PAUSED', 'RESUMED');

-- CreateTable
CREATE TABLE "EmailEvent" (
    "id" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "EmailEventType" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "meta" JSONB,

    CONSTRAINT "EmailEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailEvent_emailId_at_idx" ON "EmailEvent"("emailId", "at");

-- CreateIndex
CREATE INDEX "EmailEvent_userId_type_at_idx" ON "EmailEvent"("userId", "type", "at");

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "Email"("id") ON DELETE CASCADE ON UPDATE CASCADE;
