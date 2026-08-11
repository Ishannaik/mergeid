/**
 * Discord environment configuration.
 *
 * Deliberately narrow: this reads only the variables the gateway client and the
 * command deployer cannot boot without. Full zod-backed application config is
 * #2 — this must not grow into a competing configuration convention.
 *
 * Every validation error names the offending variable and never echoes its
 * value, so a malformed token cannot reach a log, a terminal, or a CI transcript
 * through an error message.
 */

/** Environment source. Mirrors `process.env` so tests can inject fixtures. */
type Env = Record<string, string | undefined>;

/** Validated Discord credentials. `devGuildId` is absent unless configured. */
export interface DiscordConfig {
  readonly token: string;
  readonly applicationId: string;
  readonly devGuildId?: string;
}

const TOKEN = 'DISCORD_TOKEN';
const CLIENT_ID = 'DISCORD_CLIENT_ID';
const DEV_GUILD_ID = 'DISCORD_DEV_GUILD_ID';

/**
 * Returns the trimmed value of `variable`, rejecting blank input.
 *
 * @throws {Error} naming only the variable — never its value.
 */
function requireTrimmed(env: Env, variable: string): string {
  const value = env[variable]?.trim();

  if (value === undefined || value.length === 0) {
    throw new Error(`${variable} is required and must be a non-empty value.`);
  }

  return value;
}

/**
 * Reads and validates the Discord configuration.
 *
 * `DISCORD_DEV_GUILD_ID` is optional: leaving it unset means "deploy globally".
 * When it is present it must still hold a real value, so a blank override fails
 * loudly instead of silently flipping the deployment scope back to global.
 *
 * @param env Environment to read from; defaults to the process environment.
 * @throws {Error} when a required variable is missing or blank, or when the
 *   optional dev-guild variable is present but blank.
 */
export function readDiscordConfig(env: Env = process.env): DiscordConfig {
  const token = requireTrimmed(env, TOKEN);
  const applicationId = requireTrimmed(env, CLIENT_ID);

  // Absent entirely -> global deployment, and the key must stay off the object.
  if (env[DEV_GUILD_ID] === undefined) {
    return { token, applicationId };
  }

  return { token, applicationId, devGuildId: requireTrimmed(env, DEV_GUILD_ID) };
}
