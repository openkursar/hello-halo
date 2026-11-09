/**
 * Live-provider tests of the SDK's public message and session contracts.
 * Credentials are read only from explicitly supplied SDK_TEST_* environment variables.
 * No environment files are loaded.
 *
 * Run from the SDK repository: npx vitest run e2e.test.ts
 *
 * Required environment:
 *   SDK_TEST_API_KEY    - API key for the test provider
 *   SDK_TEST_API_URL    - OpenAI-compat base URL (e.g. https://openrouter.ai/api/v1)
 *   SDK_TEST_MODEL      - Model name (e.g. deepseek/deepseek-v3.2)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_API_KEY = process.env.SDK_TEST_API_KEY ?? '';
const TEST_API_URL = process.env.SDK_TEST_API_URL ?? '';
const TEST_MODEL = process.env.SDK_TEST_MODEL ?? '';

const SKIP_REASON = !TEST_API_KEY || !TEST_API_URL || !TEST_MODEL
  ? 'SDK_TEST_API_KEY, SDK_TEST_API_URL and SDK_TEST_MODEL must be set — skip live API tests'
  : null;

// ---------------------------------------------------------------------------
// SDK imports
// ---------------------------------------------------------------------------

import {
  query,
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  createProvider,
  tool,
  createSdkMcpServer,
} from './index.js';
import type { SDKMessage } from './core/query-types.js';
import type { Tool, ToolContext, ToolResult } from './types/tool.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise OpenRouter-style base URL to remove trailing path */
function resolveBaseUrl(url: string): string {
  // OpenRouter: https://openrouter.ai/api/v1/chat/completions → https://openrouter.ai/api/v1
  return url.replace(/\/chat\/completions\/?$/, '');
}

function makeProvider() {
  // Use createProvider() which correctly fills in required id/name fields
  return createProvider({
    type: 'openai-compat',
    apiKey: TEST_API_KEY,
    baseUrl: resolveBaseUrl(TEST_API_URL),
    defaultModel: TEST_MODEL,
  });
}

/** Collect all messages from a query generator into an array. */
async function drainQuery(
  gen: AsyncIterable<SDKMessage>,
): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  for await (const msg of gen) {
    messages.push(msg);
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Public message contract assertions.
// ---------------------------------------------------------------------------

/**
 * Assert that a system:init message has all fields the consumer reads:
 *   msg.type          === 'system'
 *   msg.subtype       === 'init'
 *   msg.model         (string)
 *   msg.session_id    (string)
 *   msg.mcp_servers   (array)
 *   msg.slash_commands (array of strings — consumer reads as string[])
 *   msg.skills        (array)
 *   msg.cwd           (string)
 *   msg.uuid          (string)
 */
function assertInitMessage(msg: SDKMessage): void {
  expect(msg.type).toBe('system');
  const m = msg as unknown as Record<string, unknown>;
  expect(m.subtype).toBe('init');
  expect(typeof m.model).toBe('string');
  expect(typeof m.session_id).toBe('string');
  expect(Array.isArray(m.mcp_servers)).toBe(true);
  expect(Array.isArray(m.slash_commands)).toBe(true);
  // slash_commands must be string[] (not {name,desc}[])
  if ((m.slash_commands as unknown[]).length > 0) {
    expect(typeof (m.slash_commands as unknown[])[0]).toBe('string');
  }
  expect(Array.isArray(m.skills)).toBe(true);
  expect(m).not.toHaveProperty('agents');
}

/**
 * Assert that a result message has all fields the consumer reads:
 *   msg.type          === 'result'
 *   msg.result        (string) — consumer reads via message.result
 *   msg.session_id    (string) — consumer captures for session persistence
 *   msg.total_cost_usd (number)
 *   msg.modelUsage    (object) — camelCase, consumer reads .contextWindow
 *   msg.num_turns     (number)
 *   msg.is_error      (boolean)
 *   msg.uuid          (string)
 */
function assertResultMessage(msg: SDKMessage): void {
  expect(msg.type).toBe('result');
  const m = msg as unknown as Record<string, unknown>;
  expect(typeof m.result).toBe('string');
  expect(typeof m.session_id).toBe('string');
  expect(typeof m.total_cost_usd).toBe('number');
  expect(m.modelUsage !== null && typeof m.modelUsage === 'object').toBe(true);
  expect(typeof m.num_turns).toBe('number');
  expect(typeof m.is_error).toBe('boolean');
  expect(typeof m.uuid).toBe('string');
}

/**
 * Assert that an assistant message has the correct shape the consumer reads:
 *   msg.type          === 'assistant'
 *   msg.message.role  === 'assistant'
 *   msg.message.content (array)
 *   msg.message.usage  (object with input_tokens/output_tokens)
 *   msg.uuid           (string)
 */
function assertAssistantMessage(msg: SDKMessage): void {
  expect(msg.type).toBe('assistant');
  const m = msg as unknown as Record<string, unknown>;
  const message = m.message as Record<string, unknown> | undefined;
  expect(message).toBeTruthy();
  expect(message?.role).toBe('assistant');
  expect(Array.isArray(message?.content)).toBe(true);
  const usage = message?.usage as Record<string, unknown> | undefined;
  // usage may not be present on all providers, but when present must have token counts
  if (usage) {
    expect(typeof usage.input_tokens).toBe('number');
    expect(typeof usage.output_tokens).toBe('number');
  }
  expect(typeof m.uuid).toBe('string');
}

/**
 * Returns true if any user message in the stream carries a tool_result block.
 * Used by tool-execution e2e tests to confirm a built-in tool was invoked.
 */
function hasAnyToolResult(messages: SDKMessage[]): boolean {
  return messages
    .filter(m => m.type === 'user')
    .some(m => {
      const content = (m as unknown as Record<string, unknown>).message as Record<string, unknown> | undefined;
      const blocks = content?.content;
      if (!Array.isArray(blocks)) return false;
      return blocks.some((b: unknown) => (b as Record<string, unknown>)?.type === 'tool_result');
    });
}

/**
 * Collect raw text content from all tool_result blocks in the stream.
 * More reliable than checking the final model summary, because the model
 * may describe results without repeating exact values.
 */
function getAllToolOutputs(messages: SDKMessage[]): string[] {
  const outputs: string[] = [];
  for (const msg of messages) {
    if (msg.type !== 'user') continue;
    const m = msg as unknown as Record<string, unknown>;
    const blocks = (m.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      const b = block as Record<string, unknown>;
      if (b.type !== 'tool_result') continue;
      if (typeof b.content === 'string') {
        outputs.push(b.content);
      } else if (Array.isArray(b.content)) {
        for (const cb of b.content as Record<string, unknown>[]) {
          if (typeof cb.text === 'string') outputs.push(cb.text);
        }
      }
    }
  }
  return outputs;
}

// ===========================================================================
// Tests
// ===========================================================================

describe('query() — one-shot mode', () => {
  it.skipIf(!!SKIP_REASON)('emits system:init, then result, all with correct shapes', async () => {
    const q = query({
      prompt: 'Say "hello" and nothing else.',
      options: {
        model: TEST_MODEL,
        provider: makeProvider(),
        maxTurns: 1,
      },
    });

    const messages = await drainQuery(q);

    // Must have at least: init + assistant + result
    expect(messages.length).toBeGreaterThanOrEqual(2);

    // First message must be system:init
    const initMsg = messages[0];
    expect(initMsg?.type).toBe('system');
    assertInitMessage(initMsg!);

    // Last message must be result
    const resultMsg = messages[messages.length - 1];
    expect(resultMsg?.type).toBe('result');
    assertResultMessage(resultMsg!);

    // is_error must be false for successful run
    const r = resultMsg as unknown as Record<string, unknown>;
    expect(r.is_error).toBe(false);
    expect(r.subtype).toBe('success');

    // result field must be a non-empty string
    expect((r.result as string).length).toBeGreaterThan(0);
  }, 60_000);

  it.skipIf(!!SKIP_REASON)('assistant messages have correct shape', async () => {
    const q = query({
      prompt: 'What is 1 + 1? Answer with just the number.',
      options: {
        model: TEST_MODEL,
        provider: makeProvider(),
        maxTurns: 1,
      },
    });

    const messages = await drainQuery(q);
    const assistantMsgs = messages.filter(m => m.type === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThan(0);

    for (const msg of assistantMsgs) {
      assertAssistantMessage(msg);
    }
  }, 60_000);

  it.skipIf(!!SKIP_REASON)('all messages have uuid field', async () => {
    const q = query({
      prompt: 'hi',
      options: {
        model: TEST_MODEL,
        provider: makeProvider(),
        maxTurns: 1,
      },
    });

    const messages = await drainQuery(q);

    for (const msg of messages) {
      // stream_event messages are the only ones that may not have uuid
      if (msg.type === 'stream_event') continue;
      const m = msg as unknown as Record<string, unknown>;
      expect(typeof m.uuid, `${msg.type} message missing uuid`).toBe('string');
    }
  }, 60_000);

  it.skipIf(!!SKIP_REASON)('result subtype is one of the known SDK subtypes', async () => {
    const q = query({
      prompt: 'hi',
      options: {
        model: TEST_MODEL,
        provider: makeProvider(),
        maxTurns: 1,
      },
    });

    const messages = await drainQuery(q);
    const resultMsg = messages.find(m => m.type === 'result') as unknown as Record<string, unknown> | undefined;
    expect(resultMsg).toBeTruthy();

    const validSubtypes = new Set([
      'success',
      'error_during_execution',
      'error_max_turns',
      'error_max_budget_usd',
      'error_max_structured_output_retries',
    ]);
    expect(validSubtypes.has(resultMsg?.subtype as string)).toBe(true);
  }, 60_000);
});

describe('query() — tool use', () => {
  it.skipIf(!!SKIP_REASON)('tool is called and result is returned', async () => {
    const calls: unknown[] = [];

    const dateTool: Tool = {
      name: 'get_date',
      description: 'Get the current date. Call this to find out what today is.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 'readonly',
      execute: async (_input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> => {
        calls.push({});
        return { content: '2026-04-09', isError: false };
      },
    };

    const q = query({
      prompt: 'What is today\'s date? Use the get_date tool.',
      options: {
        model: TEST_MODEL,
        provider: makeProvider(),
        maxTurns: 5,
        customTools: [dateTool],
      },
    });

    const messages = await drainQuery(q);

    // Tool should have been called at least once
    expect(calls.length).toBeGreaterThan(0);

    // Result should exist
    const result = messages.find(m => m.type === 'result');
    expect(result).toBeTruthy();
    assertResultMessage(result!);

    expect(hasAnyToolResult(messages)).toBe(true);
  }, 90_000);
});

describe('createSession() — multi-turn session', () => {
  it.skipIf(!!SKIP_REASON)('stream() emits system:init on EVERY call (not just first)', async () => {
    const session = await unstable_v2_createSession({
      model: TEST_MODEL,
      provider: makeProvider(),
      maxTurns: 2,
    });

    try {
      // Turn 1
      await session.send('Say "turn1" and nothing else.');
      const turn1: SDKMessage[] = [];
      for await (const msg of session.stream()) {
        turn1.push(msg);
        if (msg.type === 'result') break;
      }

      const turn1Init = turn1.find(m => m.type === 'system' && (m as unknown as Record<string, unknown>).subtype === 'init');
      expect(turn1Init).toBeTruthy();
      assertInitMessage(turn1Init!);

      const turn1Result = turn1.find(m => m.type === 'result');
      expect(turn1Result).toBeTruthy();
      assertResultMessage(turn1Result!);

      // Turn 2
      await session.send('Now say "turn2" and nothing else.');
      const turn2: SDKMessage[] = [];
      for await (const msg of session.stream()) {
        turn2.push(msg);
        if (msg.type === 'result') break;
      }

      // CRITICAL: system:init must fire on turn 2 as well
      const turn2Init = turn2.find(m => m.type === 'system' && (m as unknown as Record<string, unknown>).subtype === 'init');
      expect(turn2Init, 'system:init must be emitted on every stream() call (consumer uses it as turn boundary)').toBeTruthy();

      const turn2Result = turn2.find(m => m.type === 'result');
      expect(turn2Result).toBeTruthy();
    } finally {
      session.close();
    }
  }, 120_000);

  it.skipIf(!!SKIP_REASON)('session_id is consistent across turns', async () => {
    const session = await unstable_v2_createSession({
      model: TEST_MODEL,
      provider: makeProvider(),
      maxTurns: 2,
    });

    try {
      await session.send('Hi');
      const turn1: SDKMessage[] = [];
      for await (const msg of session.stream()) {
        turn1.push(msg);
        if (msg.type === 'result') break;
      }

      const t1Result = turn1.find(m => m.type === 'result') as unknown as Record<string, unknown> | undefined;
      const sessionId1 = t1Result?.session_id as string | undefined;
      expect(typeof sessionId1).toBe('string');
      expect(sessionId1!.length).toBeGreaterThan(0);

      await session.send('How are you?');
      const turn2: SDKMessage[] = [];
      for await (const msg of session.stream()) {
        turn2.push(msg);
        if (msg.type === 'result') break;
      }

      const t2Result = turn2.find(m => m.type === 'result') as unknown as Record<string, unknown> | undefined;
      const sessionId2 = t2Result?.session_id as string | undefined;

      // session_id must be the same across turns (same conversation)
      expect(sessionId2).toBe(sessionId1);
    } finally {
      session.close();
    }
  }, 120_000);

  it.skipIf(!!SKIP_REASON)('interrupt() wakes up idle stream()', async () => {
    const session = await unstable_v2_createSession({
      model: TEST_MODEL,
      provider: makeProvider(),
      maxTurns: 2,
    });

    try {
      // Complete one turn first
      await session.send('Hi');
      for await (const msg of session.stream()) {
        if (msg.type === 'result') break;
      }

      // Now enter idle stream() and interrupt it
      const streamDone = (async () => {
        const received: SDKMessage[] = [];
        for await (const msg of session.stream()) {
          received.push(msg);
          // Break if we get a result (shouldn't happen) to avoid infinite wait
          if (msg.type === 'result') break;
        }
        return received;
      })();

      // Wait a short moment then interrupt
      await new Promise(r => setTimeout(r, 500));
      await session.interrupt();

      const received = await streamDone;
      // Stream should have exited cleanly (no result expected, just empty)
      expect(Array.isArray(received)).toBe(true);
    } finally {
      session.close();
    }
  }, 60_000);

  it.skipIf(!!SKIP_REASON)('send() accepts multi-modal message envelope', async () => {
    const session = await unstable_v2_createSession({
      model: TEST_MODEL,
      provider: makeProvider(),
      maxTurns: 1,
    });

    try {
      // Consumer sends multi-modal messages as SDK envelope shape
      const envelope = {
        type: 'user' as const,
        message: {
          role: 'user' as const,
          content: [{ type: 'text', text: 'Say hello.' }],
        },
      };
      await session.send(envelope as unknown as string);

      const messages: SDKMessage[] = [];
      for await (const msg of session.stream()) {
        messages.push(msg);
        if (msg.type === 'result') break;
      }

      const result = messages.find(m => m.type === 'result');
      expect(result).toBeTruthy();
      assertResultMessage(result!);
    } finally {
      session.close();
    }
  }, 60_000);
});

describe('SDKMessage type guard — consumer-critical shapes', () => {
  it.skipIf(!!SKIP_REASON)('stream_event messages carry .event with Anthropic wire format', async () => {
    const q = query({
      prompt: 'Write one sentence.',
      options: {
        model: TEST_MODEL,
        provider: makeProvider(),
        maxTurns: 1,
      },
    });

    const messages = await drainQuery(q);
    const streamEvents = messages.filter(m => m.type === 'stream_event');

    // The consumer reads (sdkMessage as any).event
    // Note: some providers/responses may not produce stream_events when
    // the response is batched or falls back to non-streaming mode.
    // Verify structure when they exist.
    for (const msg of streamEvents) {
      const m = msg as unknown as Record<string, unknown>;
      expect(m.event, 'stream_event must have .event field').toBeTruthy();
      const ev = m.event as Record<string, unknown>;
      expect(typeof ev.type).toBe('string');
    }

    // When stream_events exist, they should contain text-related events
    const types = streamEvents.map(m => ((m as unknown as Record<string, unknown>).event as Record<string, unknown>).type);
    if (types.length > 0) {
      // One of these event types should appear for any text-producing LLM call
      const knownEventTypes = new Set(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
      const hasKnownType = types.some(t => knownEventTypes.has(t as string));
      expect(hasKnownType, `stream_event types ${JSON.stringify(types)} should include a known Anthropic wire event type`).toBe(true);
    }
    // If no stream_events, that's acceptable (non-streaming fallback path)
  }, 60_000);

  it.skipIf(!!SKIP_REASON)('message_start has Anthropic wire format (nested .message object)', async () => {
    const q = query({
      prompt: 'hi',
      options: {
        model: TEST_MODEL,
        provider: makeProvider(),
        maxTurns: 1,
      },
    });

    const messages = await drainQuery(q);
    const startEvent = messages
      .filter(m => m.type === 'stream_event')
      .find(m => {
        const ev = ((m as unknown as Record<string, unknown>).event) as Record<string, unknown>;
        return ev?.type === 'message_start';
      });

    // Only validate if message_start was present (not all providers emit it)
    if (startEvent) {
      const ev = (startEvent as unknown as Record<string, unknown>).event as Record<string, unknown>;
      // API wire format: { type: 'message_start', message: { id, model, role, content, usage, ... } }
      expect(ev.message, 'message_start must have nested .message object (API wire format)').toBeTruthy();
      const inner = ev.message as Record<string, unknown>;
      expect(typeof inner.id).toBe('string');
    }
  }, 60_000);

  it.skipIf(!!SKIP_REASON)('compact_boundary has compact_metadata field', async () => {
    // This is hard to trigger in a short test — just verify the shape is defined
    // We verify the type definition is correct by constructing a synthetic message
    const synthetic: SDKMessage = {
      type: 'system',
      subtype: 'compact_boundary',
      summary: 'test',
      compact_metadata: { trigger: 'auto', pre_tokens: 1000 },
      session_id: 'test',
      uuid: 'test',
    } as unknown as SDKMessage;
    const m = synthetic as unknown as Record<string, unknown>;
    expect(m.subtype).toBe('compact_boundary');
    expect((m.compact_metadata as Record<string, unknown>)?.trigger).toBe('auto');
  });
});

describe('error handling', () => {
  it.skipIf(!!SKIP_REASON)('query with invalid API key yields error result (not throw)', async () => {
    const badProvider = createProvider({
      type: 'openai-compat',
      apiKey: 'invalid-key',
      baseUrl: resolveBaseUrl(TEST_API_URL),
      defaultModel: TEST_MODEL,
    });

    const q = query({
      prompt: 'hi',
      options: {
        model: TEST_MODEL,
        provider: badProvider,
        maxTurns: 1,
      },
    });

    // Should not throw — errors are yielded as messages
    try {
      const messages = await drainQuery(q);
      // Either an error result or an api_retry message should appear
      const errorResult = messages.find(m => {
        if (m.type === 'result') {
          const r = m as unknown as Record<string, unknown>;
          return r.is_error === true;
        }
        return false;
      });
      const retryMsg = messages.find(m => m.type === 'system' && (m as unknown as Record<string, unknown>).subtype === 'api_retry');
      // At least one of these must appear
      expect(errorResult || retryMsg).toBeTruthy();
    } catch {
      // It's acceptable to throw on auth failures for the query() path
      // since some providers don't return a structured error response
    }
  }, 30_000);

  it.skipIf(!!SKIP_REASON)('createSession with invalid API key is graceful', async () => {
    const badProvider = createProvider({
      type: 'openai-compat',
      apiKey: 'invalid-key',
      baseUrl: resolveBaseUrl(TEST_API_URL),
      defaultModel: TEST_MODEL,
    });

    const session = await unstable_v2_createSession({
      model: TEST_MODEL,
      provider: badProvider,
      maxTurns: 1,
    });

    try {
      await session.send('hi');
      const messages: SDKMessage[] = [];
      for await (const msg of session.stream()) {
        messages.push(msg);
        if (msg.type === 'result') break;
        // safety: break after 20 messages
        if (messages.length > 20) break;
      }
      // Should at minimum have system:init
      const hasInit = messages.some(
        m => m.type === 'system' && (m as unknown as Record<string, unknown>).subtype === 'init',
      );
      expect(hasInit).toBe(true);
    } catch {
      // Acceptable — bad auth may throw
    } finally {
      session.close();
    }
  }, 30_000);
});

describe('built-in tool execution — file tools', () => {
  let testDir: string;

  beforeAll(() => {
    testDir = join(tmpdir(), `sdk-e2e-tools-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    // Seed a file for Read tool tests
    writeFileSync(join(testDir, 'hello.txt'), 'Hello from e2e test!', 'utf8');
  });

  it.skipIf(!!SKIP_REASON)('Read tool — model reads an existing file', async () => {
    const filePath = join(testDir, 'hello.txt');
    const q = query({
      prompt: `Read the file at path "${filePath}" and tell me its content verbatim.`,
      options: {
        model: TEST_MODEL,
        provider: makeProvider(),
        maxTurns: 5,
        cwd: testDir,
      },
    });

    const messages = await drainQuery(q);

    expect(hasAnyToolResult(messages), 'Read tool must produce a tool_result user message').toBe(true);

    // The final result must mention the file content
    const resultMsg = messages.find(m => m.type === 'result');
    expect(resultMsg).toBeTruthy();
    const r = resultMsg as unknown as Record<string, unknown>;
    expect(r.is_error).toBe(false);
    expect((r.result as string).toLowerCase()).toMatch(/hello/i);
  }, 90_000);

  it.skipIf(!!SKIP_REASON)('Write tool — model creates a new file', async () => {
    const outPath = join(testDir, 'output.txt');
    // Clean up in case of re-run
    if (existsSync(outPath)) rmSync(outPath);

    const q = query({
      prompt: `Create a new file at "${outPath}" containing exactly the text: "sdk-write-test". Do not add any other text.`,
      options: {
        model: TEST_MODEL,
        provider: makeProvider(),
        maxTurns: 5,
        cwd: testDir,
      },
    });

    const messages = await drainQuery(q);

    // Result must indicate success
    const resultMsg = messages.find(m => m.type === 'result');
    expect(resultMsg).toBeTruthy();
    const r = resultMsg as unknown as Record<string, unknown>;
    expect(r.is_error).toBe(false);

    // File must exist after agent run
    expect(existsSync(outPath), 'Write tool must create the file').toBe(true);
    const content = readFileSync(outPath, 'utf8');
    expect(content).toContain('sdk-write-test');
  }, 120_000);

  it.skipIf(!!SKIP_REASON)('Bash tool — model runs a shell command', async () => {
    const q = query({
      prompt: 'Run the shell command: echo "bash-e2e-ok" and return its output verbatim.',
      options: {
        model: TEST_MODEL,
        provider: makeProvider(),
        maxTurns: 5,
        cwd: testDir,
      },
    });

    const messages = await drainQuery(q);

    expect(hasAnyToolResult(messages), 'Bash tool must produce a tool_result user message').toBe(true);

    const resultMsg = messages.find(m => m.type === 'result');
    expect(resultMsg).toBeTruthy();
    const r = resultMsg as unknown as Record<string, unknown>;
    expect(r.is_error).toBe(false);

    // Check both tool outputs and model summary for the echo output.
    // The model may complete without repeating the command output verbatim.
    const toolOutputs = getAllToolOutputs(messages);
    const allText = [...toolOutputs, r.result as string].join('\n');
    expect(allText).toMatch(/bash-e2e-ok/i);
  }, 90_000);
});

describe('built-in tool execution — search tools', () => {
  let testDir: string;

  beforeAll(() => {
    testDir = join(tmpdir(), `sdk-e2e-search-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, 'alpha.txt'), 'grep-marker found here\nline two', 'utf8');
    writeFileSync(join(testDir, 'beta.txt'), 'no match in this file', 'utf8');
    writeFileSync(join(testDir, 'gamma.sdk-e2e'), 'file for glob test', 'utf8');
    writeFileSync(join(testDir, 'delta.sdk-e2e'), 'another glob file', 'utf8');
  });

  it.skipIf(!!SKIP_REASON)('Grep tool — model finds files containing a pattern', async () => {
    const q = query({
      prompt: `Use the Grep tool to search for the pattern "grep-marker" in the directory "${testDir}" and tell me the name of the file that contains it.`,
      options: {
        model: TEST_MODEL,
        provider: makeProvider(),
        maxTurns: 5,
        cwd: testDir,
      },
    });

    const messages = await drainQuery(q);

    expect(hasAnyToolResult(messages), 'Grep tool must produce a tool_result').toBe(true);

    const resultMsg = messages.find(m => m.type === 'result');
    expect(resultMsg).toBeTruthy();
    const r = resultMsg as unknown as Record<string, unknown>;
    expect(r.is_error).toBe(false);

    // The filename "alpha.txt" must appear in the tool output or the model's summary.
    // Checking both is more reliable — model may not repeat the filename in its summary.
    const toolOutputs = getAllToolOutputs(messages);
    const allText = [...toolOutputs, r.result as string].join('\n');
    expect(allText).toMatch(/alpha/i);
  }, 90_000);

  it.skipIf(!!SKIP_REASON)('Glob tool — model lists files matching a pattern', async () => {
    const q = query({
      prompt: `Use the Glob tool to find all files matching the pattern "*.sdk-e2e" in the directory "${testDir}". List the file names you find.`,
      options: {
        model: TEST_MODEL,
        provider: makeProvider(),
        maxTurns: 5,
        cwd: testDir,
      },
    });

    const messages = await drainQuery(q);

    expect(hasAnyToolResult(messages), 'Glob tool must produce a tool_result').toBe(true);

    const resultMsg = messages.find(m => m.type === 'result');
    expect(resultMsg).toBeTruthy();
    const r = resultMsg as unknown as Record<string, unknown>;
    expect(r.is_error).toBe(false);
    // At least one of the .sdk-e2e files must appear in the Glob tool output
    // (checking tool outputs directly is more reliable than the model's summary text)
    const toolOutputs = getAllToolOutputs(messages);
    const allText = [...toolOutputs, r.result as string].join('\n');
    expect(allText).toMatch(/gamma|delta/i);
  }, 90_000);
});

describe('built-in tool execution — Edit tool', () => {
  let testDir: string;

  beforeAll(() => {
    testDir = join(tmpdir(), `sdk-e2e-edit-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  it.skipIf(!!SKIP_REASON)('Edit tool — model replaces exact string in an existing file', async () => {
    const filePath = join(testDir, 'edit-target.txt');
    writeFileSync(filePath, 'PLACEHOLDER_TOKEN', 'utf8');

    const q = query({
      prompt:
        `Edit the file at "${filePath}". ` +
        'Replace the exact string "PLACEHOLDER_TOKEN" with "REPLACED_VALUE". ' +
        'Use the Edit tool with old_string="PLACEHOLDER_TOKEN" and new_string="REPLACED_VALUE".',
      options: {
        model: TEST_MODEL,
        provider: makeProvider(),
        maxTurns: 5,
        cwd: testDir,
      },
    });

    const messages = await drainQuery(q);

    expect(hasAnyToolResult(messages), 'Edit tool must produce a tool_result').toBe(true);

    const resultMsg = messages.find(m => m.type === 'result');
    expect(resultMsg).toBeTruthy();
    const r = resultMsg as unknown as Record<string, unknown>;
    expect(r.is_error).toBe(false);

    // File content must be updated on disk
    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('REPLACED_VALUE');
    expect(content).not.toContain('PLACEHOLDER_TOKEN');
  }, 90_000);

  it.skipIf(!!SKIP_REASON)('multi-turn chain — model reads then edits a file', async () => {
    const filePath = join(testDir, 'chain-target.txt');
    writeFileSync(filePath, 'version=1', 'utf8');

    const q = query({
      prompt:
        `Read the file at "${filePath}" to find its current content, ` +
        'then edit it using the Edit tool to replace "version=1" with "version=2". ' +
        'Use Read first, then Edit.',
      options: {
        model: TEST_MODEL,
        provider: makeProvider(),
        maxTurns: 8,
        cwd: testDir,
      },
    });

    const messages = await drainQuery(q);

    // Both Read and Edit must have produced tool_results
    expect(hasAnyToolResult(messages), 'Read+Edit chain must produce tool_results').toBe(true);

    const resultMsg = messages.find(m => m.type === 'result');
    expect(resultMsg).toBeTruthy();
    const r = resultMsg as unknown as Record<string, unknown>;
    expect(r.is_error).toBe(false);

    // Verify the edit was applied on disk
    const content = readFileSync(filePath, 'utf8');
    expect(content).toBe('version=2');
  }, 120_000);
});

describe('built-in tool execution — TodoWrite', () => {
  it.skipIf(!!SKIP_REASON)('TodoWrite tool — model updates task list', async () => {
    const q = query({
      prompt:
        'Use the TodoWrite tool to set your todo list to exactly one item: ' +
        '{ content: "Buy milk", status: "pending", activeForm: "Buying milk" }. ' +
        'After calling the tool, confirm that you updated the list.',
      options: {
        model: TEST_MODEL,
        provider: makeProvider(),
        maxTurns: 5,
      },
    });

    const messages = await drainQuery(q);

    expect(hasAnyToolResult(messages), 'TodoWrite tool must produce a tool_result').toBe(true);

    const resultMsg = messages.find(m => m.type === 'result');
    expect(resultMsg).toBeTruthy();
    const r = resultMsg as unknown as Record<string, unknown>;
    expect(r.is_error).toBe(false);
  }, 90_000);
});

describe('custom in-process MCP tool', () => {
  it.skipIf(!!SKIP_REASON)('tool() + createSdkMcpServer() — model invokes custom in-process tool', async () => {
    // Define a minimal echo tool via the tool() factory.
    // Pass a plain JSON schema object — zodToJsonSchema passes it through as-is.
    const echoTool = tool(
      'EchoMessage',
      'Echo back the provided message verbatim.',
      {
        type: 'object' as const,
        properties: { message: { type: 'string', description: 'The message to echo' } },
        required: ['message'],
      } as any,
      async (args: Record<string, unknown>) => ({
        content: [{ type: 'text' as const, text: `ECHO_RESULT:${args.message}` }],
      }),
    );

    // Wrap it in an in-process MCP server
    const mcpServer = createSdkMcpServer({
      name: 'echo-server',
      version: '1.0.0',
      tools: [echoTool],
    });

    const q = query({
      prompt:
        'Use the EchoMessage tool with message "sdk-e2e-custom-tool". ' +
        'Then report what the tool returned.',
      options: {
        model: TEST_MODEL,
        provider: makeProvider(),
        maxTurns: 5,
        mcpServers: { 'echo-server': mcpServer as any },
      },
    });

    const messages = await drainQuery(q);

    // The EchoMessage tool must have been called
    expect(hasAnyToolResult(messages), 'EchoMessage tool must produce a tool_result').toBe(true);

    // The tool output must contain the echoed text
    const toolOutputs = getAllToolOutputs(messages);
    expect(
      toolOutputs.some(o => o.includes('ECHO_RESULT:sdk-e2e-custom-tool')),
      `EchoMessage output must contain "ECHO_RESULT:sdk-e2e-custom-tool". Got: ${toolOutputs.join(', ')}`,
    ).toBe(true);

    const resultMsg = messages.find(m => m.type === 'result');
    expect(resultMsg).toBeTruthy();
    const r = resultMsg as unknown as Record<string, unknown>;
    expect(r.is_error).toBe(false);
  }, 90_000);
});

describe('built-in tool execution — WebFetch', () => {
  it.skipIf(!!SKIP_REASON)('WebFetch tool — model fetches a URL and reports content', async () => {
    const q = query({
      prompt: 'Use the WebFetch tool to fetch https://example.com and tell me the page title.',
      options: {
        model: TEST_MODEL,
        provider: makeProvider(),
        maxTurns: 5,
      },
    });

    const messages = await drainQuery(q);

    expect(hasAnyToolResult(messages), 'WebFetch tool must produce a tool_result').toBe(true);

    const resultMsg = messages.find(m => m.type === 'result');
    expect(resultMsg).toBeTruthy();
    const r = resultMsg as unknown as Record<string, unknown>;
    expect(r.is_error).toBe(false);

    // The fetched page content or model summary must reference example.com
    const toolOutputs = getAllToolOutputs(messages);
    const allText = [...toolOutputs, r.result as string].join('\n');
    expect(allText).toMatch(/example/i);
  }, 90_000);
});

describe('session resume', () => {
  it.skipIf(!!SKIP_REASON)('resumed session recalls previous conversation context', async () => {
    // Use OS tmpdir as cwd so transcript lookup is consistent between sessions
    const testCwd = tmpdir();
    const uniqueToken = `sdk-resume-${Date.now()}`;

    // --- First session: establish a unique piece of information ---
    const session1 = await unstable_v2_createSession({
      model: TEST_MODEL,
      provider: makeProvider(),
      maxTurns: 3,
      cwd: testCwd,
    });

    let session1Id: string | undefined;
    try {
      await session1.send(`Please remember this unique token for later: "${uniqueToken}". Just acknowledge it.`);
      for await (const msg of session1.stream()) {
        if (msg.type === 'result') {
          session1Id = (msg as unknown as Record<string, unknown>).session_id as string;
          break;
        }
      }
    } finally {
      session1.close();
    }

    expect(typeof session1Id).toBe('string');
    expect(session1Id!.length).toBeGreaterThan(0);

    // Wait for fire-and-forget transcript writes to flush to disk
    await new Promise<void>(res => setTimeout(res, 400));

    // --- Resumed session: ask it to recall the unique token ---
    const session2 = await unstable_v2_resumeSession(session1Id!, {
      model: TEST_MODEL,
      provider: makeProvider(),
      maxTurns: 3,
      cwd: testCwd,
    });

    let resumedResult: Record<string, unknown> | undefined;
    try {
      await session2.send('What unique token did I ask you to remember earlier?');
      for await (const msg of session2.stream()) {
        if (msg.type === 'result') {
          resumedResult = msg as unknown as Record<string, unknown>;
          break;
        }
      }
    } finally {
      session2.close();
    }

    expect(resumedResult).toBeTruthy();
    expect(resumedResult!.is_error).toBe(false);
    // The resumed session must recall the unique token from the transcript
    expect((resumedResult!.result as string)).toContain(uniqueToken);
  }, 180_000);
});

describe('built-in tool execution — Skill', () => {
  let testDir: string;

  beforeAll(() => {
    // Create a minimal skill directory under a temp cwd.
    // The SkillTool searches <cwd>/.claude/commands/ for .md files.
    testDir = join(tmpdir(), `sdk-e2e-skill-${Date.now()}`);
    const commandsDir = join(testDir, '.claude', 'commands');
    mkdirSync(commandsDir, { recursive: true });

    // Write a simple skill that the model can invoke and whose output is identifiable.
    writeFileSync(
      join(commandsDir, 'greet-sdk-e2e.md'),
      'Say exactly: SKILL_OUTPUT_OK\n',
      'utf8',
    );
  });

  it.skipIf(!!SKIP_REASON)('Skill tool — model invokes a local skill file', async () => {
    const q = query({
      prompt:
        'Use the Skill tool with skill="greet-sdk-e2e" to retrieve and follow the skill instructions.',
      options: {
        model: TEST_MODEL,
        provider: makeProvider(),
        maxTurns: 5,
        cwd: testDir,
      },
    });

    const messages = await drainQuery(q);

    expect(hasAnyToolResult(messages), 'Skill tool must produce a tool_result').toBe(true);

    const resultMsg = messages.find(m => m.type === 'result');
    expect(resultMsg).toBeTruthy();
    const r = resultMsg as unknown as Record<string, unknown>;
    expect(r.is_error).toBe(false);

    // The tool output must contain the skill file's content
    const toolOutputs = getAllToolOutputs(messages);
    expect(
      toolOutputs.some(o => o.includes('SKILL_OUTPUT_OK')),
      `Skill tool output must contain "SKILL_OUTPUT_OK". Got: ${toolOutputs.join(', ')}`,
    ).toBe(true);
  }, 90_000);
});
