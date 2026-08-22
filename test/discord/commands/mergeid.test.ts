import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

import { executeMergeid } from '../../../src/discord/commands/mergeid.js';
import { makeLogger } from '../fixtures.js';

const GUILD_ID = '111111111111111111';
const USER_ID = '333333333333333333';
const ROLE_A = '444444444444444444';
const CHANNEL_A = '222222222222222222';

type Mock = ReturnType<typeof vi.fn>;

function makeRules(overrides: Partial<Record<string, Mock>> = {}) {
  return {
    getSettings: vi.fn(),
    addProtectedRole: vi.fn(),
    removeProtectedRole: vi.fn(),
    setLogChannel: vi.fn(),
    listAuditEvents: vi.fn(),
    ...overrides,
  };
}

/** Interaction double: options come back through typed getters. */
function interaction(options: {
  group: string | null;
  sub: string;
  role?: { id: string } | null;
  channel?: { id: string } | null;
  count?: number | null;
}): ChatInputCommandInteraction {
  const replies: unknown[] = [];
  return {
    user: { id: USER_ID },
    guildId: GUILD_ID,
    options: {
      getSubcommandGroup: () => options.group,
      getSubcommand: () => options.sub,
      getRole: (name: string) => (name === 'role' ? (options.role ?? null) : null),
      getChannel: (name: string) => (name === 'channel' ? (options.channel ?? null) : null),
      getInteger: (name: string) => (name === 'count' ? (options.count ?? null) : null),
    },
    editReply: vi.fn(async (payload: unknown) => {
      replies.push(payload);
    }),
  } as unknown as ChatInputCommandInteraction;
}

function contentOf(it: ChatInputCommandInteraction): string {
  const editReply = (it as unknown as { editReply: Mock }).editReply;
  const arg = editReply.mock.calls[0]?.[0];
  return typeof arg === 'string' ? arg : (arg as { content: string }).content;
}

describe('/mergeid settings show', () => {
  it('renders allowlist, protected roles, and log channel', async () => {
    const rules = makeRules();
    rules.getSettings.mockResolvedValue({
      assignableRoles: [ROLE_A],
      protectedRoleIds: [],
      logChannelId: CHANNEL_A,
    });
    const it = interaction({ group: 'settings', sub: 'show' });

    await executeMergeid(it, { logger: makeLogger(), rules });

    expect(rules.getSettings).toHaveBeenCalledWith(GUILD_ID);
    const content = contentOf(it);
    expect(content).toContain('Allowlisted roles');
    expect(content).toContain(`<@&${ROLE_A}>`);
    expect(content).toContain(`<#${CHANNEL_A}>`);
  });

  it('says "none" and "not set" when settings are empty', async () => {
    const rules = makeRules();
    rules.getSettings.mockResolvedValue({ assignableRoles: [], protectedRoleIds: [] });
    const it = interaction({ group: 'settings', sub: 'show' });

    await executeMergeid(it, { logger: makeLogger(), rules });

    const content = contentOf(it);
    expect(content).toContain('none');
    expect(content).toContain('not set');
  });
});

describe('/mergeid settings protect-role', () => {
  it('calls the service and confirms with the role mention', async () => {
    const rules = makeRules();
    rules.addProtectedRole.mockResolvedValue({
      assignableRoles: [],
      protectedRoleIds: [ROLE_A],
    });
    const it = interaction({ group: 'settings', sub: 'protect-role', role: { id: ROLE_A } });

    await executeMergeid(it, { logger: makeLogger(), rules });

    expect(rules.addProtectedRole).toHaveBeenCalledWith({
      guildId: GUILD_ID,
      roleId: ROLE_A,
      actorDiscordId: USER_ID,
    });
    expect(contentOf(it)).toContain(`<@&${ROLE_A}>`);
  });

  it('unprotect calls the removal service', async () => {
    const rules = makeRules();
    rules.removeProtectedRole.mockResolvedValue({ assignableRoles: [], protectedRoleIds: [] });
    const it = interaction({ group: 'settings', sub: 'unprotect-role', role: { id: ROLE_A } });

    await executeMergeid(it, { logger: makeLogger(), rules });

    expect(rules.removeProtectedRole).toHaveBeenCalledWith({
      guildId: GUILD_ID,
      roleId: ROLE_A,
      actorDiscordId: USER_ID,
    });
  });

  it('refuses to run without a role option', async () => {
    const rules = makeRules();
    const it = interaction({ group: 'settings', sub: 'protect-role', role: null });

    await executeMergeid(it, { logger: makeLogger(), rules });

    expect(rules.addProtectedRole).not.toHaveBeenCalled();
    expect(contentOf(it)).toContain('Pick a role');
  });
});

describe('/mergeid settings log-channel', () => {
  it('sets the channel when one is given', async () => {
    const rules = makeRules();
    rules.setLogChannel.mockResolvedValue({
      assignableRoles: [],
      protectedRoleIds: [],
      logChannelId: CHANNEL_A,
    });
    const it = interaction({ group: 'settings', sub: 'log-channel', channel: { id: CHANNEL_A } });

    await executeMergeid(it, { logger: makeLogger(), rules });

    expect(rules.setLogChannel).toHaveBeenCalledWith({
      guildId: GUILD_ID,
      channelId: CHANNEL_A,
      actorDiscordId: USER_ID,
    });
    expect(contentOf(it)).toContain(`<#${CHANNEL_A}>`);
  });

  it('clears the channel when the option is omitted', async () => {
    const rules = makeRules();
    rules.setLogChannel.mockResolvedValue({ assignableRoles: [], protectedRoleIds: [] });
    const it = interaction({ group: 'settings', sub: 'log-channel', channel: null });

    await executeMergeid(it, { logger: makeLogger(), rules });

    expect(rules.setLogChannel).toHaveBeenCalledWith({
      guildId: GUILD_ID,
      channelId: null,
      actorDiscordId: USER_ID,
    });
    expect(contentOf(it)).toContain('cleared');
  });
});

describe('/mergeid audit', () => {
  it('lists recent events as relative timestamps', async () => {
    const rules = makeRules();
    rules.listAuditEvents.mockResolvedValue([
      {
        id: 'a1',
        actorDiscordId: USER_ID,
        action: 'rule.created',
        subject: '0f2b6a52-0000-0000-0000-000000000000',
        meta: {},
        at: new Date('2026-08-22T10:00:00Z'),
      },
    ]);
    const it = interaction({ group: null, sub: 'audit', count: 5 });

    await executeMergeid(it, { logger: makeLogger(), rules });

    expect(rules.listAuditEvents).toHaveBeenCalledWith({ guildId: GUILD_ID, limit: 5 });
    const content = contentOf(it);
    expect(content).toContain('rule.created');
    expect(content).toContain('<t:');
  });

  it('defaults the count to 10', async () => {
    const rules = makeRules();
    rules.listAuditEvents.mockResolvedValue([]);
    const it = interaction({ group: null, sub: 'audit' });

    await executeMergeid(it, { logger: makeLogger(), rules });

    expect(rules.listAuditEvents).toHaveBeenCalledWith({ guildId: GUILD_ID, limit: 10 });
  });

  it('explains when there is no audit history yet', async () => {
    const rules = makeRules();
    rules.listAuditEvents.mockResolvedValue([]);
    const it = interaction({ group: null, sub: 'audit' });

    await executeMergeid(it, { logger: makeLogger(), rules });

    expect(contentOf(it)).toContain('No audit events');
  });
});
