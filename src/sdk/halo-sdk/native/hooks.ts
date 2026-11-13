import type { HookCallbackMatcher, HookEvent, HookInput } from '../types/config.js';
import type { TranscriptOptions } from '../core/transcript.js';
import type { PostToolUseHookResult, PreToolUseHookResult } from '../core/hooks.js';
import { NativeCallbacks } from './callbacks.js';
import { runPublic } from './operation.js';

type Hooks = Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined;
interface HookResult {
  outputs: Record<string, unknown>[];
  references: (string | null)[];
  pre?: PreToolUseHookResult;
  inputReference?: string | null;
  post?: PostToolUseHookResult;
  outputIndex?: number | null;
  outputField?: 'flat' | 'envelope' | null;
}

function output(result: HookResult, index: number, callbacks: NativeCallbacks): Record<string, unknown> {
  const reference = result.references[index];
  return reference ? callbacks.capturedHookOutput(reference) as Record<string, unknown> : result.outputs[index];
}

export async function runHooks(event: HookEvent, matchers: HookCallbackMatcher[] | undefined,
  input: HookInput | Record<string, unknown>, toolUseId: string | undefined, signal: AbortSignal,
  toolName?: string, onResult?: (result: Record<string, unknown>) => void): Promise<Record<string, unknown>[]> {
  if (!matchers?.length || signal.aborted) return [];
  const callbacks = new NativeCallbacks(); callbacks.bindHookInput(input);
  const helperObserver = onResult ? (_value: unknown, invocation: string) => {
    const result = callbacks.capturedHookOutput(invocation) as Record<string, unknown>;
    onResult(result); return { input, result };
  } : undefined;
  return runPublic('hooks.run', { hooks: { [event]: matchers }, ...(helperObserver ? { helperObserver } : {}) },
    { event, input, toolUseId, toolName }, signal,
    { callbacks, advisoryCancellation: true, result: (value: HookResult) => value.outputs.map((_, index) => output(value, index, callbacks)) });
}

export async function runEventHooks(hooks: Hooks, event: HookEvent, input: HookInput | Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>[]> {
  return runHooks(event, hooks?.[event], input, undefined, signal);
}

export async function runPreToolUseHooks(hooks: Hooks, toolName: string, toolInput: Record<string, unknown>,
  toolUseId: string, sessionId: string, cwd: string, signal: AbortSignal, transcriptOptions?: TranscriptOptions): Promise<PreToolUseHookResult> {
  if (!hooks?.PreToolUse || signal.aborted) return {};
  const callbacks = new NativeCallbacks(); callbacks.bindToolInput(toolInput);
  return runPublic('hooks.pre', { hooks, cwd, ...transcriptOptions },
    { event: 'PreToolUse', toolName, toolInput, toolUseId, sessionId }, signal,
    { callbacks, advisoryCancellation: true, result: (value: HookResult) => {
      const result = value.pre!;
      if (value.inputReference) result.updatedInput = callbacks.capturedHookReference(value.inputReference) as Record<string, unknown>;
      return result;
    } });
}

export async function runPostToolUseHooks(hooks: Hooks, toolName: string, toolInput: Record<string, unknown>,
  toolResponse: unknown, toolUseId: string, sessionId: string, cwd: string, signal: AbortSignal, transcriptOptions?: TranscriptOptions): Promise<PostToolUseHookResult> {
  if (!hooks?.PostToolUse || signal.aborted) return {};
  const callbacks = new NativeCallbacks(); callbacks.bindToolInput(toolInput); callbacks.bindHookFields({ tool_response: toolResponse });
  return runPublic('hooks.post', { hooks, cwd, ...transcriptOptions },
    { event: 'PostToolUse', toolName, toolInput, toolResponse, toolUseId, sessionId }, signal,
    { callbacks, advisoryCancellation: true, result: (value: HookResult) => {
      const result = value.post!;
      if (value.outputIndex != null) {
        const source = output(value, value.outputIndex, callbacks);
        result.updatedToolOutput = value.outputField === 'envelope'
          ? (source.hookSpecificOutput as Record<string, unknown>).updatedMCPToolOutput : source.updatedMCPToolOutput;
      }
      return result;
    } });
}

export async function runPostToolUseFailureHooks(hooks: Hooks, toolName: string, toolInput: Record<string, unknown>,
  error: string, toolUseId: string, sessionId: string, cwd: string, signal: AbortSignal, transcriptOptions?: TranscriptOptions): Promise<void> {
  if (!hooks?.PostToolUseFailure || signal.aborted) return;
  const callbacks = new NativeCallbacks(); callbacks.bindToolInput(toolInput);
  await runPublic('hooks.failure', { hooks, cwd, ...transcriptOptions },
    { event: 'PostToolUseFailure', toolName, toolInput, error, toolUseId, sessionId }, signal,
    { callbacks, advisoryCancellation: true });
}
