-- CreateTable
CREATE TABLE "LeadList" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListLead" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "vars" JSONB,
    "status" TEXT,
    "reason" TEXT,
    "suggestion" TEXT,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListLead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeadList_userId_updatedAt_idx" ON "LeadList"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ListLead_listId_status_idx" ON "ListLead"("listId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ListLead_listId_email_key" ON "ListLead"("listId", "email");

-- AddForeignKey
ALTER TABLE "LeadList" ADD CONSTRAINT "LeadList_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListLead" ADD CONSTRAINT "ListLead_listId_fkey" FOREIGN KEY ("listId") REFERENCES "LeadList"("id") ON DELETE CASCADE ON UPDATE CASCADE;
