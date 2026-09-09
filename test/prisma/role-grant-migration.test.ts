import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
const migrationsRoot = new URL('prisma/migrations/', root);
const initMigration = readFileSync(
  new URL('20260805213428_init/migration.sql', migrationsRoot),
  'utf8',
);
const migrationSql = readdirSync(migrationsRoot)
  .filter((directory) => directory !== 'migration_lock.toml')
  .sort()
  .map((directory) => readFileSync(new URL(`${directory}/migration.sql`, migrationsRoot), 'utf8'))
  .join('\n');
const schema = readFileSync(new URL('prisma/schema.prisma', root), 'utf8');

function roleGrantPrimaryKeys(sql: string): string[][] {
  return [...sql.matchAll(/role_grants_pkey"\s+PRIMARY KEY \(([^)]+)\)/g)].map((match) =>
    (match[1] ?? '').split(',').map((column) => column.replaceAll('"', '').trim()),
  );
}

describe('role_grants migration history', () => {
  it('preserves the applied init migration and converges on one row per qualifying rule', () => {
    expect(roleGrantPrimaryKeys(initMigration)).toEqual([
      ['guild_id', 'discord_user_id', 'role_id'],
    ]);
    expect(roleGrantPrimaryKeys(migrationSql).at(-1)).toEqual([
      'guild_id',
      'discord_user_id',
      'role_id',
      'rule_id',
    ]);
    expect(schema).toContain('@@id([guildId, discordUserId, roleId, ruleId])');
  });
});
