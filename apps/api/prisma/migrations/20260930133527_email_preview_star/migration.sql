-- AlterTable
ALTER TABLE "Email" ADD COLUMN     "preview" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "starred" BOOLEAN NOT NULL DEFAULT false;

-- Backfill the list snippet for emails created before this column existed.
UPDATE "Email" SET "preview" = left(btrim(regexp_replace("body", '\s+', ' ', 'g')), 140) WHERE "preview" = '';
