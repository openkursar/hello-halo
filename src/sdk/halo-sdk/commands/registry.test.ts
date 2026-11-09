/**
 * Unit tests for the slash command registry subsystem.
 *
 * Covered surfaces:
 *   - CommandRegistry CRUD (register / unregister / get / has / list / size)
 *   - Alias indexing and case-insensitive lookup
 *   - Last-write-wins on name collision
 *   - filterUserInvocable filter pipeline
 *   - Built-in command set integrity
 *   - normalizeUserCommands coercion
 *   - listUserInvocable* helpers
 */

import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_COMMANDS,
  BUILT_IN_COMMAND_NAMES,
  CommandRegistry,
  buildSessionRegistry,
  createSessionRegistry,
  filterUserInvocable,
  getCommandName,
  isCommandEnabled,
  listUserInvocableNames,
  listUserInvocableSlashCommands,
  normalizeUserCommands,
  toSlashCommand,
} from './index.js';
import type { Command } from './index.js';

const local = (name: string, overrides: Partial<Command> = {}): Command => ({
  type: 'local',
  name,
  description: `${name} description`,
  source: 'builtin',
  ...overrides,
});

// ---------------------------------------------------------------------------
// CommandRegistry — CRUD
// ---------------------------------------------------------------------------

describe('CommandRegistry', () => {
  it('register/get/has/size — basic round trip', () => {
    const r = new CommandRegistry();
    expect(r.size()).toBe(0);
    r.register(local('foo'));
    expect(r.size()).toBe(1);
    expect(r.has('foo')).toBe(true);
    expect(r.get('foo')?.name).toBe('foo');
  });

  it('lookup is case-insensitive', () => {
    const r = new CommandRegistry();
    r.register(local('Help'));
    expect(r.has('help')).toBe(true);
    expect(r.has('HELP')).toBe(true);
    expect(r.get('hELp')?.name).toBe('Help');
  });

  it('aliases are indexed and resolve to the canonical command', () => {
    const r = new CommandRegistry();
    r.register(local('clear', { aliases: ['reset', 'new'] }));
    expect(r.get('reset')?.name).toBe('clear');
    expect(r.get('new')?.name).toBe('clear');
    expect(r.has('reset')).toBe(true);
  });

  it('register replaces same-name entry and rebuilds aliases (last-write-wins)', () => {
    const r = new CommandRegistry();
    r.register(local('foo', { aliases: ['old'] }));
    r.register(local('foo', { aliases: ['fresh'], description: 'new' }));
    expect(r.size()).toBe(1);
    expect(r.get('foo')?.description).toBe('new');
    expect(r.get('fresh')?.name).toBe('foo');
    expect(r.get('old')).toBeUndefined();
  });

  it('unregister removes command and its aliases', () => {
    const r = new CommandRegistry();
    r.register(local('clear', { aliases: ['reset'] }));
    expect(r.unregister('clear')).toBe(true);
    expect(r.unregister('clear')).toBe(false);
    expect(r.get('reset')).toBeUndefined();
    expect(r.size()).toBe(0);
  });

  it('unregister of unknown name returns false', () => {
    const r = new CommandRegistry();
    expect(r.unregister('nope')).toBe(false);
  });

  it('list() returns a frozen snapshot', () => {
    const r = new CommandRegistry();
    r.register(local('a'));
    const snapshot = r.list();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => (snapshot as Command[]).push(local('b'))).toThrow();
  });

  it('clear() resets state', () => {
    const r = new CommandRegistry();
    r.register(local('a', { aliases: ['x'] }));
    r.clear();
    expect(r.size()).toBe(0);
    expect(r.get('x')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// filter pipeline
// ---------------------------------------------------------------------------

describe('filterUserInvocable', () => {
  it('drops commands with userInvocable === false', () => {
    const cmds: Command[] = [
      local('visible'),
      local('model-only', { userInvocable: false }),
    ];
    const out = filterUserInvocable(cmds);
    expect(out.map((c) => c.name)).toEqual(['visible']);
  });

  it('drops hidden commands', () => {
    const cmds: Command[] = [
      local('visible'),
      local('hidden', { isHidden: true }),
    ];
    const out = filterUserInvocable(cmds);
    expect(out.map((c) => c.name)).toEqual(['visible']);
  });

  it('drops disabled commands', () => {
    const cmds: Command[] = [
      local('on'),
      local('off', { isEnabled: () => false }),
    ];
    const out = filterUserInvocable(cmds);
    expect(out.map((c) => c.name)).toEqual(['on']);
  });
});

describe('isCommandEnabled', () => {
  it('defaults to enabled when isEnabled is omitted', () => {
    expect(isCommandEnabled(local('x'))).toBe(true);
  });
  it('reflects the predicate when provided', () => {
    expect(isCommandEnabled(local('x', { isEnabled: () => false }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Built-in set integrity
// ---------------------------------------------------------------------------

describe('BUILT_IN_COMMANDS', () => {
  it('is non-empty', () => {
    expect(BUILT_IN_COMMANDS.length).toBeGreaterThan(0);
  });

  it('every entry has unique name', () => {
    const seen = new Set<string>();
    for (const cmd of BUILT_IN_COMMANDS) {
      expect(seen.has(cmd.name)).toBe(false);
      seen.add(cmd.name);
    }
  });

  it('every entry declares source: builtin', () => {
    for (const cmd of BUILT_IN_COMMANDS) {
      expect(cmd.source).toBe('builtin');
    }
  });

  it('does not advertise unsupported execution controls', () => {
    for (const command of BUILT_IN_COMMANDS) {
      for (const field of ['disableModelInvocation', 'isSensitive', 'supportsNonInteractive', 'argNames', 'model', 'allowedTools']) {
        expect(command).not.toHaveProperty(field);
      }
    }
  });

  it('BUILT_IN_COMMAND_NAMES contains every name and alias', () => {
    for (const cmd of BUILT_IN_COMMANDS) {
      expect(BUILT_IN_COMMAND_NAMES.has(cmd.name)).toBe(true);
      for (const alias of cmd.aliases ?? []) {
        expect(BUILT_IN_COMMAND_NAMES.has(alias)).toBe(true);
      }
    }
  });

  it('exposes the canonical user-invocable set the SDK ships with', () => {
    const reg = new CommandRegistry(BUILT_IN_COMMANDS);
    const names = listUserInvocableNames(reg);
    // All built-ins are user-invocable and visible in autocomplete:
    for (const expected of [
      'compact', 'context', 'cost', 'init',
      'clear', 'help', 'mcp', 'model', 'status', 'usage',
    ]) {
      expect(names).toContain(expected);
      expect(reg.get(expected)).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeUserCommands — coercion of the heterogeneous public input shape
// ---------------------------------------------------------------------------

describe('normalizeUserCommands', () => {
  it('returns [] for undefined / empty input', () => {
    expect(normalizeUserCommands(undefined)).toEqual([]);
    expect(normalizeUserCommands([])).toEqual([]);
  });

  it('coerces strings into local commands tagged as user source', () => {
    const out = normalizeUserCommands(['foo', '  ', 'bar']);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: 'local', name: 'foo', source: 'user' });
    expect(out[1]).toMatchObject({ type: 'local', name: 'bar', source: 'user' });
  });

  it('coerces wire-format SlashCommand into local command', () => {
    const out = normalizeUserCommands([
      { name: 'help', description: 'Show help', argumentHint: '<topic>' },
    ]);
    expect(out[0]).toMatchObject({
      type: 'local',
      name: 'help',
      description: 'Show help',
      argumentHint: '<topic>',
      source: 'user',
    });
  });

  it('preserves typed Command entries verbatim (defaulting source to user)', () => {
    const out = normalizeUserCommands([
      { type: 'prompt', name: 'init', description: 'Init repo' },
    ]);
    expect(out[0]).toMatchObject({
      type: 'prompt',
      name: 'init',
      source: 'user',
    });
  });

  it('drops malformed entries silently', () => {
    const out = normalizeUserCommands([
      'ok',
      // @ts-expect-error — missing name
      { description: 'bad' },
      // @ts-expect-error — null
      null,
      { name: '', description: 'empty' } as never,
    ]);
    expect(out.map((c) => c.name)).toEqual(['ok']);
  });
});

// ---------------------------------------------------------------------------
// buildSessionRegistry / createSessionRegistry
// ---------------------------------------------------------------------------

describe('buildSessionRegistry', () => {
  it('seeds built-ins when no user commands provided', () => {
    const reg = buildSessionRegistry(undefined);
    expect(reg.size()).toBe(BUILT_IN_COMMANDS.length);
    expect(reg.has('clear')).toBe(true);
  });

  it('overlays user commands with last-write-wins on name collision (legacy positional)', () => {
    const reg = buildSessionRegistry([
      { name: 'help', description: 'Custom help', argumentHint: '<x>' },
    ]);
    expect(reg.size()).toBe(BUILT_IN_COMMANDS.length);
    expect(reg.get('help')?.description).toBe('Custom help');
    expect(reg.get('help')?.source).toBe('user');
  });

  it('appends user-only commands not present in built-ins (legacy positional)', () => {
    const reg = buildSessionRegistry(['my-custom']);
    expect(reg.size()).toBe(BUILT_IN_COMMANDS.length + 1);
    expect(reg.get('my-custom')?.source).toBe('user');
  });

  it('layers builtin → skills → user when given the options form', () => {
    const skill: Command = {
      type: 'prompt',
      name: 'stuck',
      description: 'skill version',
      source: 'user',
    };
    const userOverride: Command = {
      type: 'local',
      name: 'stuck',
      description: 'user override',
      source: 'user',
    };
    const reg = buildSessionRegistry({
      skills: [skill],
      user: [userOverride],
    });
    expect(reg.get('stuck')?.description).toBe('user override');
    expect(reg.get('stuck')?.source).toBe('user');
  });

  it('skill overlay overrides built-in on name collision', () => {
    const skillHelp: Command = {
      type: 'prompt',
      name: 'help',
      description: 'skill-help',
      source: 'user',
    };
    const reg = buildSessionRegistry({ skills: [skillHelp] });
    expect(reg.get('help')?.description).toBe('skill-help');
    expect(reg.get('help')?.source).toBe('user');
    // Total size unchanged (skill replaced the builtin).
    expect(reg.size()).toBe(BUILT_IN_COMMANDS.length);
  });
});

describe('createSessionRegistry', () => {
  it('seeds built-ins by default', () => {
    const reg = createSessionRegistry();
    expect(reg.size()).toBe(BUILT_IN_COMMANDS.length);
  });
});

// ---------------------------------------------------------------------------
// Wire-format projections
// ---------------------------------------------------------------------------

describe('toSlashCommand / listUserInvocableSlashCommands', () => {
  it('projects to wire fields name/description/argumentHint', () => {
    const wire = toSlashCommand(local('foo', { argumentHint: '<x>' }));
    expect(wire).toEqual({ name: 'foo', description: 'foo description', argumentHint: '<x>' });
  });

  it('omits argumentHint when absent', () => {
    const wire = toSlashCommand(local('foo'));
    expect(wire).toEqual({ name: 'foo', description: 'foo description' });
  });

  it('listUserInvocableSlashCommands respects filters', () => {
    const reg = new CommandRegistry([
      local('a'),
      local('hidden', { isHidden: true }),
      local('disabled', { isEnabled: () => false }),
      local('model-only', { userInvocable: false }),
    ]);
    const out = listUserInvocableSlashCommands(reg);
    expect(out.map((c) => c.name)).toEqual(['a']);
  });
});

describe('getCommandName', () => {
  it('returns the canonical name', () => {
    expect(getCommandName(local('foo'))).toBe('foo');
  });
});
