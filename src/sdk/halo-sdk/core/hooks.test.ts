/**
 * Unit tests for the hook execution engine.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runHooks,
  runPreToolUseHooks,
  runPostToolUseHooks,
  runPostToolUseFailureHooks,
  runEventHooks,
} from './hooks.js';
import type { HookCallbackMatcher, HookEvent } from '../types/config.js';
import { getTranscriptPath } from './transcript.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noop = new AbortController().signal;

function makeHook(result?: Record<string, unknown>) {
  return vi.fn().mockResolvedValue(result ?? {});
}

function makeMatcher(
  hooks: HookCallbackMatcher['hooks'],
  matcher?: string,
): HookCallbackMatcher {
  return { hooks, matcher };
}

/** Build the hooks config object used by runPreToolUseHooks / runPostToolUseHooks etc. */
function makeHooksConfig(
  event: HookEvent,
  matchers: HookCallbackMatcher[],
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return { [event]: matchers };
}

const TEST_SESSION_ID = 'session-test-123';
const TEST_CWD = '/test/cwd';

describe('tool hook transcript paths', () => {
  it('uses the per-session environment and conventions for all tool lifecycle hooks', async () => {
    const options = {
      env: { SDK_CONFIG: '/tmp/sdk-hook-store' },
      conventions: { configDirEnv: 'SDK_CONFIG' },
    };
    const hook = makeHook();
    const hooks = {
      PreToolUse: [makeMatcher([hook])],
      PostToolUse: [makeMatcher([hook])],
      PostToolUseFailure: [makeMatcher([hook])],
    };
    await runPreToolUseHooks(hooks, 'Read', {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop, options);
    await runPostToolUseHooks(hooks, 'Read', {}, 'ok', 'tu1', TEST_SESSION_ID, TEST_CWD, noop, options);
    await runPostToolUseFailureHooks(hooks, 'Read', {}, 'failed', 'tu1', TEST_SESSION_ID, TEST_CWD, noop, options);
    expect(hook).toHaveBeenCalledTimes(3);
    for (const [input] of hook.mock.calls) {
      expect(input.transcript_path).toBe(getTranscriptPath(TEST_SESSION_ID, TEST_CWD, options));
    }
  });
});

// ---------------------------------------------------------------------------
// runHooks — base hook executor
// ---------------------------------------------------------------------------

describe('runHooks', () => {
  it('returns empty array when no matchers provided', async () => {
    const result = await runHooks('PreToolUse', undefined, {}, undefined, noop);
    expect(result).toEqual([]);
  });

  it('calls matching hooks and returns their results', async () => {
    const hook = makeHook({ x: 1 });
    const matchers = [makeMatcher([hook])];
    const results = await runHooks('PreToolUse', matchers, {}, 'tu1', noop, 'Bash');
    expect(hook).toHaveBeenCalledOnce();
    expect(results).toEqual([{ x: 1 }]);
  });

  it('skips hooks when tool name does not match exact matcher', async () => {
    const hook = makeHook({ x: 1 });
    const matchers = [makeMatcher([hook], 'Write')];
    await runHooks('PreToolUse', matchers, {}, 'tu1', noop, 'Bash');
    expect(hook).not.toHaveBeenCalled();
  });

  it('matches all tools when matcher is undefined', async () => {
    const hook = makeHook({});
    const matchers = [makeMatcher([hook])];
    await runHooks('PreToolUse', matchers, {}, undefined, noop, 'AnyTool');
    expect(hook).toHaveBeenCalledOnce();
  });

  it('supports glob-style wildcard matcher (e.g., "mcp__*")', async () => {
    const hook = makeHook({});
    const matchers = [makeMatcher([hook], 'mcp__*')];
    await runHooks('PreToolUse', matchers, {}, undefined, noop, 'mcp__memory__get');
    expect(hook).toHaveBeenCalledOnce();
  });

  it('does not match non-matching wildcard', async () => {
    const hook = makeHook({});
    const matchers = [makeMatcher([hook], 'mcp__*')];
    await runHooks('PreToolUse', matchers, {}, undefined, noop, 'Bash');
    expect(hook).not.toHaveBeenCalled();
  });

  it('logs and continues when a hook throws', async () => {
    const failHook = vi.fn().mockRejectedValue(new Error('hook failed'));
    const okHook = makeHook({ ok: true });
    const matchers = [makeMatcher([failHook, okHook])];
    const results = await runHooks('PostToolUse', matchers, {}, undefined, noop, 'Bash');
    const hasError = results.some(r => r.hookError);
    const hasOk = results.some(r => r.ok);
    expect(hasError).toBe(true);
    expect(hasOk).toBe(true);
  });

  it('stops running hooks when signal is aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const hook = makeHook({ x: 1 });
    const matchers = [makeMatcher([hook])];
    await runHooks('PreToolUse', matchers, {}, undefined, ac.signal, 'Bash');
    expect(hook).not.toHaveBeenCalled();
  });

  it('executes hooks sequentially, not in parallel', async () => {
    const order: number[] = [];
    const h1 = vi.fn(async () => { order.push(1); return {}; });
    const h2 = vi.fn(async () => { order.push(2); return {}; });
    const matchers = [makeMatcher([h1, h2])];
    await runHooks('PostToolUse', matchers, {}, undefined, noop, 'Bash');
    expect(order).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// runPreToolUseHooks
// Signature: (hooks, toolName, toolInput, toolUseId, sessionId, cwd, signal)
// Hook output uses permissionDecision ('allow'|'deny'), not decision
// ---------------------------------------------------------------------------

describe('runPreToolUseHooks — hookSpecificOutput envelope', () => {
  it('accepts deny via {hookSpecificOutput: {hookEventName, permissionDecision}}', async () => {
    const hook = vi.fn().mockResolvedValue({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'envelope deny',
      },
    });
    const hooks = makeHooksConfig('PreToolUse', [makeMatcher([hook])]);
    const result = await runPreToolUseHooks(hooks, 'Bash', {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(result.decision).toBe('deny');
    expect(result.decisionReason).toBe('envelope deny');
  });

  it('accepts allow via envelope', async () => {
    const hook = vi.fn().mockResolvedValue({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
    const hooks = makeHooksConfig('PreToolUse', [makeMatcher([hook])]);
    const result = await runPreToolUseHooks(hooks, 'Bash', {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(result.decision).toBe('allow');
  });

  it('accepts updatedInput and additionalContext via envelope', async () => {
    const hook = vi.fn().mockResolvedValue({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { foo: 'bar' },
        additionalContext: 'env ctx',
      },
    });
    const hooks = makeHooksConfig('PreToolUse', [makeMatcher([hook])]);
    const result = await runPreToolUseHooks(hooks, 'Bash', {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(result.updatedInput).toEqual({ foo: 'bar' });
    expect(result.additionalContext).toBe('env ctx');
  });

  it('ignores envelope tagged with the wrong hookEventName', async () => {
    const hook = vi.fn().mockResolvedValue({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse', // wrong event!
        permissionDecision: 'deny',
      },
    });
    const hooks = makeHooksConfig('PreToolUse', [makeMatcher([hook])]);
    const result = await runPreToolUseHooks(hooks, 'Bash', {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(result.decision).toBeUndefined();
  });

  it('still honours legacy flat shape when no envelope provided', async () => {
    const hook = vi.fn().mockResolvedValue({
      permissionDecision: 'deny',
      permissionDecisionReason: 'flat',
    });
    const hooks = makeHooksConfig('PreToolUse', [makeMatcher([hook])]);
    const result = await runPreToolUseHooks(hooks, 'Bash', {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(result.decision).toBe('deny');
    expect(result.decisionReason).toBe('flat');
  });

  it('envelope wins over flat when both present', async () => {
    const hook = vi.fn().mockResolvedValue({
      permissionDecision: 'allow',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
    const hooks = makeHooksConfig('PreToolUse', [makeMatcher([hook])]);
    const result = await runPreToolUseHooks(hooks, 'Bash', {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(result.decision).toBe('deny');
  });
});

describe('runPostToolUseHooks — hookSpecificOutput envelope', () => {
  it('accepts additionalContext via envelope', async () => {
    const hook = vi.fn().mockResolvedValue({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'post env ctx',
      },
    });
    const hooks = makeHooksConfig('PostToolUse', [makeMatcher([hook])]);
    const result = await runPostToolUseHooks(hooks, 'Bash', {}, {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(result.additionalContext).toBe('post env ctx');
  });

  it('accepts updatedMCPToolOutput via envelope', async () => {
    const hook = vi.fn().mockResolvedValue({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedMCPToolOutput: { wrapped: true },
      },
    });
    const hooks = makeHooksConfig('PostToolUse', [makeMatcher([hook])]);
    const result = await runPostToolUseHooks(hooks, 'Bash', {}, {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(result.updatedToolOutput).toEqual({ wrapped: true });
  });

  it('ignores envelope tagged with wrong hookEventName', async () => {
    const hook = vi.fn().mockResolvedValue({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: 'should not leak',
      },
    });
    const hooks = makeHooksConfig('PostToolUse', [makeMatcher([hook])]);
    const result = await runPostToolUseHooks(hooks, 'Bash', {}, {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(result.additionalContext).toBeUndefined();
  });
});

describe('runPreToolUseHooks', () => {
  it('merges allow decision from hook', async () => {
    const hook = vi.fn().mockResolvedValue({
      permissionDecision: 'allow',
      permissionDecisionReason: 'approved',
    });
    const hooks = makeHooksConfig('PreToolUse', [makeMatcher([hook])]);
    const result = await runPreToolUseHooks(hooks, 'Bash', {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(result.decision).toBe('allow');
    expect(result.decisionReason).toBe('approved');
  });

  it('merges deny decision from hook', async () => {
    const hook = vi.fn().mockResolvedValue({ permissionDecision: 'deny' });
    const hooks = makeHooksConfig('PreToolUse', [makeMatcher([hook])]);
    const result = await runPreToolUseHooks(hooks, 'Bash', {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(result.decision).toBe('deny');
  });

  it('passes additionalContext from hook', async () => {
    const hook = vi.fn().mockResolvedValue({ additionalContext: 'extra info' });
    const hooks = makeHooksConfig('PreToolUse', [makeMatcher([hook])]);
    const result = await runPreToolUseHooks(hooks, 'Bash', {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(result.additionalContext).toBe('extra info');
  });

  it('returns no decision when hooks have no opinion', async () => {
    const hook = makeHook({});
    const hooks = makeHooksConfig('PreToolUse', [makeMatcher([hook])]);
    const result = await runPreToolUseHooks(hooks, 'Bash', {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(result.decision).toBeUndefined();
  });

  it('passes updatedInput from hook through to result', async () => {
    const hook = vi.fn().mockResolvedValue({ updatedInput: { newParam: 'modified' } });
    const hooks = makeHooksConfig('PreToolUse', [makeMatcher([hook])]);
    const result = await runPreToolUseHooks(hooks, 'Bash', {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(result.updatedInput).toEqual({ newParam: 'modified' });
  });

  it('returns empty result when no PreToolUse hooks registered', async () => {
    const result = await runPreToolUseHooks(undefined, 'Bash', {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(result).toEqual({});
  });
});

describe('runPreToolUseHooks — input threading between hooks', () => {
  it('a later hook sees the earlier hook\'s updatedInput', async () => {
    const seenByH2: unknown[] = [];
    const h1 = vi.fn().mockResolvedValue({
      updatedInput: { file_path: '/normalized/path.txt' },
    });
    const h2 = vi.fn(async (input: { tool_input: unknown }) => {
      seenByH2.push(input.tool_input);
      return {};
    });
    const hooks = makeHooksConfig('PreToolUse', [makeMatcher([h1, h2])]);
    await runPreToolUseHooks(
      hooks, 'Read', { file_path: '../path.txt' }, 'tu1', TEST_SESSION_ID, TEST_CWD, noop,
    );
    expect(seenByH2).toEqual([{ file_path: '/normalized/path.txt' }]);
  });

  it('threads updatedInput across matchers, not just within one matcher', async () => {
    const seenByH2: unknown[] = [];
    const h1 = vi.fn().mockResolvedValue({ updatedInput: { cmd: 'ls -la' } });
    const h2 = vi.fn(async (input: { tool_input: unknown }) => {
      seenByH2.push(input.tool_input);
      return {};
    });
    const hooks = makeHooksConfig('PreToolUse', [
      makeMatcher([h1], 'Bash'),
      makeMatcher([h2], 'Bash*'),
    ]);
    await runPreToolUseHooks(hooks, 'Bash', { cmd: 'ls' }, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(seenByH2).toEqual([{ cmd: 'ls -la' }]);
  });

  it('final updatedInput reflects the last hook in the chain', async () => {
    const h1 = vi.fn().mockResolvedValue({ updatedInput: { a: 1 } });
    const h2 = vi.fn(async (input: { tool_input: Record<string, unknown> }) => ({
      updatedInput: { ...input.tool_input, b: 2 },
    }));
    const hooks = makeHooksConfig('PreToolUse', [makeMatcher([h1, h2])]);
    const result = await runPreToolUseHooks(hooks, 'Bash', {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(result.updatedInput).toEqual({ a: 1, b: 2 });
  });

  it('a hook that errors does not disturb threading for later hooks', async () => {
    const seenByH3: unknown[] = [];
    const h1 = vi.fn().mockResolvedValue({ updatedInput: { x: 'v1' } });
    const h2 = vi.fn().mockRejectedValue(new Error('boom'));
    const h3 = vi.fn(async (input: { tool_input: unknown }) => {
      seenByH3.push(input.tool_input);
      return {};
    });
    const hooks = makeHooksConfig('PreToolUse', [makeMatcher([h1, h2, h3])]);
    const result = await runPreToolUseHooks(hooks, 'Bash', {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(seenByH3).toEqual([{ x: 'v1' }]);
    expect(result.updatedInput).toEqual({ x: 'v1' });
  });

  it('accumulates additionalContext from multiple hooks in order', async () => {
    const h1 = vi.fn().mockResolvedValue({ additionalContext: 'first' });
    const h2 = vi.fn().mockResolvedValue({ additionalContext: 'second' });
    const hooks = makeHooksConfig('PreToolUse', [makeMatcher([h1, h2])]);
    const result = await runPreToolUseHooks(hooks, 'Bash', {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(result.additionalContext).toBe('first\nsecond');
  });
});

// ---------------------------------------------------------------------------
// runPostToolUseHooks
// Signature: (hooks, toolName, toolInput, toolResponse, toolUseId, sessionId, cwd, signal)
// ---------------------------------------------------------------------------

describe('runPostToolUseHooks', () => {
  it('returns empty result when no hooks', async () => {
    const result = await runPostToolUseHooks(undefined, 'Bash', {}, {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(result.additionalContext).toBeUndefined();
    expect(result.updatedToolOutput).toBeUndefined();
  });

  it('merges additionalContext from hook', async () => {
    const hook = vi.fn().mockResolvedValue({ additionalContext: 'extra' });
    const hooks = makeHooksConfig('PostToolUse', [makeMatcher([hook])]);
    const result = await runPostToolUseHooks(hooks, 'Bash', {}, {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(result.additionalContext).toBe('extra');
  });

  it('passes updatedMCPToolOutput as updatedToolOutput', async () => {
    const hook = vi.fn().mockResolvedValue({ updatedMCPToolOutput: { modified: true } });
    const hooks = makeHooksConfig('PostToolUse', [makeMatcher([hook])]);
    const result = await runPostToolUseHooks(hooks, 'Bash', {}, {}, 'tu1', TEST_SESSION_ID, TEST_CWD, noop);
    expect(result.updatedToolOutput).toEqual({ modified: true });
  });
});

// ---------------------------------------------------------------------------
// runPostToolUseFailureHooks
// Signature: (hooks, toolName, toolInput, error: string, toolUseId, sessionId, cwd, signal)
// ---------------------------------------------------------------------------

describe('runPostToolUseFailureHooks', () => {
  it('calls hooks and returns undefined on success', async () => {
    const hook = makeHook({});
    const hooks = makeHooksConfig('PostToolUseFailure', [makeMatcher([hook])]);
    await expect(runPostToolUseFailureHooks(hooks, 'Bash', {}, 'error message', 'tu1', TEST_SESSION_ID, TEST_CWD, noop)).resolves.toBeUndefined();
    expect(hook).toHaveBeenCalledOnce();
  });

  it('returns undefined when no hooks registered', async () => {
    await expect(runPostToolUseFailureHooks(undefined, 'Bash', {}, 'err', 'tu1', TEST_SESSION_ID, TEST_CWD, noop)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runEventHooks
// Signature: (hooks, event, input, signal)
// ---------------------------------------------------------------------------

describe('runEventHooks', () => {
  it('calls event hook and returns array of results', async () => {
    const hook = makeHook({ fired: true });
    const hooks = makeHooksConfig('SessionStart', [makeMatcher([hook])]);
    const results = await runEventHooks(hooks, 'SessionStart', {}, noop);
    expect(hook).toHaveBeenCalledOnce();
    expect(results).toEqual([{ fired: true }]);
  });

  it('returns empty array when no hooks registered', async () => {
    const results = await runEventHooks(undefined, 'SessionEnd', {}, noop);
    expect(results).toEqual([]);
  });

  it('returns empty array when event not in hooks map', async () => {
    const hooks = makeHooksConfig('SessionStart', [makeMatcher([makeHook()])]);
    const results = await runEventHooks(hooks, 'SessionEnd', {}, noop);
    expect(results).toEqual([]);
  });
});
