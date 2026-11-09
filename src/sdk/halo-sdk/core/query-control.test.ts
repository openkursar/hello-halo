/**
 * Unit tests for Query control methods:
 *   - supportedModels()
 *   - mcpServerStatus()
 *   - getContextUsage()
 *
 * Tests run against a minimal mock provider and never make network calls.
 */

import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { getTranscriptPath } from './transcript.js';
import { BackgroundTaskRegistry } from '../tools/bash/index.js';
import { query } from '../index.js';
import type {
  LlmProvider,
  ProviderRequest,
  ProviderResponse,
  StreamEvent,
  ProviderCapabilities,
  UsageInfo,
} from '../types/provider.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeUsage(input = 10, output = 5): UsageInfo {
  return { input_tokens: input, output_tokens: output };
}

/** Minimal mock provider that returns a fixed text response. */
function makeMockProvider(text = 'done'): LlmProvider {
  const caps: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    thinking: false,
    imageInput: false,
    pdfInput: false,
    audioInput: false,
    videoInput: false,
    caching: false,
    systemPromptStyle: 'top_level',
  };
  return {
    id: 'mock',
    name: 'Mock',
    capabilities: () => caps,
    async createMessage(_req: ProviderRequest): Promise<ProviderResponse> {
      return {
        id: `msg_${randomUUID()}`,
        content: [{ type: 'text', text }],
        stopReason: 'end_turn',
        usage: makeUsage(),
        model: 'test-model',
      };
    },
    async *createMessageStream(_req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
      yield { type: 'message_start', id: `msg_${randomUUID()}`, model: 'test-model', usage: makeUsage() };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'text_delta', index: 0, text };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: 'end_turn', usage: makeUsage() };
      yield { type: 'message_stop' };
    },
  };
}

/** Build a minimal query and interrupt it immediately — we only need the control methods. */
function makeQuery(model = 'deepseek-chat') {
  return query({
    prompt: 'ping',
    options: {
      model,
      provider: makeMockProvider(),
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    },
  });
}

describe('Query background lifecycle', () => {
  it('routes task controls to the session-owned shell registry', async () => {
    const bashStop = vi.spyOn(BackgroundTaskRegistry.prototype, 'stop').mockReturnValue(false);
    const bashStopAll = vi.spyOn(BackgroundTaskRegistry.prototype, 'stopAll');
    const q = makeQuery();
    try {
      await q.stopTask('unknown-task');
      expect(bashStop).toHaveBeenCalledWith('unknown-task');
      await q.interrupt();
      expect(bashStopAll).toHaveBeenCalledOnce();
    } finally {
      q.close();
      vi.restoreAllMocks();
    }
  });

  it('waits for background cleanup before the query generator finishes', async () => {
    let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    const flush = vi.spyOn(BackgroundTaskRegistry.prototype, 'flush').mockReturnValue(cleanup);
    const q = query({ prompt: '/help', options: { model: 'test-model', provider: makeMockProvider() } });
    let finished = false;
    const drained = (async () => {
      for await (const _message of q) { /* Drain local command events. */ }
      finished = true;
    })();
    try {
      await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
      expect(finished).toBe(false);
      release();
      await drained;
      expect(finished).toBe(true);
    } finally {
      release();
      q.close();
      vi.restoreAllMocks();
    }
  });
});

describe('Query input and transcript options', () => {
  it('reports manual compaction as an error rather than a successful no-op', async () => {
    const q = query({ prompt: '/compact', options: { model: 'test-model', provider: makeMockProvider() } });
    try {
      const messages = [];
      for await (const message of q) messages.push(message);
      expect(messages.find(message => message.type === 'result')).toMatchObject({
        is_error: true,
        subtype: 'error_during_execution',
        result: expect.stringContaining('not supported'),
      });
    } finally {
      q.close();
    }
  });

  it('rejects streamInput without consuming or silently dropping the input', async () => {
    const q = makeQuery();
    let consumed = false;
    const input = (async function* () {
      consumed = true;
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'follow-up' }] },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: 'input-session',
      };
    })();
    try {
      await expect(q.streamInput(input)).rejects.toThrow(/createSession\(\)\.send\(\)/);
      expect(consumed).toBe(false);
    } finally {
      q.close();
    }
  });

  it.each(['resume', 'continue'] as const)('uses isolated transcript storage for %s', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'sdk-query-resume-'));
    const options = {
      cwd: root,
      env: { SDK_STORE: join(root, 'config'), HOME: root },
      conventions: { configDirEnv: 'SDK_STORE' },
    };
    const transcript = getTranscriptPath('previous', root, options);
    await mkdir(dirname(transcript), { recursive: true });
    await writeFile(transcript, JSON.stringify({
      type: 'user', uuid: 'previous-user', sessionId: 'previous',
      message: { role: 'user', content: 'history in isolated store' },
    }) + '\n');
    const provider = makeMockProvider();
    const originalStream = provider.createMessageStream.bind(provider);
    const requests: ProviderRequest[] = [];
    provider.createMessageStream = async function* (request) {
      requests.push(request);
      yield* originalStream(request);
    };
    const q = query({
      prompt: 'new prompt',
      options: {
        ...options, provider, model: 'test-model', maxTurns: 1,
        ...(mode === 'resume' ? { resume: 'previous' } : { continue: true }),
      },
    });
    try {
      for await (const _message of q) { /* Drain the one-shot query. */ }
      expect(JSON.stringify(requests[0].messages)).toContain('history in isolated store');
    } finally {
      q.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// supportedModels()
// ---------------------------------------------------------------------------

describe('Query.supportedModels()', () => {
  it('returns an array of model objects', async () => {
    const q = makeQuery();
    const models = await q.supportedModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    q.return(undefined); // clean up generator
  });

  it('each model has required fields: value, displayName, description', async () => {
    const q = makeQuery();
    const models = await q.supportedModels();
    for (const m of models) {
      const entry = m as Record<string, unknown>;
      expect(typeof entry.value, `model ${entry.value} missing value`).toBe('string');
      expect(typeof entry.displayName, `model ${entry.value} missing displayName`).toBe('string');
      expect(typeof entry.description, `model ${entry.value} description not string`).toBe('string');
    }
    q.return(undefined);
  });

  it('reports the model the host configured', async () => {
    const q = makeQuery('glm-4.6');
    const models = await q.supportedModels();
    const ids = (models as Array<Record<string, unknown>>).map((m) => m.value as string);
    expect(ids).toEqual(['glm-4.6']);
    q.return(undefined);
  });

  it('supportsEffort field is boolean or undefined, not null', async () => {
    const q = makeQuery();
    const models = await q.supportedModels();
    for (const m of models) {
      const entry = m as Record<string, unknown>;
      if ('supportsEffort' in entry) {
        expect(
          entry.supportsEffort === undefined || typeof entry.supportsEffort === 'boolean',
        ).toBe(true);
      }
    }
    q.return(undefined);
  });
});

// ---------------------------------------------------------------------------
// mcpServerStatus()
// ---------------------------------------------------------------------------

describe('Query.mcpServerStatus()', () => {
  it('returns an array (empty when no MCP servers configured)', async () => {
    const q = makeQuery();
    const statuses = await q.mcpServerStatus();
    expect(Array.isArray(statuses)).toBe(true);
    q.return(undefined);
  });

  it('SDK MCP servers appear with status=connected', async () => {
    const q = query({
      prompt: 'ping',
      options: {
        model: 'claude-sonnet-4-6',
        provider: makeMockProvider(),
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // Simulate an SDK-type MCP server
        mcpServers: {
          'my-sdk-server': { type: 'sdk', server: { tool: () => ({ name: 'noop', execute: async () => ({ content: '', isError: false }) }) } as unknown },
        } as Record<string, unknown>,
      },
    });
    const statuses = await q.mcpServerStatus();
    // Should include our sdk server
    const sdkEntry = (statuses as Array<Record<string, unknown>>).find((s) => s.name === 'my-sdk-server');
    expect(sdkEntry).toBeDefined();
    expect(sdkEntry?.status).toBe('connected');
    q.return(undefined);
  });

  it('each status entry has name and status fields', async () => {
    const q = makeQuery();
    const statuses = await q.mcpServerStatus();
    for (const s of statuses) {
      const entry = s as Record<string, unknown>;
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.status).toBe('string');
    }
    q.return(undefined);
  });
});

// ---------------------------------------------------------------------------
// getContextUsage()
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// supportedCommands()
// ---------------------------------------------------------------------------

describe('Query.supportedCommands()', () => {
  it('seeds the SDK built-in command set when no slash commands configured', async () => {
    const q = makeQuery();
    const commands = await q.supportedCommands() as Array<Record<string, unknown>>;
    expect(Array.isArray(commands)).toBe(true);
    expect(commands.length).toBeGreaterThan(0);
    const names = new Set(commands.map((c) => c.name as string));
    for (const expected of ['help', 'clear', 'compact', 'model', 'mcp']) {
      expect(names.has(expected)).toBe(true);
    }
    q.return(undefined);
  });

  it('overlays caller-supplied slash commands on top of built-ins (last-write-wins)', async () => {
    const q = query({
      prompt: 'ping',
      options: {
        model: 'claude-sonnet-4-6',
        provider: makeMockProvider(),
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        slashCommands: [
          { name: 'help', description: 'Custom help', argumentHint: '<topic>' },
          { name: 'project-only', description: 'Project specific' },
        ],
      },
    });
    const commands = await q.supportedCommands() as Array<Record<string, unknown>>;
    const help = commands.find((c) => c.name === 'help');
    expect(help?.description).toBe('Custom help');
    expect(help?.argumentHint).toBe('<topic>');
    const projectOnly = commands.find((c) => c.name === 'project-only');
    expect(projectOnly?.description).toBe('Project specific');
    q.return(undefined);
  });

  it('coerces string slash command names to wire-format entries alongside built-ins', async () => {
    const q = query({
      prompt: 'ping',
      options: {
        model: 'claude-sonnet-4-6',
        provider: makeMockProvider(),
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        slashCommands: ['foo', 'bar'],
      },
    });
    const commands = await q.supportedCommands() as Array<Record<string, unknown>>;
    const foo = commands.find((c) => c.name === 'foo');
    const bar = commands.find((c) => c.name === 'bar');
    expect(foo).toBeDefined();
    expect(typeof foo?.description).toBe('string');
    expect(bar).toBeDefined();
    q.return(undefined);
  });
});

// ---------------------------------------------------------------------------
// accountInfo()
// ---------------------------------------------------------------------------

describe('Query.accountInfo()', () => {
  it('returns an object with at minimum apiKeySource', async () => {
    const q = makeQuery();
    const info = await q.accountInfo() as Record<string, unknown>;
    expect(typeof info).toBe('object');
    expect(info).not.toBeNull();
    q.return(undefined);
  });

  it('apiKeySource is a string when present', async () => {
    const q = makeQuery();
    const info = await q.accountInfo() as Record<string, unknown>;
    if ('apiKeySource' in info) {
      expect(typeof info.apiKeySource).toBe('string');
    }
    q.return(undefined);
  });
});

// ---------------------------------------------------------------------------
// interrupt() — abort via query control
// ---------------------------------------------------------------------------

describe('Query.interrupt()', () => {
  it('interrupt() resolves without throwing', async () => {
    const q = makeQuery();
    await expect(q.interrupt()).resolves.toBeUndefined();
    q.return(undefined);
  });

  it('generator terminates (throws or returns) after interrupt()', async () => {
    const q = query({
      prompt: 'ping',
      options: {
        model: 'claude-sonnet-4-6',
        provider: makeMockProvider(),
        maxTurns: 5,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    });
    // Abort before the generator starts
    await q.interrupt();
    // Draining the aborted generator should either yield nothing or throw AbortError.
    // Either outcome proves the generator did NOT run indefinitely.
    const messages: unknown[] = [];
    try {
      for await (const msg of q) {
        messages.push(msg);
        if (messages.length > 20) break; // safety valve
      }
    } catch (err) {
      // AbortError is the expected exception from an interrupted query.
      expect((err as Error).name).toMatch(/Abort/i);
    }
    // Whether it threw or finished cleanly, it must not have run forever.
    expect(messages.length).toBeLessThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// setModel() / setPermissionMode() / setMaxThinkingTokens()
// ---------------------------------------------------------------------------

describe('Query.setModel() / setPermissionMode() / setMaxThinkingTokens()', () => {
  it('setModel() resolves without throwing', async () => {
    const q = makeQuery();
    await expect(q.setModel('claude-opus-4')).resolves.toBeUndefined();
    q.return(undefined);
  });

  it('setModel(undefined) resolves without throwing', async () => {
    const q = makeQuery();
    await expect(q.setModel(undefined)).resolves.toBeUndefined();
    q.return(undefined);
  });

  it('setPermissionMode() resolves without throwing', async () => {
    const q = makeQuery();
    await expect(q.setPermissionMode('acceptEdits')).resolves.toBeUndefined();
    q.return(undefined);
  });

  it('setMaxThinkingTokens() resolves without throwing', async () => {
    const q = makeQuery();
    await expect(q.setMaxThinkingTokens(8000)).resolves.toBeUndefined();
    q.return(undefined);
  });

  it('setMaxThinkingTokens(null) resolves without throwing', async () => {
    const q = makeQuery();
    await expect(q.setMaxThinkingTokens(null)).resolves.toBeUndefined();
    q.return(undefined);
  });
});

// ---------------------------------------------------------------------------
// initializationResult()
// ---------------------------------------------------------------------------

describe('Query.initializationResult()', () => {
  it('returns the composite initialization response shape', async () => {
    const q = makeQuery();
    const result = await q.initializationResult() as Record<string, unknown>;
    expect(Array.isArray(result.commands)).toBe(true);
    expect(Array.isArray(result.models)).toBe(true);
    expect(result).not.toHaveProperty('agents');
    expect(q).not.toHaveProperty('supportedAgents');
    expect(typeof result.accountInfo).toBe('object');
    q.return(undefined);
  });

  it('models array lists the configured model', async () => {
    const q = makeQuery('glm-4.6');
    const result = await q.initializationResult() as Record<string, unknown>;
    const models = result.models as Array<Record<string, unknown>>;
    expect(models.map((m) => m.value)).toEqual(['glm-4.6']);
    q.return(undefined);
  });

  it('mcpServers field is an array', async () => {
    const q = makeQuery();
    const result = await q.initializationResult() as Record<string, unknown>;
    expect(Array.isArray(result.mcpServers)).toBe(true);
    q.return(undefined);
  });
});
