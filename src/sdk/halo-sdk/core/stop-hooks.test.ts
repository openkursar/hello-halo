/**
 * Unit tests for handleStopHooks — Stop-hook decision contract.
 * Covers both the legacy {blockingError} shape and the {decision:'block', reason} envelope.
 */

import { describe, it, expect, vi } from 'vitest';
import type { HookCallbackMatcher } from '../types/config.js';
import { handleStopHooks } from './stop-hooks.js';
import { getTranscriptPath } from './transcript.js';

const TEST_SESSION_ID = 'session-stop-test';
const TEST_CWD = '/test/cwd';

function makeStopHooks(
  hookFns: Array<(...args: unknown[]) => unknown>,
): Partial<Record<string, HookCallbackMatcher[]>> {
  return {
    Stop: [
      {
        hooks: hookFns as HookCallbackMatcher['hooks'],
      },
    ],
  };
}

async function drain(
  gen: ReturnType<typeof handleStopHooks>,
): Promise<{ messages: unknown[]; result: Awaited<ReturnType<typeof handleStopHooks>['next']>['value'] }> {
  const messages: unknown[] = [];
  while (true) {
    const r = await gen.next();
    if (r.done) return { messages, result: r.value };
    messages.push(r.value);
  }
}

describe('handleStopHooks — transcript path', () => {
  it('uses the per-session environment and conventions', async () => {
    const options = {
      env: { SDK_CONFIG: '/tmp/sdk-stop-store' },
      conventions: { configDirEnv: 'SDK_CONFIG' },
    };
    const hook = vi.fn().mockResolvedValue({});
    await drain(handleStopHooks({
      hooks: makeStopHooks([hook]),
      sessionId: TEST_SESSION_ID,
      cwd: TEST_CWD,
      abortSignal: new AbortController().signal,
    }, options));
    expect(hook.mock.calls[0][0].transcript_path).toBe(getTranscriptPath(TEST_SESSION_ID, TEST_CWD, options));
  });
});

describe('handleStopHooks — no hooks configured', () => {
  it('fast-paths when hooks map is undefined', async () => {
    const { messages, result } = await drain(
      handleStopHooks({
        hooks: undefined,
        sessionId: TEST_SESSION_ID,
        cwd: TEST_CWD,
        abortSignal: new AbortController().signal,
      }),
    );
    expect(messages).toEqual([]);
    expect(result).toEqual({ blockingErrors: [], preventContinuation: false });
  });

  it('fast-paths when Stop hook list is empty', async () => {
    const { messages, result } = await drain(
      handleStopHooks({
        hooks: { Stop: [] },
        sessionId: TEST_SESSION_ID,
        cwd: TEST_CWD,
        abortSignal: new AbortController().signal,
      }),
    );
    expect(messages).toEqual([]);
    expect(result).toEqual({ blockingErrors: [], preventContinuation: false });
  });
});

describe('handleStopHooks — legacy {blockingError} shape', () => {
  it('injects blockingError as a user message', async () => {
    const hook = vi.fn().mockResolvedValue({ blockingError: 'please retry with X' });
    const { result } = await drain(
      handleStopHooks({
        hooks: makeStopHooks([hook]),
        sessionId: TEST_SESSION_ID,
        cwd: TEST_CWD,
        abortSignal: new AbortController().signal,
      }),
    );
    expect(result.preventContinuation).toBe(false);
    expect(result.blockingErrors).toHaveLength(1);
  });

  it('honours preventContinuation', async () => {
    const hook = vi.fn().mockResolvedValue({ preventContinuation: true });
    const { result } = await drain(
      handleStopHooks({
        hooks: makeStopHooks([hook]),
        sessionId: TEST_SESSION_ID,
        cwd: TEST_CWD,
        abortSignal: new AbortController().signal,
      }),
    );
    expect(result.preventContinuation).toBe(true);
    expect(result.blockingErrors).toHaveLength(0);
  });
});

describe('handleStopHooks — {decision:"block", reason}', () => {
  it('treats decision:"block" with reason as a blocking error', async () => {
    const hook = vi.fn().mockResolvedValue({
      decision: 'block',
      reason: 'must finish task #42 first',
    });
    const { messages, result } = await drain(
      handleStopHooks({
        hooks: makeStopHooks([hook]),
        sessionId: TEST_SESSION_ID,
        cwd: TEST_CWD,
        abortSignal: new AbortController().signal,
      }),
    );
    expect(result.preventContinuation).toBe(false);
    expect(result.blockingErrors).toHaveLength(1);
    // The hook_response notification carries the reason text.
    const errMsg = messages.find(
      (m) =>
        typeof m === 'object' &&
        m !== null &&
        (m as { outcome?: string }).outcome === 'error',
    ) as { output?: string } | undefined;
    expect(errMsg?.output).toBe('must finish task #42 first');
  });

  it('falls back to systemMessage when reason is absent', async () => {
    const hook = vi.fn().mockResolvedValue({
      decision: 'block',
      systemMessage: 'system-level notice',
    });
    const { result } = await drain(
      handleStopHooks({
        hooks: makeStopHooks([hook]),
        sessionId: TEST_SESSION_ID,
        cwd: TEST_CWD,
        abortSignal: new AbortController().signal,
      }),
    );
    expect(result.blockingErrors).toHaveLength(1);
  });

  it('uses a generic placeholder when decision:"block" carries no reason or systemMessage', async () => {
    const hook = vi.fn().mockResolvedValue({ decision: 'block' });
    const { result } = await drain(
      handleStopHooks({
        hooks: makeStopHooks([hook]),
        sessionId: TEST_SESSION_ID,
        cwd: TEST_CWD,
        abortSignal: new AbortController().signal,
      }),
    );
    expect(result.blockingErrors).toHaveLength(1);
  });

  it('decision other than "block" is ignored (e.g. "approve")', async () => {
    const hook = vi.fn().mockResolvedValue({ decision: 'approve', reason: 'ok' });
    const { result } = await drain(
      handleStopHooks({
        hooks: makeStopHooks([hook]),
        sessionId: TEST_SESSION_ID,
        cwd: TEST_CWD,
        abortSignal: new AbortController().signal,
      }),
    );
    expect(result.blockingErrors).toHaveLength(0);
    expect(result.preventContinuation).toBe(false);
  });
});

describe('handleStopHooks — abort handling', () => {
  it('returns preventContinuation when aborted before run', async () => {
    const ac = new AbortController();
    ac.abort();
    const { result } = await drain(
      handleStopHooks({
        hooks: makeStopHooks([vi.fn().mockResolvedValue({})]),
        sessionId: TEST_SESSION_ID,
        cwd: TEST_CWD,
        abortSignal: ac.signal,
      }),
    );
    expect(result.preventContinuation).toBe(true);
  });
});
