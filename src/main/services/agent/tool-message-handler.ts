/** Tool-owned nested messages and external background-task progress. */

import type { Thought, TaskProgress, SessionState } from './types'
import { isDeveloperMode } from '../../foundation/logging'
import { emitAgentEvent } from './events'

// ============================================
// Types
// ============================================

/** Context passed from stream-processor for routing tool-owned events */
export interface ToolMessageContext {
  spaceId: string
  conversationId: string
  sessionState: SessionState
  /** Maps SDK tool_use_id → Thought.id for merging tool_result into tool_use */
  toolIdToThoughtId: Map<string, string>
}

/** Generate a unique thought ID */
function generateThoughtId(): string {
  return `thought-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

/**
 * Tool-owned messages arrive complete, without the stream deltas used by the
 * main conversation, so their tool calls and results are parsed directly.
 */
export function handleToolMessage(
  sdkMessage: any,
  parentToolUseId: string,
  ctx: ToolMessageContext
): void {
  const { spaceId, conversationId, sessionState, toolIdToThoughtId } = ctx
  const timestamp = new Date().toISOString()

  // Nested details reference the stored thought ID, not the engine's tool ID.
  const resolvedParentId = toolIdToThoughtId.get(parentToolUseId) ?? parentToolUseId

  if (sdkMessage.type === 'assistant') {
    const content = sdkMessage.message?.content
    if (!Array.isArray(content)) return

    for (const block of content) {
      if (block.type === 'tool_use') {
        const thoughtId = generateThoughtId()
        const toolId = block.id || thoughtId
        const toolName = block.name || 'Unknown'

        // Parse tool input
        let toolInput: Record<string, unknown> = {}
        try {
          if (typeof block.input === 'object' && block.input !== null) {
            toolInput = block.input
          } else if (typeof block.input === 'string') {
            toolInput = JSON.parse(block.input)
          }
        } catch {
          // Input parse failure is non-fatal
        }

        // Register mapping for tool_result merge
        toolIdToThoughtId.set(toolId, thoughtId)

        const thought: Thought = {
          id: thoughtId,
          type: 'tool_use',
          content: '',
          timestamp,
          toolName,
          toolInput,
          isStreaming: false,
          isReady: true,
          parentToolUseId: resolvedParentId,
        }

        sessionState.thoughts.push(thought)
        emitAgentEvent('agent:thought', spaceId, conversationId, { thought })

        console.log(`[ToolMessage][${conversationId}] tool_use: ${toolName} (parent=${resolvedParentId})`)
      }
      // Tool-owned text must not become the conversation's reply.
    }
  } else if (sdkMessage.type === 'user') {
    const content = sdkMessage.message?.content
    if (!Array.isArray(content)) return

    for (const block of content) {
      if (block.type === 'tool_result') {
        const toolId = block.tool_use_id
        const isError = block.is_error || false
        const resultContent = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content)

        // Try to merge into corresponding tool_use thought
        const toolUseThoughtId = toolId ? toolIdToThoughtId.get(toolId) : undefined
        if (toolUseThoughtId) {
          const toolResult = {
            output: resultContent,
            isError,
            timestamp,
          }

          // Update backend state
          const toolUseThought = sessionState.thoughts.find(t => t.id === toolUseThoughtId)
          if (toolUseThought) {
            toolUseThought.toolResult = toolResult
          }

          // Send merge delta to frontend
          emitAgentEvent('agent:thought-delta', spaceId, conversationId, {
            thoughtId: toolUseThoughtId,
            toolResult,
            isToolResult: true,
          })

          console.log(`[ToolMessage][${conversationId}] tool_result merged into ${toolUseThoughtId}`)
        } else {
          // Orphaned tool_result — create standalone thought (with parentToolUseId)
          const thought: Thought = {
            id: toolId || generateThoughtId(),
            type: 'tool_result',
            content: isError ? 'Tool execution failed' : 'Tool execution succeeded',
            timestamp,
            toolOutput: resultContent,
            isError,
            parentToolUseId: resolvedParentId,
          }
          sessionState.thoughts.push(thought)
          emitAgentEvent('agent:thought', spaceId, conversationId, { thought })
          console.log(`[ToolMessage][${conversationId}] tool_result orphaned (parent=${parentToolUseId})`)
        }
      }
    }
  }
}

// ============================================
// Task Lifecycle Events
// ============================================

export function handleTaskStarted(
  msg: Record<string, unknown>,
  ctx: ToolMessageContext
): void {
  const { spaceId, conversationId, sessionState } = ctx
  const taskId = msg.task_id as string
  const toolUseId = msg.tool_use_id as string | undefined

  if (isDeveloperMode()) {
    console.log(`[ToolMessage][${conversationId}] task_started: taskId=${taskId} toolUseId=${toolUseId ?? 'none'} @ ${new Date().toISOString()}`)
  }

  if (!toolUseId) return

  const thoughtId = ctx.toolIdToThoughtId.get(toolUseId)
  const taskThought = thoughtId
    ? sessionState.thoughts.find(t => t.id === thoughtId)
    : undefined

  if (taskThought) {
    taskThought.taskProgress = {
      taskId,
      status: 'running',
      toolCount: 0,
      durationMs: 0,
    }

    emitAgentEvent('agent:thought-delta', spaceId, conversationId, {
      thoughtId: taskThought.id,
      taskProgress: taskThought.taskProgress,
    })

  } else {
    // No matching thought — the toolIdToThoughtId mapping is incomplete, so
    // this task will render no progress at all.
    console.warn(
      `[ToolMessage][${conversationId}] task_started: no thought found for toolUseId=${toolUseId}` +
      ` | toolIdToThoughtId size=${ctx.toolIdToThoughtId.size}`
    )
  }
}

export function handleTaskProgress(
  msg: Record<string, unknown>,
  ctx: ToolMessageContext
): void {
  const { spaceId, conversationId, sessionState } = ctx
  const taskId = msg.task_id as string
  const usage = msg.usage as { total_tokens: number; tool_uses: number; duration_ms: number } | undefined

  // Fires once per tool-owned tool use — the hottest of the three lifecycle events.
  if (isDeveloperMode()) {
    console.log(
      `[ToolMessage][${conversationId}] task_progress: taskId=${taskId}` +
      ` lastTool=${String(msg.last_tool_name ?? '?')}` +
      ` tools=${usage?.tool_uses ?? 0} tokens=${usage?.total_tokens ?? 0}`
    )
  }

  const taskThought = sessionState.thoughts.find(
    t => t.taskProgress?.taskId === taskId
  )

  if (taskThought && taskThought.taskProgress) {
    taskThought.taskProgress.lastToolName = (msg.last_tool_name as string) ?? taskThought.taskProgress.lastToolName
    taskThought.taskProgress.toolCount = usage?.tool_uses ?? taskThought.taskProgress.toolCount
    taskThought.taskProgress.durationMs = usage?.duration_ms ?? taskThought.taskProgress.durationMs
    taskThought.taskProgress.totalTokens = usage?.total_tokens ?? taskThought.taskProgress.totalTokens
    if (msg.summary) {
      taskThought.taskProgress.summary = msg.summary as string
    }

    emitAgentEvent('agent:thought-delta', spaceId, conversationId, {
      thoughtId: taskThought.id,
      taskProgress: { ...taskThought.taskProgress },
    })
  }
}

export function handleTaskNotification(
  msg: Record<string, unknown>,
  ctx: ToolMessageContext
): void {
  const { spaceId, conversationId, sessionState } = ctx
  const taskId = msg.task_id as string
  const status = (msg.status as string) ?? 'completed'
  const usage = msg.usage as { total_tokens: number; tool_uses: number; duration_ms: number } | undefined

  if (isDeveloperMode()) {
    console.log(
      `[ToolMessage][${conversationId}] task_notification: taskId=${taskId} status=${status}` +
      ` @ ${new Date().toISOString()}`
    )
  }

  const taskThought = sessionState.thoughts.find(
    t => t.taskProgress?.taskId === taskId
  )

  if (taskThought && taskThought.taskProgress) {
    taskThought.taskProgress.status = status as TaskProgress['status']
    taskThought.taskProgress.summary = (msg.summary as string) ?? taskThought.taskProgress.summary
    taskThought.taskProgress.toolCount = usage?.tool_uses ?? taskThought.taskProgress.toolCount
    taskThought.taskProgress.durationMs = usage?.duration_ms ?? taskThought.taskProgress.durationMs
    taskThought.taskProgress.totalTokens = usage?.total_tokens ?? taskThought.taskProgress.totalTokens

    emitAgentEvent('agent:thought-delta', spaceId, conversationId, {
      thoughtId: taskThought.id,
      taskProgress: { ...taskThought.taskProgress },
    })

  } else {
    // Thought not found — the task finished before its task_started was
    // processed, so its final status never reaches the UI.
    console.warn(
      `[ToolMessage][${conversationId}] task_notification: no thought found for taskId=${taskId}` +
      ` | thoughts with taskProgress: ${sessionState.thoughts.filter(t => t.taskProgress).length}`
    )
  }
}
