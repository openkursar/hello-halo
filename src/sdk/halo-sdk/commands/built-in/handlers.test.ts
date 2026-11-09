/**
 * Unit tests for built-in slash command executors.
 *
 * Coverage targets the user-visible contract of each handler:
 *   - Local commands (`call`)         : return shape, side-effects on ctx,
 *                                       markdown body sanity, args handling.
 *   - Prompt commands (`getPromptForCommand`): return Message[] with a single
 *                                              user role and a non-empty body.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Message } from '../../types/provider.js';
import type {
  Command,
  SessionCostSnapshot,
  SlashCommandContext,
} from '../types.js';

import clear from './clear.js';
import compact from './compact.js';
import context from './context.js';
import cost from './cost.js';
import help from './help.js';
import init from './init.js';
import mcp from './mcp.js';
import model from './model.js';
import status from './status.js';
import usage from './usage.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface MockCtx extends SlashCommandContext {
  /** Spy: number of times clearMessages was called. */
  _clearCalls: number;
  /** Spy: most recent setModel arg, or undefined. */
  _lastSetModel: string | undefined;
  /** Spy: most recent compactSession arg. */
  _compactCalledWith: string | undefined | null; // null = not called
}

function emptySnapshot(): SessionCostSnapshot {
  return {
    totalCostUsd: 0,
    totalDurationMs: 0,
    totalApiDurationMs: 0,
    numTurns: 0,
    tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
  };
}

interface MakeCtxOverrides extends Partial<SlashCommandContext> {
  costSnapshot?: SessionCostSnapshot;
}

function makeCtx(overrides: MakeCtxOverrides = {}): MockCtx {
  let model = overrides.model ?? 'claude-sonnet-4-6';
  const snapshot = overrides.costSnapshot ?? emptySnapshot();
  const ctx = {
    sessionId: 's-1',
    cwd: '/tmp/proj',
    get model() {
      return model;
    },
    setModel(next: string) {
      model = next;
      ctx._lastSetModel = next;
    },
    mcpServerStatuses: [] as ReadonlyArray<{ name: string; status: string }>,
    messages: [] as readonly Message[],
    clearMessages() {
      ctx._clearCalls += 1;
    },
    async compactSession(instructions?: string) {
      ctx._compactCalledWith = instructions ?? undefined;
    },
    getCostSnapshot(): SessionCostSnapshot {
      return snapshot;
    },
    commands: [] as ReadonlyArray<Command>,
    _clearCalls: 0,
    _lastSetModel: undefined as string | undefined,
    _compactCalledWith: null as string | undefined | null,
    ...overrides,
  } as unknown as MockCtx;
  return ctx;
}

function asLocal(cmd: Command): Extract<Command, { type: 'local' }> {
  if (cmd.type !== 'local') throw new Error(`expected local, got ${cmd.type}`);
  return cmd;
}

function asPrompt(cmd: Command): Extract<Command, { type: 'prompt' }> {
  if (cmd.type !== 'prompt') throw new Error(`expected prompt, got ${cmd.type}`);
  return cmd;
}

// ---------------------------------------------------------------------------
// Local handlers
// ---------------------------------------------------------------------------

describe('/clear', () => {
  it('invokes ctx.clearMessages and returns a system result', async () => {
    const c = asLocal(clear);
    const ctx = makeCtx();
    const result = await c.call!('', ctx);
    expect(ctx._clearCalls).toBe(1);
    expect(result.kind).toBe('system');
    expect(result.markdown).toMatch(/cleared/i);
  });

  it('declares its aliases', () => {
    expect(clear.aliases).toEqual(['reset', 'new']);
  });

  it('waits for the owner to commit replacement history before confirming', async () => {
    const ctx = makeCtx();
    let finish!: () => void;
    ctx.clearMessages = () => new Promise<void>(resolve => { finish = resolve; });
    let settled = false;
    const clearing = Promise.resolve(asLocal(clear).call!('', ctx)).then(result => { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    expect((await clearing).markdown).toMatch(/cleared/i);
  });
});

describe('/compact', () => {
  it('triggers ctx.compactSession with no instructions when args empty', async () => {
    const c = asLocal(compact);
    const ctx = makeCtx();
    const result = await c.call!('', ctx);
    expect(ctx._compactCalledWith).toBeUndefined();
    expect(result.markdown).toMatch(/compaction started/i);
  });

  it('forwards trimmed instructions to compactSession', async () => {
    const c = asLocal(compact);
    const ctx = makeCtx();
    const result = await c.call!('  focus on the auth refactor  ', ctx);
    expect(ctx._compactCalledWith).toBe('focus on the auth refactor');
    expect(result.markdown).toContain('focus on the auth refactor');
  });
});

describe('/context', () => {
  it('reports model, message count, and an approx-tokens estimate', async () => {
    const c = asLocal(context);
    const messages: Message[] = [
      { role: 'user', content: 'hello world' }, // 11 chars
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] }, // 8 chars
    ];
    const ctx = makeCtx({ model: 'claude-opus-4-6', messages });
    const result = await c.call!('', ctx);
    expect(result.kind).toBe('system');
    expect(result.markdown).toContain('claude-opus-4-6');
    expect(result.markdown).toContain('**Messages:** 2');
    // 19 chars / 4 ≈ 5
    expect(result.markdown).toMatch(/Approx\. tokens.*5/);
  });

  it('handles an empty message history', async () => {
    const c = asLocal(context);
    const ctx = makeCtx();
    const result = await c.call!('', ctx);
    expect(result.markdown).toContain('**Messages:** 0');
  });
});

describe('/cost', () => {
  it('renders totals from the snapshot', async () => {
    const c = asLocal(cost);
    const ctx = makeCtx({
      costSnapshot: {
        totalCostUsd: 0.0125,
        totalDurationMs: 12_500,
        totalApiDurationMs: 8_400,
        numTurns: 3,
        tokens: { input: 1_500, output: 400, cacheCreate: 200, cacheRead: 1_000 },
      },
    });
    const result = await c.call!('', ctx);
    expect(result.kind).toBe('system');
    expect(result.markdown).toContain('$0.0125');
    expect(result.markdown).toContain('**Turns counted:** 3');
    expect(result.markdown).toContain('| Input | 1,500 |');
    expect(result.markdown).toContain('| Cache read | 1,000 |');
    expect(result.markdown).not.toMatch(/in-flight/i);
  });

  it('flags the in-flight caveat when numTurns is zero', async () => {
    const c = asLocal(cost);
    const result = await c.call!('', makeCtx());
    expect(result.markdown).toMatch(/in-flight turn is not yet aggregated/i);
  });
});

describe('/usage', () => {
  it('renders cumulative token usage from the snapshot', async () => {
    const c = asLocal(usage);
    const ctx = makeCtx({
      costSnapshot: {
        totalCostUsd: 0,
        totalDurationMs: 0,
        totalApiDurationMs: 0,
        numTurns: 2,
        tokens: { input: 100, output: 50, cacheCreate: 10, cacheRead: 25 },
      },
    });
    const result = await c.call!('', ctx);
    expect(result.markdown).toContain('**Turns:** 2');
    // 100 + 50 + 10 + 25 = 185
    expect(result.markdown).toContain('**Total tokens:** 185');
    expect(result.markdown).toContain('| Output | 50 |');
  });
});

describe('/model', () => {
  it('reports the active model when no args supplied', async () => {
    const c = asLocal(model);
    const ctx = makeCtx({ model: 'claude-sonnet-4-6' });
    const result = await c.call!('', ctx);
    expect(result.markdown).toContain('claude-sonnet-4-6');
    expect(ctx._lastSetModel).toBeUndefined();
  });

  it('switches the model when an arg is supplied', async () => {
    const c = asLocal(model);
    const ctx = makeCtx({ model: 'claude-haiku-4-5' });
    const result = await c.call!('claude-opus-4-6', ctx);
    expect(ctx._lastSetModel).toBe('claude-opus-4-6');
    expect(result.markdown).toContain('claude-haiku-4-5');
    expect(result.markdown).toContain('claude-opus-4-6');
  });

  it('trims whitespace around the target model', async () => {
    const c = asLocal(model);
    const ctx = makeCtx();
    await c.call!('   claude-opus-4-6  ', ctx);
    expect(ctx._lastSetModel).toBe('claude-opus-4-6');
  });
});

describe('/mcp', () => {
  it('returns a friendly message when no servers are configured', async () => {
    const c = asLocal(mcp);
    const result = await c.call!('', makeCtx());
    expect(result.markdown).toMatch(/no mcp servers/i);
  });

  it('renders a markdown table when servers are present', async () => {
    const c = asLocal(mcp);
    const ctx = makeCtx({
      mcpServerStatuses: [
        { name: 'fs', status: 'connected' },
        { name: 'github', status: 'failed' },
      ],
    });
    const result = await c.call!('', ctx);
    expect(result.markdown).toContain('| fs | connected |');
    expect(result.markdown).toContain('| github | failed |');
  });
});

describe('/status', () => {
  it('reports session, model, cwd, message count', async () => {
    const c = asLocal(status);
    const ctx = makeCtx({
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'x' }],
    });
    const result = await c.call!('', ctx);
    expect(result.markdown).toContain('s-1');
    expect(result.markdown).toContain('claude-opus-4-6');
    expect(result.markdown).toContain('/tmp/proj');
    expect(result.markdown).toContain('**Messages in history:** 1');
  });

  it('includes MCP status section', async () => {
    const c = asLocal(status);
    const ctx = makeCtx({
      mcpServerStatuses: [{ name: 'fs', status: 'connected' }],
    });
    const result = await c.call!('', ctx);
    expect(result.markdown).toContain('### MCP servers');
    expect(result.markdown).toContain('| fs | connected |');
  });
});

describe('/help', () => {
  it('lists commands from ctx.commands verbatim', async () => {
    const c = asLocal(help);
    const ctx = makeCtx({
      commands: [
        clear,
        model,
        // Includes a user-supplied custom command to confirm overlays surface.
        {
          type: 'local',
          name: 'mycmd',
          description: 'A user override',
          source: 'user',
        },
      ],
    });
    const result = await c.call!('', ctx);
    expect(result.markdown).toContain('/clear');
    expect(result.markdown).toContain('/model');
    expect(result.markdown).toContain('/mycmd');
    expect(result.markdown).toContain('A user override');
  });

  it('reports an empty registry gracefully', async () => {
    const c = asLocal(help);
    const result = await c.call!('', makeCtx());
    expect(result.markdown).toMatch(/no commands registered/i);
  });

  it('renders argumentHint when present', async () => {
    const c = asLocal(help);
    const ctx = makeCtx({ commands: [model] }); // model has argumentHint '[model]'
    const result = await c.call!('', ctx);
    expect(result.markdown).toContain('/model [model]');
  });
});

// ---------------------------------------------------------------------------
// Prompt handlers — light shape checks
// ---------------------------------------------------------------------------

describe('prompt commands', () => {
  it('/init returns a single user Message with non-empty content', async () => {
    const p = asPrompt(init);
    const messages = await p.getPromptForCommand!('', makeCtx());
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    const body = typeof messages[0].content === 'string'
      ? messages[0].content
      : messages[0].content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(body.length).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------
// Suppress accidental use of vi spies — placeholder hook.
// ---------------------------------------------------------------------------

void vi;
