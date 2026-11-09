/**
 * @module core/stop-hooks
 * Stop Hook execution engine — runs Stop hooks at the end of each query turn
 * and returns a structured result controlling whether the loop continues.
 *
 * Contract:
 *   - Yields SDKMessages (hook progress notifications) to the caller
 *   - Returns StopHookResult: { blockingErrors, preventContinuation }
 *   - blockingErrors → caller injects them as user messages and continues
 *   - preventContinuation → caller terminates the loop
 *   - Never throws (catch-safe)
 * @license MIT
 */

import { randomUUID } from 'node:crypto';
import type { HookCallbackMatcher } from '../types/config.js';
import type { SDKMessage } from './query-types.js';
import { runEventHooks } from './hooks.js';
import { getTranscriptPath, type TranscriptOptions } from './transcript.js';
import { buildUserMessage } from './messages.js';
import { getLogger } from '../utils/logger.js';

const log = getLogger('StopHook');

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Result returned by handleStopHooks().
 *
 * blockingErrors: messages to inject as user turn and retry the loop.
 *   Each entry is a pre-built user Message ready to be pushed to the
 *   conversation array.
 *
 * preventContinuation: if true, the loop must terminate immediately
 *   (hook signalled explicit stop).
 */
export interface StopHookResult {
  /** Pre-built user messages to inject and continue the loop. */
  blockingErrors: ReturnType<typeof buildUserMessage>[];
  /** If true, the loop must terminate. */
  preventContinuation: boolean;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export interface HandleStopHooksParams {
  /** Registered hook matchers (from QueryConfig.hooks.Stop). */
  hooks: Partial<Record<string, HookCallbackMatcher[]>> | undefined;
  /** Session ID for hook input payload. */
  sessionId: string;
  /** Working directory for hook input payload. */
  cwd: string;
  /** Abort signal — if aborted during hook execution, preventContinuation=true. */
  abortSignal: AbortSignal;
}

// ---------------------------------------------------------------------------
// handleStopHooks — async generator
// ---------------------------------------------------------------------------

/**
 * Run Stop hooks and yield progress SDKMessages while doing so.
 *
 * Calling pattern in query-loop:
 *   const stopResult = yield* handleStopHooks({ hooks, sessionId, cwd, abortSignal });
 *   if (stopResult.preventContinuation) { ...terminate... }
 *   if (stopResult.blockingErrors.length > 0) { ...inject and continue... }
 *
 * The generator yields notification SDKMessages so that consumer UIs can
 * display hook activity in real-time.
 *
 * Safety: the outer try/catch guarantees no unhandled rejection escapes,
 * preserving the advisory-only contract of hooks.
 */
export async function* handleStopHooks(
  params: HandleStopHooksParams,
  transcriptOptions?: TranscriptOptions,
): AsyncGenerator<SDKMessage, StopHookResult> {
  const { hooks, sessionId, cwd, abortSignal } = params;

  // If aborted before we even start, short-circuit immediately.
  if (abortSignal.aborted) {
    return { blockingErrors: [], preventContinuation: true };
  }

  // No Stop hooks configured — fast-path (common case).
  // Cast: hooks is typed as Partial<Record<HookEvent, ...>> in QueryConfig.
  const stopHooks = (hooks as Record<string, HookCallbackMatcher[]> | undefined)?.['Stop'];
  if (!stopHooks || stopHooks.length === 0) {
    return { blockingErrors: [], preventContinuation: false };
  }

  try {
    const hookInput = {
      hook_event_name: 'Stop',
      session_id: sessionId,
      transcript_path: getTranscriptPath(sessionId, cwd, transcriptOptions),
      cwd,
      stop_hook_active: false,
    };

    // Yield a hook_started notification so consumers can show activity.
    const hookId = randomUUID();
    const startedMsg: SDKMessage = {
      type: 'system',
      subtype: 'hook_started',
      hook_id: hookId,
      hook_name: 'Stop',
      hook_event: 'Stop',
      uuid: randomUUID(),
      session_id: sessionId,
    };
    yield startedMsg;

    // Run hooks (sequential, via existing runEventHooks machinery).
    const outputs = await runEventHooks(
      hooks as Parameters<typeof runEventHooks>[0],
      'Stop',
      hookInput,
      abortSignal,
    );

    // Check abort after hook execution.
    if (abortSignal.aborted) {
      return { blockingErrors: [], preventContinuation: true };
    }

    // Yield hook_response notification.
    const responseMsg: SDKMessage = {
      type: 'system',
      subtype: 'hook_response',
      hook_id: hookId,
      hook_name: 'Stop',
      hook_event: 'Stop',
      output: '',
      stdout: '',
      stderr: '',
      outcome: 'success',
      uuid: randomUUID(),
      session_id: sessionId,
    };
    yield responseMsg;

    // Process hook outputs.
    const blockingErrors: ReturnType<typeof buildUserMessage>[] = [];
    let preventContinuation = false;

    for (const out of outputs) {
      // preventContinuation: hook explicitly signals loop termination.
      if (out['preventContinuation'] === true) {
        preventContinuation = true;
      }

      // Resolve the blocking message. Two shapes are accepted:
      //   1. Legacy:  { blockingError: '...' }
      //   2. Envelope: { decision: 'block', reason: '...' }
      // When `decision === 'block'` we also fall back to `systemMessage`
      // and finally to a generic placeholder so the loop still retries
      // with *something*.
      let blockingMessage: string | undefined;
      if (typeof out['blockingError'] === 'string' && out['blockingError']) {
        blockingMessage = out['blockingError'];
      } else if (out['decision'] === 'block') {
        const reason = out['reason'];
        const sysMsg = out['systemMessage'];
        if (typeof reason === 'string' && reason) {
          blockingMessage = reason;
        } else if (typeof sysMsg === 'string' && sysMsg) {
          blockingMessage = sysMsg;
        } else {
          blockingMessage = 'Stop hook blocked continuation.';
        }
      }

      if (blockingMessage) {
        const userMsg = buildUserMessage(blockingMessage);
        blockingErrors.push(userMsg);

        // Yield a notification so consumers see the blocking error.
        const blockingMsg: SDKMessage = {
          type: 'system',
          subtype: 'hook_response',
          hook_id: hookId,
          hook_name: 'Stop',
          hook_event: 'Stop',
          output: blockingMessage,
          stdout: blockingMessage,
          stderr: '',
          outcome: 'error',
          uuid: randomUUID(),
          session_id: sessionId,
        };
        yield blockingMsg;
      }
    }

    if (preventContinuation) {
      // preventContinuation wins over blockingErrors.
      return { blockingErrors: [], preventContinuation: true };
    }

    return { blockingErrors, preventContinuation: false };
  } catch (err: unknown) {
    // Hooks are advisory, so the turn continues — but a dropped Stop hook
    // means its blocking decision was lost, which the caller cannot see.
    log.warn('Stop hook run failed; continuation allowed without it', {
      err: err instanceof Error ? err.message : String(err),
    });
    return { blockingErrors: [], preventContinuation: false };
  }
}
