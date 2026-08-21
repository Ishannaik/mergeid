-- Align Postgres enum type names with the names Prisma generates from this
-- schema (VerificationRuleKind / SyncRunStatus). Fresh databases get the new
-- types created here; existing ones already have them under these names.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'VerificationRuleKind' AND n.nspname = 'public') THEN
    CREATE TYPE "VerificationRuleKind" AS ENUM ('ORG', 'REPO', 'TEAM');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'SyncRunStatus' AND n.nspname = 'public') THEN
    CREATE TYPE "SyncRunStatus" AS ENUM ('OK', 'PARTIAL', 'FAILED');
  END IF;
END
$$;
ALTER TABLE "verification_rules" ALTER COLUMN "kind" DROP DEFAULT;
ALTER TABLE "sync_runs" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "verification_rules" ALTER COLUMN "kind" TYPE "VerificationRuleKind" USING "kind"::text::"VerificationRuleKind";
ALTER TABLE "sync_runs" ALTER COLUMN "status" TYPE "SyncRunStatus" USING "status"::text::"SyncRunStatus";
