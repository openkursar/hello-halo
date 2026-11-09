/**
 * Unit tests for dispatchSlashCommand.
 *
 * Uses a hand-built CommandRegistry seeded with stub local + prompt commands.
 * No SDK session is created — the dispatcher is exercised against fake
 * SlashCommandContext getters/setters.
 */

import { describe, it, expect, vi } from 'vitest';

import { CommandRegistry } from '../registry.js';
import { dispatchSlashCommand } from './executor.js';
import type {
  Command,
  SlashCommandContext,
  SlashCommandResult,
} from '../types.js';
import type { Message } from '../../types/provider.js';

function makeCtx(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    sessionId: 'session-1',
    cwd: '/tmp/x',
    model: 'claude-sonnet-4-6',
    setModel: vi.fn(),
    mcpServerStatuses: [],
    messages: [],
    clearMessages: vi.fn(),
    compactSession: vi.fn(async () => {}),
    ...overrides,
  };
}

const localStub = (name: string, result: SlashCommandResult): Command => ({
  type: 'local',
  name,
  description: `${name} desc`,
  source: 'builtin',
  call: vi.fn(async () => result),
});

const promptStub = (name: string, messages: Message[]): Command => ({
  type: 'prompt',
  name,
  description: `${name} desc`,
  source: 'builtin',
  getPromptForCommand: vi.fn(async () => messages),
});

describe('dispatchSlashCommand', () => {
  it('returns unknown for unregistered names', async () => {
    const reg = new CommandRegistry([localStub('clear', { kind: 'system', markdown: 'cleared' })]);
    const out = await dispatchSlashCommand(reg, 'nope', '', makeCtx());
    expect(out.kind).toBe('unknown');
  });

  it('runs local executor and returns local-result', async () => {
    const stub = localStub('clear', { kind: 'system', markdown: 'cleared' });
    const reg = new CommandRegistry([stub]);
    const ctx = makeCtx();
    const out = await dispatchSlashCommand(reg, 'clear', '', ctx);
    expect(out.kind).toBe('local-result');
    if (out.kind !== 'local-result') return;
    expect(out.result).toEqual({ kind: 'system', markdown: 'cleared' });
    expect(stub.type === 'local' && stub.call).toHaveBeenCalledWith('', ctx);
  });

  it('runs prompt executor and returns prompt-replacement', async () => {
    const replacement: Message[] = [
      { role: 'user', content: 'Initialize the repository.' },
    ];
    const stub = promptStub('init', replacement);
    const reg = new CommandRegistry([stub]);
    const ctx = makeCtx();
    const out = await dispatchSlashCommand(reg, 'init', 'foo', ctx);
    expect(out.kind).toBe('prompt-replacement');
    if (out.kind !== 'prompt-replacement') return;
    expect(out.messages).toEqual(replacement);
    expect(stub.type === 'prompt' && stub.getPromptForCommand).toHaveBeenCalledWith('foo', ctx);
  });

  it('returns host-handled when local command has no call', async () => {
    const cmd: Command = {
      type: 'local',
      name: 'fixture-command',
      description: 'a',
      source: 'builtin',
    };
    const reg = new CommandRegistry([cmd]);
    const out = await dispatchSlashCommand(reg, 'fixture-command', '', makeCtx());
    expect(out.kind).toBe('host-handled');
  });

  it('returns host-handled when prompt command has no expander', async () => {
    const cmd: Command = {
      type: 'prompt',
      name: 'review',
      description: 'r',
      source: 'builtin',
    };
    const reg = new CommandRegistry([cmd]);
    const out = await dispatchSlashCommand(reg, 'review', '', makeCtx());
    expect(out.kind).toBe('host-handled');
  });

  it('returns disabled when userInvocable=false / isEnabled=false', async () => {
    const reg = new CommandRegistry([
      { ...localStub('model-only', { kind: 'system', markdown: '' }), userInvocable: false },
      { ...localStub('off', { kind: 'system', markdown: '' }), isEnabled: () => false },
    ]);

    expect((await dispatchSlashCommand(reg, 'model-only', '', makeCtx())).kind).toBe('disabled');
    expect((await dispatchSlashCommand(reg, 'off', '', makeCtx())).kind).toBe('disabled');
  });

  it('isHidden commands are still dispatchable (hidden from autocomplete only)', async () => {
    const reg = new CommandRegistry([
      { ...localStub('hide', { kind: 'system', markdown: 'hidden but works' }), isHidden: true },
    ]);
    const out = await dispatchSlashCommand(reg, 'hide', '', makeCtx());
    expect(out.kind).toBe('local-result');
  });

  it('resolves aliases to the canonical command', async () => {
    const stub = localStub('clear', { kind: 'system', markdown: 'ok' });
    stub.aliases = ['reset'];
    const reg = new CommandRegistry([stub]);
    const out = await dispatchSlashCommand(reg, 'reset', '', makeCtx());
    expect(out.kind).toBe('local-result');
    if (out.kind !== 'local-result') return;
    expect(out.command.name).toBe('clear');
  });
});
