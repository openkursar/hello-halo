/**
 * @module core/tool-execution
 * Per-call hooks, permissions and result settlement, independent of scheduling.
 * @license MIT
 */

import { randomUUID } from 'node:crypto';
import type { ToolUseBlock } from '../types/provider.js';
import type { QueryConfig } from '../types/config.js';
import type { Tool, ToolContext, ToolResult } from '../types/tool.js';
import type { SDKMessage, SDKResultMessage } from './query-types.js';
import type { buildToolResultMessage } from './messages.js';
import { runPreToolUseHooks, runPostToolUseHooks, runPostToolUseFailureHooks } from './hooks.js';
import { validateToolInput } from './tool-input.js';
import { checkAbort, raceAbortSignal } from './abort.js';
import { isAbortError } from '../utils/errors.js';
import { truncateToolResult } from '../utils/truncate.js';
import { getLogger } from '../utils/logger.js';
import type { ToolDiscoveryState, ToolDiscoveryEnvelope } from './tool-context/index.js';

const log = getLogger('ToolExecution');

export type CompletedToolResult = Parameters<typeof buildToolResultMessage>[0][number] & {
  interrupt?: boolean;
  discoveryEnvelope?: ToolDiscoveryEnvelope;
};

export interface PreparedToolExecution {
  call: ToolUseBlock;
  run: () => Promise<CompletedToolResult>;
}

export interface ToolExecutionOptions {
  toolContext?: ToolDiscoveryState | null;
  config: QueryConfig;
  tools: Tool[];
  toolCtx: ToolContext;
  sessionId: string;
  emitProgress: (message: SDKMessage) => void | Promise<void>;
  onToolMessage: (message: SDKMessage) => Promise<void>;
  unreadableInputs: ReadonlyMap<string, string>;
  permissionDenials: SDKResultMessage['permission_denials'];
}

async function executeTool(
  tool: Tool,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    checkAbort(ctx.abortSignal);
    const result = await raceAbortSignal(tool.execute(input, ctx), ctx.abortSignal);
    return { content: result.content, isError: result.isError, images: result.images };
  } catch (error) {
    if (isAbortError(error, ctx.abortSignal)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    log.warn('Tool execution failed', { tool: tool.name, sessionId: ctx.sessionId, error: message });
    return { content: `Tool execution error: ${message}`, isError: true };
  }
}

export function createToolExecution(options: ToolExecutionOptions): {
  run: (call: ToolUseBlock) => Promise<CompletedToolResult>;
  prepare: (call: ToolUseBlock) => Promise<PreparedToolExecution>;
  completedResults: Map<string, CompletedToolResult>;
} {
  const { config, tools, toolCtx, sessionId, emitProgress, onToolMessage,
    unreadableInputs, permissionDenials } = options;
  const toolStartTimes = new Map<string, number>();
  const completedResults = new Map<string, CompletedToolResult>();

  function toolProgress(toolName: string, toolUseId: string, elapsedTimeSec?: number): SDKMessage {
    return {
      type: 'tool_progress',
      tool_name: toolName,
      tool_use_id: toolUseId,
      parent_tool_use_id: null,
      ...(elapsedTimeSec !== undefined ? { elapsed_time_seconds: elapsedTimeSec } : {}),
      uuid: randomUUID(),
      session_id: sessionId,
    };
  }

  const prepareOneTool = async (call: ToolUseBlock): Promise<PreparedToolExecution> => {
    const toolUse = { ...call, input: structuredClone(call.input) };
    checkAbort(config.abortSignal);
    const tool = tools.find(candidate => candidate.name === toolUse.name);

    // Bind invocation identity and backpressured tool messages.
    const perCallCtx: ToolContext = {
      ...toolCtx,
      toolUseId: toolUse.id,
      onToolMessage: msg => onToolMessage(msg as SDKMessage),
    };

    const ready = (execute: () => Promise<CompletedToolResult>): PreparedToolExecution => {
      let running: Promise<CompletedToolResult> | undefined;
      return { call: toolUse, run: () => running ??= settleTool(toolUse, execute, true, !!tool && tool === options.toolContext?.searchTool) };
    };
    const rejected = (result: CompletedToolResult): PreparedToolExecution => ready(async () => result);
    const rejectCall = (reason: string): PreparedToolExecution =>
      rejected({ toolUseId: toolUse.id, content: reason, isError: true });

    const unreadableInput = unreadableInputs.get(toolUse.id);
    if (unreadableInput) {
      return rejectCall(unreadableInput);
    }

    if (!tool) {
      return rejectCall(
        `Tool "${toolUse.name}" not found. Available tools: ${(options.toolContext?.modelDefinitions ?? tools).map((t) => t.name).join(', ')}`,
      );
    }

    // Snapshot the model's original input before hooks can modify it, so a
    // hook adjustment can be reported against what the model actually sent.
    const originalInput = JSON.stringify(toolUse.input);
    const preHookResult = await runPreToolUseHooks(
      config.hooks,
      toolUse.name,
      toolUse.input,
      toolUse.id,
      sessionId,
      config.cwd,
      config.abortSignal,
      config,
    );
    checkAbort(config.abortSignal);

    // Hook can deny tool execution. The result text tells the model what to
    // do next: never retry the identical call, and use the hook's context
    // (or reason) to adjust.
    if (preHookResult.decision === 'deny') {
      const reason = preHookResult.decisionReason || 'no reason given';
      const guidance = preHookResult.additionalContext
        ?? 'Adjust your approach based on the reason above, or ask the user if the reason is unclear.';
      const deniedContent =
        `Tool use denied by PreToolUse hook: ${reason}. ` +
        `Do not retry the identical call. ${guidance}`;
      return rejected({ toolUseId: toolUse.id, content: deniedContent, isError: true });
    }

    if (preHookResult.updatedInput) Object.assign(toolUse.input, preHookResult.updatedInput);
    const inputAfterHooks = JSON.stringify(toolUse.input);

    // Interactive tools still need the host callback to obtain the user's answer.
    const isAlwaysAllowed = config.allowedTools?.some(rule => rule.trim() === toolUse.name);
    const needsRuleEvaluation = config.allowedTools?.some(rule => rule.trim().startsWith(`${toolUse.name}(`));
    const skipPermissionCheck =
      !tool.requiresUserInteraction &&
      (config.permissionMode === 'bypassPermissions' || !!isAlwaysAllowed);
    if (needsRuleEvaluation && !config.canUseTool && !skipPermissionCheck) {
      log.warn('Conditional tool permission requires a host checker', { tool: toolUse.name, sessionId });
      return rejectCall('This conditional permission rule requires a host canUseTool callback. The tool did not run.');
    }
    if (config.canUseTool && !skipPermissionCheck) {
      try {
        checkAbort(config.abortSignal);
        const permResult = await raceAbortSignal(config.canUseTool(toolUse.name, toolUse.input, {
          signal: config.abortSignal,
          toolUseID: toolUse.id,
        }), config.abortSignal);
        checkAbort(config.abortSignal);
        if (permResult.behavior === 'deny') {
          permissionDenials.push({
            tool_name: toolUse.name,
            tool_use_id: toolUse.id,
            tool_input: { ...toolUse.input },
          });

          const deniedContent = permResult.message
            ? `Permission denied: ${permResult.message}`
            : 'Permission denied';
          return rejected({ toolUseId: toolUse.id, content: deniedContent, isError: true, interrupt: !!permResult.interrupt });
        }
        if (permResult.updatedInput) {
          Object.assign(toolUse.input, permResult.updatedInput);
        }
      } catch (permErr: unknown) {
        if (isAbortError(permErr, config.abortSignal)) throw permErr;
        const errMsg = permErr instanceof Error ? permErr.message : String(permErr);
        log.warn('Tool permission check failed', { tool: toolUse.name, sessionId, error: errMsg });
        return rejected({ toolUseId: toolUse.id, content: `Permission check error: ${errMsg}`, isError: true });
      }
    }

    const effectiveInput = JSON.stringify(toolUse.input);
    let inputAdjustedNote: string | undefined;
    if (effectiveInput !== originalInput) {
      const changedByHook = inputAfterHooks !== originalInput;
      const changedByPermission = effectiveInput !== inputAfterHooks;
      const source = changedByHook && changedByPermission ? 'a PreToolUse hook and permission callback'
        : changedByHook ? 'a PreToolUse hook' : 'a permission callback';
      const preview = effectiveInput.length > 200 ? `${effectiveInput.slice(0, 200)}…` : effectiveInput;
      inputAdjustedNote = `Note: ${source} adjusted this call's input before execution. Effective input: ${preview}`;
    }

    // Checked here rather than on arrival so a PreToolUse hook still gets its
    // chance to normalise the model's arguments, and so what is checked is
    // exactly what will run.
    const schemaProblem = validateToolInput(tool.name, tool.inputSchema, toolUse.input);
    if (schemaProblem) {
      return rejectCall(
        inputAdjustedNote ? `${inputAdjustedNote}\n\n${schemaProblem}` : schemaProblem,
      );
    }

    return ready(async () => {
      checkAbort(config.abortSignal);
      const result = await executeTool(tool, toolUse.input, perCallCtx);
      const executedResult: CompletedToolResult = {
        toolUseId: toolUse.id,
        content: truncateToolResult(result.content, config.toolResultBudget),
        isError: result.isError,
        images: result.images,
      };
      result.content = executedResult.content;
      const executedText = result.content;
      const discoveryEnvelope = tool === options.toolContext?.searchTool ? { prefix: '', suffix: '' } : undefined;
      completedResults.set(toolUse.id, executedResult);

      if (result.isError) {
        await runPostToolUseFailureHooks(
          config.hooks,
          toolUse.name,
          toolUse.input,
          result.content,
          toolUse.id,
          sessionId,
          config.cwd,
          config.abortSignal,
          config,
        );
      } else {
        const postResult = await runPostToolUseHooks(
          config.hooks,
          toolUse.name,
          toolUse.input,
          result.content,
          toolUse.id,
          sessionId,
          config.cwd,
          config.abortSignal,
          config,
        );

        // PostToolUse hooks can replace the tool output entirely; apply the
        // replacement before appending context so the context refers to what
        // the model will actually read.
        if (postResult.updatedToolOutput !== undefined) {
          result.content = typeof postResult.updatedToolOutput === 'string'
            ? postResult.updatedToolOutput
            : JSON.stringify(postResult.updatedToolOutput);
        }

        // PostToolUse hooks can append additional context
        if (postResult.additionalContext) {
          result.content += `\n\n${postResult.additionalContext}`;
          if (discoveryEnvelope) discoveryEnvelope.suffix = `\n\n${postResult.additionalContext}`;
        }
      }

      checkAbort(config.abortSignal);

      // Prepend additional context from PreToolUse hooks (if any)
      if (preHookResult.additionalContext) {
        result.content = `${preHookResult.additionalContext}\n\n${result.content}`;
        if (discoveryEnvelope) discoveryEnvelope.prefix = `${preHookResult.additionalContext}\n\n`;
      }

      // Surface hook-adjusted input (if any) so the model knows the executed
      // call differed from the one it issued.
      if (inputAdjustedNote) {
        result.content = `${inputAdjustedNote}\n\n${result.content}`;
        if (discoveryEnvelope) discoveryEnvelope.prefix = `${inputAdjustedNote}\n\n${discoveryEnvelope.prefix}`;
      }

      return {
        toolUseId: toolUse.id,
        content: result.content === executedText ? executedResult.content : result.content,
        isError: result.isError,
        images: result.images,
        ...(discoveryEnvelope ? { discoveryEnvelope } : {}),
      };
    });
  };

  const settleTool = async (
    call: ToolUseBlock, execute: () => Promise<CompletedToolResult>, announce = true, discoveryTool = false,
  ): Promise<CompletedToolResult> => {
    try {
      checkAbort(config.abortSignal);
      if (announce) {
        toolStartTimes.set(call.id, Date.now());
        await emitProgress(toolProgress(call.name, call.id));
        checkAbort(config.abortSignal);
      }
      const result = await execute();
      // Hooks may replace or enlarge output; the final boundary owns the text budget.
      result.content = truncateToolResult(result.content, config.toolResultBudget);
      if (options.toolContext && discoveryTool) {
        const settled = options.toolContext.settle(call.id, result, result.discoveryEnvelope);
        result.content = settled.result.content;
        result.isError = settled.result.isError;
        result.toolContext = settled.record;
        delete result.discoveryEnvelope;
      }
      completedResults.set(call.id, result);
      return result;
    } catch (error) {
      if (isAbortError(error, config.abortSignal)) throw error;
      log.warn('Tool result processing failed', { tool: call.name, sessionId, error: String(error) });
      const completed = completedResults.get(call.id);
      const result: CompletedToolResult = {
        toolUseId: call.id,
        isError: completed?.isError ?? true,
        images: completed?.images,
        content: truncateToolResult(completed
          ? `${completed.content}\n\nThe tool completed, but processing its result failed. Check its effects before repeating the action.`
          : `Tool call failed before a result was available: ${String(error)}`, config.toolResultBudget),
      };
      completedResults.set(call.id, result);
      return result;
    } finally {
      const startedAt = toolStartTimes.get(call.id);
      toolStartTimes.delete(call.id);
      if (startedAt !== undefined) {
        const progress = toolProgress(call.name, call.id, (Date.now() - startedAt) / 1000);
        await emitProgress(progress);
      }
    }
  };

  const prepare = async (call: ToolUseBlock): Promise<PreparedToolExecution> => {
    try {
      return await prepareOneTool(call);
    } catch (error) {
      const result = await settleTool(call, async () => { throw error; }, false);
      return { call, run: async () => result };
    }
  };

  return { prepare, run: async call => (await prepare(call)).run(), completedResults };
}
