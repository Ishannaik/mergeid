-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RuleKind" AS ENUM ('ORG', 'REPO', 'TEAM');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('PASS', 'FAIL', 'ERROR');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('OK', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "guilds" (
    "guild_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "guilds_pkey" PRIMARY KEY ("guild_id")
);

-- CreateTable
CREATE TABLE "users" (
    "discord_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("discord_user_id")
);

-- CreateTable
CREATE TABLE "github_links" (
    "id" UUID NOT NULL,
    "discord_user_id" TEXT NOT NULL,
    "github_user_id" TEXT NOT NULL,
    "github_login" TEXT NOT NULL,
    "token_encrypted" TEXT NOT NULL,
    "token_key_version" TEXT NOT NULL,
    "token_scopes" TEXT NOT NULL,
    "linked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_verified_at" TIMESTAMPTZ(6),

    CONSTRAINT "github_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_rules" (
    "id" UUID NOT NULL,
    "guild_id" TEXT NOT NULL,
    "kind" "RuleKind" NOT NULL,
    "org" TEXT NOT NULL,
    "repo" TEXT,
    "team_slug" TEXT,
    "role_id" TEXT NOT NULL,
    "recheck_minutes" INTEGER NOT NULL DEFAULT 60,
    "required_scopes" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "verification_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_results" (
    "link_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL,
    "detail" TEXT,
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "first_failed_at" TIMESTAMPTZ(6),

    CONSTRAINT "membership_results_pkey" PRIMARY KEY ("link_id","rule_id")
);

-- CreateTable
CREATE TABLE "role_grants" (
    "guild_id" TEXT NOT NULL,
    "discord_user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "rule_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_grants_pkey" PRIMARY KEY ("guild_id","discord_user_id","role_id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "guild_id" TEXT NOT NULL,
    "actor_discord_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "stats" JSONB NOT NULL DEFAULT '{}',
    "status" "SyncStatus" NOT NULL,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_links_discord_user_id_key" ON "github_links"("discord_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_links_github_user_id_key" ON "github_links"("github_user_id");

-- CreateIndex
CREATE INDEX "verification_rules_guild_id_enabled_idx" ON "verification_rules"("guild_id", "enabled");

-- CreateIndex
CREATE INDEX "membership_results_rule_id_status_idx" ON "membership_results"("rule_id", "status");

-- CreateIndex
CREATE INDEX "membership_results_checked_at_idx" ON "membership_results"("checked_at");

-- CreateIndex
CREATE INDEX "role_grants_rule_id_idx" ON "role_grants"("rule_id");

-- CreateIndex
CREATE INDEX "audit_events_guild_id_at_idx" ON "audit_events"("guild_id", "at" DESC);

-- CreateIndex
CREATE INDEX "sync_runs_started_at_idx" ON "sync_runs"("started_at");

-- CreateIndex
CREATE INDEX "sync_runs_rule_id_idx" ON "sync_runs"("rule_id");

-- AddForeignKey
ALTER TABLE "github_links" ADD CONSTRAINT "github_links_discord_user_id_fkey" FOREIGN KEY ("discord_user_id") REFERENCES "users"("discord_user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_rules" ADD CONSTRAINT "verification_rules_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guilds"("guild_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_results" ADD CONSTRAINT "membership_results_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "github_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_results" ADD CONSTRAINT "membership_results_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "verification_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_grants" ADD CONSTRAINT "role_grants_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guilds"("guild_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_grants" ADD CONSTRAINT "role_grants_discord_user_id_fkey" FOREIGN KEY ("discord_user_id") REFERENCES "users"("discord_user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_grants" ADD CONSTRAINT "role_grants_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "verification_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guilds"("guild_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "verification_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

