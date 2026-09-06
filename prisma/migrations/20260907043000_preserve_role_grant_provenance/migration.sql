-- Keep one provenance row for every qualifying rule. This must be a forward
-- migration because deployed databases have already applied the init migration.
ALTER TABLE "role_grants" DROP CONSTRAINT "role_grants_pkey";
ALTER TABLE "role_grants" ADD CONSTRAINT "role_grants_pkey"
PRIMARY KEY ("guild_id", "discord_user_id", "role_id", "rule_id");
