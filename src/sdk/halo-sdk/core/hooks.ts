/**
 * @module core/hooks
 * Hook execution engine for the Agent SDK.
 * Fires registered hook callbacks (PreToolUse, PostToolUse, PostToolUseFailure,
 * PreCompact, PostCompact, SessionStart, SessionEnd, etc.) with tool-name
 * matching and optional timeout enforcement.
 *
 * Ordering guarantee: hooks run sequentially in registration order, and each
 * PreToolUse hook receives the tool input as modified by earlier hooks in the
 * chain (`tool_input` is re-threaded between hooks). A hook that normalizes
 * input therefore takes effect before a later hook that validates it.
 *
 * Settings-based hooks are translated into
 * HookCallbackMatcher[] by the consumer and passed via Options.hooks.
 * @license MIT
 */

import type {
  HookEvent,
  HookCallbackMatcher,
  HookInput,
} from '../types/config.js';
import { getTranscriptPath, type TranscriptOptions } from './transcript.js';
import { getLogger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Hook result types
// ---------------------------------------------------------------------------

/**
 * Result from a PreToolUse hook execution.
 * If `decision` is set, the hook made a permission decision.
 */
export interface PreToolUseHookResult {
  /** Hook permission decision: 'allow', 'deny', or undefined (no opinion). */
  decision?: 'allow' | 'deny';
  /** Reason for the decision. */
  decisionReason?: string;
  /** Updated tool input (if the hook modified it). */
  updatedInput?: Record<string, unknown>;
  /** Additional context to inject into the conversation. */
  additionalContext?: string;
}

/**
 * Result from a PostToolUse hook execution.
 */
export interface PostToolUseHookResult {
  /** Additional context to inject. */
  additionalContext?: string;
  /** Updated MCP tool output (if the hook modified it). */
  updatedToolOutput?: unknown;
}

// ---------------------------------------------------------------------------
// Default timeout
// ---------------------------------------------------------------------------

const DEFAULT_HOOK_TIMEOUT_MS = 60_000; // 60 seconds

// ---------------------------------------------------------------------------
// Matcher logic
// ---------------------------------------------------------------------------

/**
 * Check if a tool name matches a matcher pattern.
 * - undefined/empty matcher: matches all tools
 * - exact string: case-sensitive match
 * - glob-like: supports trailing '*' (e.g., "Bash*", "mcp__*")
 */
function toolMatchesMatcher(toolName: string, matcher?: string): boolean {
  if (!matcher) return true;
  if (matcher === toolName) return true;
  if (matcher.endsWith('*')) {
    return toolName.startsWith(matcher.slice(0, -1));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Timeout wrapper
// ---------------------------------------------------------------------------

/**
 * Run a callback with a timeout. Rejects with an error if the callback
 * does not resolve within the given number of milliseconds.
 */
async function withTimeout<T>(
  callback: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  parentSignal: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel!: () => void;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => {
        controller.abort();
        reject(Object.assign(new Error(`Hook "${label}" aborted`), { name: 'AbortError' }));
      };
      parentSignal.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Hook "${label}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    if (parentSignal.aborted) cancel();
    return await Promise.race([cancelled, callback(controller.signal)]);
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', cancel);
  }
}

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

/**
 * Run all matching hooks for a given event.
 * Hooks are executed sequentially (not in parallel) to preserve ordering
 * and allow earlier hooks to influence later ones.
 *
 * @param onResult Optional callback invoked after each hook's output is
 *   collected, before the next hook runs. Callers may mutate `input` inside
 *   it to thread earlier hooks' effects into later hooks (see
 *   runPreToolUseHooks).
 * @returns Array of all hook outputs (including empty objects for hooks
 *          that didn't return anything meaningful).
 */
export async function runHooks(
  event: HookEvent,
  matchers: HookCallbackMatcher[] | undefined,
  input: HookInput | Record<string, unknown>,
  toolUseId: string | undefined,
  signal: AbortSignal,
  toolName?: string,
  onResult?: (result: Record<string, unknown>) => void,
): Promise<Record<string, unknown>[]> {
  if (!matchers || matchers.length === 0) return [];

  const results: Record<string, unknown>[] = [];

  for (const matcher of matchers) {
    // Check tool name matching (for PreToolUse/PostToolUse/PostToolUseFailure)
    if (toolName !== undefined && !toolMatchesMatcher(toolName, matcher.matcher)) {
      continue;
    }

    const timeoutMs = matcher.timeout
      ? matcher.timeout * 1000 // timeout is in seconds in the config
      : DEFAULT_HOOK_TIMEOUT_MS;

    for (const hook of matcher.hooks) {
      if (signal.aborted) break;

      try {
        const result = await withTimeout(
          hookSignal => hook(input as HookInput, toolUseId, { signal: hookSignal }),
          timeoutMs,
          `${event}${matcher.matcher ? `:${matcher.matcher}` : ''}`,
          signal,
        );
        if (result && typeof result === 'object') {
          results.push(result as Record<string, unknown>);
          onResult?.(result as Record<string, unknown>);
        }
      } catch (err: unknown) {
        // Log but don't propagate hook errors — hooks are advisory
        const msg = err instanceof Error ? err.message : String(err);
        if (!signal.aborted) getLogger('Hooks').warn('Hook failed', { event, sessionId: input.session_id, error: msg });
        results.push({ hookError: msg });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Typed hook runners for tool lifecycle
// ---------------------------------------------------------------------------

/**
 * Merge one hook output into the accumulated PreToolUse result.
 * Accepts both the legacy flat shape AND the `hookSpecificOutput` envelope
 * (`{hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision, ...}}`).
 * When both shapes are present the envelope wins (it's the documented
 * contract); missing envelope fields fall back to flat. Last non-undefined
 * decision wins; additionalContext accumulates.
 */
function mergePreToolUseOutput(
  result: PreToolUseHookResult,
  out: Record<string, unknown>,
): void {
  if ('hookError' in out) return;
  const flat = out;
  const envelope = extractHookSpecificOutput(out, 'PreToolUse');

  const permissionDecision =
    (envelope?.permissionDecision as unknown) ?? flat.permissionDecision;
  const permissionDecisionReason =
    (envelope?.permissionDecisionReason as unknown) ?? flat.permissionDecisionReason;
  const updatedInput = (envelope?.updatedInput as unknown) ?? flat.updatedInput;
  const additionalContext =
    (envelope?.additionalContext as unknown) ?? flat.additionalContext;

  if (permissionDecision === 'allow' || permissionDecision === 'deny') {
    result.decision = permissionDecision;
    if (permissionDecisionReason) {
      result.decisionReason = String(permissionDecisionReason);
    }
  }
  if (updatedInput && typeof updatedInput === 'object') {
    result.updatedInput = updatedInput as Record<string, unknown>;
  }
  if (additionalContext) {
    result.additionalContext = result.additionalContext
      ? `${result.additionalContext}\n${String(additionalContext)}`
      : String(additionalContext);
  }
}

/**
 * Run PreToolUse hooks for a specific tool invocation.
 * Returns the merged result affecting permission and input.
 *
 * Input threading: outputs are merged after EACH hook, and the merged
 * `updatedInput` replaces `tool_input` in the payload seen by subsequent
 * hooks. A later hook's `updatedInput` is therefore derived from — and
 * supersedes — the earlier hook's, so the final `result.updatedInput` is
 * cumulative rather than last-writer-discards-earlier.
 */
export async function runPreToolUseHooks(
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
  sessionId: string,
  cwd: string,
  signal: AbortSignal,
  transcriptOptions?: TranscriptOptions,
): Promise<PreToolUseHookResult> {
  if (!hooks?.PreToolUse) return {};

  const input: Record<string, unknown> = {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    transcript_path: getTranscriptPath(sessionId, cwd, transcriptOptions),
    cwd,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  };

  const result: PreToolUseHookResult = {};
  await runHooks(
    'PreToolUse',
    hooks.PreToolUse,
    input,
    toolUseId,
    signal,
    toolName,
    (out) => {
      mergePreToolUseOutput(result, out);
      if (result.updatedInput) {
        input.tool_input = result.updatedInput;
      }
    },
  );

  return result;
}

// ---------------------------------------------------------------------------
// hookSpecificOutput envelope helper
// ---------------------------------------------------------------------------

/**
 * Extract the `hookSpecificOutput` payload when its `hookEventName` matches
 * the expected event. Returns undefined when the envelope is absent or the
 * event tag doesn't match — this keeps PostToolUse output from leaking into
 * a PreToolUse merge if a hook accidentally tags the wrong event.
 *
 */
function extractHookSpecificOutput(
  out: Record<string, unknown>,
  expectedEvent: HookEvent,
): Record<string, unknown> | undefined {
  const hso = out.hookSpecificOutput;
  if (!hso || typeof hso !== 'object') return undefined;
  const payload = hso as Record<string, unknown>;
  if (payload.hookEventName !== expectedEvent) return undefined;
  return payload;
}

/**
 * Run PostToolUse hooks after a tool completes successfully.
 */
export async function runPostToolUseHooks(
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: unknown,
  toolUseId: string,
  sessionId: string,
  cwd: string,
  signal: AbortSignal,
  transcriptOptions?: TranscriptOptions,
): Promise<PostToolUseHookResult> {
  if (!hooks?.PostToolUse) return {};

  const input: Record<string, unknown> = {
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    transcript_path: getTranscriptPath(sessionId, cwd, transcriptOptions),
    cwd,
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
    tool_use_id: toolUseId,
  };

  const outputs = await runHooks(
    'PostToolUse',
    hooks.PostToolUse,
    input,
    toolUseId,
    signal,
    toolName,
  );

  const result: PostToolUseHookResult = {};
  for (const out of outputs) {
    if ('hookError' in out) continue;
    const envelope = extractHookSpecificOutput(out, 'PostToolUse');

    const additionalContext =
      (envelope?.additionalContext as unknown) ?? out.additionalContext;
    const updatedMCPToolOutput =
      envelope?.updatedMCPToolOutput !== undefined
        ? envelope.updatedMCPToolOutput
        : out.updatedMCPToolOutput;

    if (additionalContext) {
      result.additionalContext = result.additionalContext
        ? `${result.additionalContext}\n${String(additionalContext)}`
        : String(additionalContext);
    }
    if (updatedMCPToolOutput !== undefined) {
      result.updatedToolOutput = updatedMCPToolOutput;
    }
  }

  return result;
}

/**
 * Run PostToolUseFailure hooks when a tool execution fails.
 */
export async function runPostToolUseFailureHooks(
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
  error: string,
  toolUseId: string,
  sessionId: string,
  cwd: string,
  signal: AbortSignal,
  transcriptOptions?: TranscriptOptions,
): Promise<void> {
  if (!hooks?.PostToolUseFailure) return;

  const input: Record<string, unknown> = {
    hook_event_name: 'PostToolUseFailure',
    session_id: sessionId,
    transcript_path: getTranscriptPath(sessionId, cwd, transcriptOptions),
    cwd,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
    error,
  };

  await runHooks(
    'PostToolUseFailure',
    hooks.PostToolUseFailure,
    input,
    toolUseId,
    signal,
    toolName,
  );
}

/**
 * Run event hooks that are not tool-specific (SessionStart, SessionEnd, etc.).
 */
export async function runEventHooks(
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined,
  event: HookEvent,
  input: HookInput | Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>[]> {
  if (!hooks?.[event]) return [];
  return runHooks(event, hooks[event], input, undefined, signal);
}
