-- verification_rules.created_at exists in the live database and docs, but was
-- missing from the init migration's CREATE TABLE. Backfill it for fresh DBs;
-- existing DBs already carry the column.
ALTER TABLE "verification_rules" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "verification_rules" ALTER COLUMN "created_at" DROP DEFAULT;
