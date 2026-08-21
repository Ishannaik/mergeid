-- Audit context is optional: link/unlink events are recorded during OAuth,
-- before the actor shares a guild with the bot.
ALTER TABLE "audit_events" ALTER COLUMN "guild_id" DROP NOT NULL,
ALTER COLUMN "actor_discord_id" DROP NOT NULL,
ALTER COLUMN "subject" DROP NOT NULL;
