/**
 * Agent Module - Sub-Agent Message Handler
 *
 * Processes SDK messages from sub-agents (those with parent_tool_use_id != null).
 * These messages contain the sub-agent's individual tool_use and tool_result blocks,
 * streamed in real-time by the SDK's queryHelpers.ts agent_progress mechanism.
 *
 * Unlike the main agent path (which uses stream_event for token-level streaming),
 * sub-agent messages arrive as complete assistant/user SDK messages. This module
 * parses them into Thought objects with parentToolUseId set, enabling the frontend
 * to render them nested under the parent Task thought.
 *
 * Also handles task lifecycle events (task_started, task_progress, task_notification)
 * which provide agent-level metadata for the Task thought's progress display.
 */

import type { Thought, TaskProgress, SessionState } from './types'
import { emitAgentEvent } from './events'

// ============================================
// Types
// ============================================

/** Context passed from stream-processor for routing sub-agent events */
export interface SubAgentContext {
  spaceId: string
  conversationId: string
  sessionState: SessionState
  /** Maps SDK tool_use_id → Thought.id for merging tool_result into tool_use */
  toolIdToThoughtId: Map<string, string>
}

// ============================================
// Team Task Detection
// ============================================

/**
 * Check if any Agent Team tasks are still running.
 *
 * Used by:
 * - stream-processor: decide whether to re-enter stream() for continuation turns
 * - control: decide whether to close() the entire CC subprocess on stop
 *
 * Detection logic: a thought is a team agent if it's a tool_use for the Agent tool
 * with a team_name in its input. It's "active" if it has no taskProgress yet
 * (task_started hasn't arrived) or taskProgress.status is 'running'.
 *
 * Exit conditions:
 * 1. A successful TeamDelete tool call is present → team is disbanded, no more work.
 *    This is the primary completion signal: CC converts sub-agent completions into
 *    idle notification *messages* (not system/task_notification events), so taskProgress
 *    may never update from 'running' to 'completed' via the normal path. TeamDelete
 *    is the authoritative signal that the main agent considers team work done.
 * 2. All Agent tool_use thoughts have taskProgress.status !== 'running'.
 *    (Handles the case where task_notification events do arrive, e.g. Anthropic API.)
 */
/**
 * True for the thoughts hasActiveTeamTasks keys off: team spawns (Agent
 * tool_use with team_name) and TeamDelete calls. The session consumer carries
 * these across turn boundaries so team liveness survives between turns — a
 * team spawned in an earlier turn must keep blocking session rebuilds and
 * idle cleanup until it is disbanded.
 */
export function isTeamLifecycleThought(t: Thought): boolean {
  if (t.type !== 'tool_use') return false
  if (t.toolName === 'TeamDelete') return true
  return t.toolName === 'Agent' && !!(t.toolInput as Record<string, unknown>)?.team_name
}

export function hasActiveTeamTasks(thoughts: Thought[]): boolean {
  // Any team agents spawned at all?
  const hasTeamAgents = thoughts.some(
    t => t.type === 'tool_use'
      && t.toolName === 'Agent'
      && (t.toolInput as Record<string, unknown>)?.team_name
  )
  if (!hasTeamAgents) return false

  // Team exists — only done when TeamDelete succeeded.
  // TeamDelete is the authoritative "team done" signal:
  //   1. It requires all non-lead members to have shut down (isActive === false)
  //   2. It removes ~/.claude/teams/{name}/ (mailbox directory) — no more inbox messages
  //   3. It clears AppState.teamContext — useInboxPoller stops polling
  //   4. Therefore: the result after TeamDelete is the last autonomous result CC will produce
  //
  // BUG FIX: CC's TeamDeleteTool.mapToolResultToToolResultBlockParam wraps the
  // result as [{type:"text", text:"{\"success\":true,...}"}]. parseSDKMessage
  // serializes this array via JSON.stringify into toolResult.output. So we must
  // parse the outer array first, then parse the inner text to find success:true.
  const teamDisbanded = thoughts.some(t => {
    if (t.type !== 'tool_use' || t.toolName !== 'TeamDelete' || !t.toolResult) return false
    try {
      const parsed = JSON.parse(t.toolResult.output)
      // Direct object: {success: true, ...}
      if (parsed?.success === true) return true
      // CC's tool_result content array: [{type:"text", text:"{...}"}]
      if (Array.isArray(parsed)) {
        for (const block of parsed) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            try {
              if (JSON.parse(block.text)?.success === true) return true
            } catch { /* inner parse failure */ }
          }
        }
      }
      return false
    } catch { return false }
  })

  return !teamDisbanded

  // [COMMENTED OUT] Condition 2: taskProgress-based exit.
  // Previously, we also checked whether all Agent thoughts had taskProgress.status !== 'running'.
  // This fires too early — agents complete before the leader finishes shutdown/TeamDelete,
  // causing the do-while loop to break with unconsumed turns still in the CC subprocess.
  // Kept here for reference; the TeamDelete condition above is the sole reliable signal.
  //
  // return thoughts.some(
  //   t => t.type === 'tool_use'
  //     && t.toolName === 'Agent'
  //     && (t.toolInput as Record<string, unknown>)?.team_name
  //     && (!t.taskProgress || t.taskProgress.status === 'running')
  // )
}

// ============================================
// Sub-Agent Message Processing
// ============================================

/** Generate a unique thought ID */
function generateThoughtId(): string {
  return `thought-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

/**
 * Process a sub-agent SDK message (assistant or user with parent_tool_use_id).
 *
 * Sub-agent assistant messages contain tool_use blocks; sub-agent user messages
 * contain tool_result blocks. Unlike the main agent, these do NOT have
 * corresponding stream_event deltas — we parse the complete message directly.
 */
export function handleSubAgentMessage(
  sdkMessage: any,
  parentToolUseId: string,
  ctx: SubAgentContext
): void {
  const { spaceId, conversationId, sessionState, toolIdToThoughtId } = ctx
  const timestamp = new Date().toISOString()

  // Resolve SDK parent_tool_use_id to Halo thought ID so SubAgentTimeline
  // can match child thoughts by the parent Task thought's internal ID
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

        console.log(`[SubAgent][${conversationId}] tool_use: ${toolName} (parent=${resolvedParentId})`)
      }
      // Skip thinking/text blocks from sub-agents — they are internal
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

          console.log(`[SubAgent][${conversationId}] tool_result merged into ${toolUseThoughtId}`)
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
          console.log(`[SubAgent][${conversationId}] tool_result orphaned (parent=${parentToolUseId})`)
        }
      }
    }
  }
}

// ============================================
// Task Lifecycle Events
// ============================================

// [TEAM-DEBUG] Track timing of task lifecycle events relative to their arrival
const taskStartedAt = new Map<string, number>()  // taskId → timestamp

/**
 * Handle task_started event — associate taskId with the parent Task thought
 * and initialize its taskProgress.
 */
export function handleTaskStarted(
  msg: Record<string, unknown>,
  ctx: SubAgentContext
): void {
  const { spaceId, conversationId, sessionState } = ctx
  const taskId = msg.task_id as string
  const toolUseId = msg.tool_use_id as string | undefined

  // [TEAM-DEBUG] Record start time for duration tracking
  taskStartedAt.set(taskId, Date.now())
  console.log(`[TEAM-DEBUG][${conversationId}] task_started: taskId=${taskId} toolUseId=${toolUseId ?? 'none'} @ ${new Date().toISOString()}`)

  if (!toolUseId) return

  // Find the Task tool_use thought by matching the SDK tool_use_id
  // The toolIdToThoughtId map has SDK tool_use_id → Halo thought.id
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

    console.log(`[SubAgent][${conversationId}] task_started: ${taskId} → thought ${taskThought.id}`)
  } else {
    // [TEAM-DEBUG] No matching thought — toolIdToThoughtId mapping may be incomplete
    console.log(
      `[TEAM-DEBUG][${conversationId}] task_started: no thought found for toolUseId=${toolUseId}` +
      ` | toolIdToThoughtId size=${ctx.toolIdToThoughtId.size}`
    )
  }
}

/**
 * Handle task_progress event — update the Task thought's progress stats.
 */
export function handleTaskProgress(
  msg: Record<string, unknown>,
  ctx: SubAgentContext
): void {
  const { spaceId, conversationId, sessionState } = ctx
  const taskId = msg.task_id as string
  const usage = msg.usage as { total_tokens: number; tool_uses: number; duration_ms: number } | undefined

  // [TEAM-DEBUG] Log progress events so we can see their frequency relative to result
  const startedAt = taskStartedAt.get(taskId)
  const wallMs = startedAt ? Date.now() - startedAt : null
  console.log(
    `[TEAM-DEBUG][${conversationId}] task_progress: taskId=${taskId}` +
    ` lastTool=${String(msg.last_tool_name ?? '?')}` +
    ` tools=${usage?.tool_uses ?? 0} tokens=${usage?.total_tokens ?? 0}` +
    (wallMs !== null ? ` +${wallMs}ms` : '')
  )

  // Find the Task thought with matching taskProgress.taskId
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

/**
 * Handle task_notification event — mark the Task thought as completed/failed/stopped.
 */
export function handleTaskNotification(
  msg: Record<string, unknown>,
  ctx: SubAgentContext
): void {
  const { spaceId, conversationId, sessionState } = ctx
  const taskId = msg.task_id as string
  const status = (msg.status as string) ?? 'completed'
  const usage = msg.usage as { total_tokens: number; tool_uses: number; duration_ms: number } | undefined

  // [TEAM-DEBUG] Log timing relative to task_started
  const startedAt = taskStartedAt.get(taskId)
  const wallMs = startedAt ? Date.now() - startedAt : null
  console.log(
    `[TEAM-DEBUG][${conversationId}] task_notification: taskId=${taskId} status=${status}` +
    ` @ ${new Date().toISOString()}` +
    (wallMs !== null ? ` | wall-time since task_started: ${wallMs}ms` : ' | (no task_started recorded)')
  )
  // Clean up tracking entry
  taskStartedAt.delete(taskId)

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

    console.log(`[SubAgent][${conversationId}] task_notification: ${taskId} status=${status}`)
  } else {
    // [TEAM-DEBUG] Thought not found — task may have completed before task_started was processed
    console.log(
      `[TEAM-DEBUG][${conversationId}] task_notification: no thought found for taskId=${taskId}` +
      ` | thoughts with taskProgress: ${sessionState.thoughts.filter(t => t.taskProgress).length}`
    )
  }
}
