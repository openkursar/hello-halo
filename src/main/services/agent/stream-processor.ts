/**
 * Agent Module - Stream Processor
 *
 * Core stream processing logic extracted from send-message.ts.
 * Handles the V2 SDK session message stream including:
 * - Token-level streaming (text, thinking, tool_use blocks)
 * - Thought accumulation and tool result merging
 * - Session ID capture and MCP status broadcasting
 * - Token usage tracking
 * - Stream end handling with interrupt/error detection
 *
 * This module is caller-agnostic: both the main conversation agent
 * (send-message.ts) and the automation app runtime (execute.ts) use it,
 * providing caller-specific behavior via StreamCallbacks.
 */

import { is } from '@electron-toolkit/utils'
import { jsonrepair } from 'jsonrepair'
import { isDeveloperMode } from '../../foundation/logging'
import type {
  Thought,
  ToolCall,
  TokenUsage,
  SingleCallUsage,
  SessionState
} from './types'
import { emitAgentEvent } from './events'
import { parseSDKMessage } from './message-utils'
import { extractRealAssistantUsage, buildTokenUsage, isSyntheticAssistantMessage } from './context-usage'
import { broadcastMcpStatus } from './mcp-manager'
import {
  handleSubAgentMessage,
  handleTaskStarted,
  handleTaskProgress,
  handleTaskNotification,
  type SubAgentContext
} from './subagent-handler'
import { TRANSPARENT_TOOLS } from './constants'
import { analytics } from '../analytics/analytics.service'
import { AnalyticsEvents } from '../analytics/types'
import { deriveErrorCode } from '../analytics/error-code'

// Unified fallback error suffix - guides user to check logs
const FALLBACK_ERROR_HINT = 'Check logs in Settings > System > Logs.'

// ============================================
// Telemetry: tool usage aggregation
// ============================================

/**
 * Per-stream tool usage stats. Aggregated inside the stream-processor module so
 * that one `tool.usage_summary` event is emitted per `processStream` invocation
 * (one model-driven turn) regardless of which downstream caller (consumer-based
 * agent flow vs legacy automation flow) ends up firing `agent:complete`.
 */
interface ToolStats {
  toolCounts: Record<string, number>
  toolErrors: Record<string, number>
  startedAt: number
}

/** Keyed by conversationId. Cleared on flush; also guarded against leaks at processStream exit. */
const toolStatsMap = new Map<string, ToolStats>()

function getOrCreateToolStats(conversationId: string): ToolStats {
  let stats = toolStatsMap.get(conversationId)
  if (!stats) {
    stats = { toolCounts: {}, toolErrors: {}, startedAt: Date.now() }
    toolStatsMap.set(conversationId, stats)
  }
  return stats
}

function incrementToolCall(conversationId: string, toolName: string): void {
  if (!toolName) return
  const stats = getOrCreateToolStats(conversationId)
  stats.toolCounts[toolName] = (stats.toolCounts[toolName] ?? 0) + 1
}

function incrementToolError(conversationId: string, toolName: string | undefined): void {
  if (!toolName) return
  const stats = toolStatsMap.get(conversationId)
  if (!stats) return
  stats.toolErrors[toolName] = (stats.toolErrors[toolName] ?? 0) + 1
}

/**
 * Drain accumulated tool stats for a conversation and return them as a
 * privacy-shaped summary. Returns null when no calls were recorded.
 *
 * Defence-in-depth for user-attached MCP tools: tool names of the form
 * `mcp:<server-name>` are rewritten to `mcp:<redacted>` before leaving this
 * function. The formal mechanism is the SENSITIVE_KEYS gate on `mcpId`, but
 * tool names ride inside a nested array (`toolCalls[].name`), so the gate
 * cannot reach them — explicit redaction here is the belt-and-suspenders.
 */
export function flushToolStats(conversationId: string): {
  toolCalls: Array<{ name: string; count: number; errors: number }>
  totalCalls: number
  totalErrors: number
  durationMs: number
} | null {
  const stats = toolStatsMap.get(conversationId)
  if (!stats) return null
  toolStatsMap.delete(conversationId)

  const merged: Record<string, { count: number; errors: number }> = {}
  for (const [name, count] of Object.entries(stats.toolCounts)) {
    const redacted = name.startsWith('mcp:') ? 'mcp:<redacted>' : name
    if (!merged[redacted]) merged[redacted] = { count: 0, errors: 0 }
    merged[redacted].count += count
  }
  for (const [name, errors] of Object.entries(stats.toolErrors)) {
    const redacted = name.startsWith('mcp:') ? 'mcp:<redacted>' : name
    if (!merged[redacted]) merged[redacted] = { count: 0, errors: 0 }
    merged[redacted].errors += errors
  }

  const toolCalls = Object.entries(merged).map(([name, agg]) => ({
    name,
    count: agg.count,
    errors: agg.errors,
  }))
  const totalCalls = toolCalls.reduce((sum, t) => sum + t.count, 0)
  const totalErrors = toolCalls.reduce((sum, t) => sum + t.errors, 0)
  if (totalCalls === 0 && totalErrors === 0) return null

  return {
    toolCalls,
    totalCalls,
    totalErrors,
    durationMs: Date.now() - stats.startedAt,
  }
}

/**
 * Derive the telemetry `source` (and optional `appId`) for events emitted
 * from stream-processor. The agent service routes app-chat / im-reply
 * traffic through virtual conversationIds prefixed with `app-chat:`. When
 * the prefix is absent the stream is a normal interactive conversation.
 */
function deriveAnalyticsSource(conversationId: string): { source: 'agent' | 'app-chat'; appId?: string } {
  if (conversationId.startsWith('app-chat:')) {
    return { source: 'app-chat', appId: conversationId.slice('app-chat:'.length) }
  }
  return { source: 'agent' }
}

// ============================================
// Types
// ============================================

/**
 * Callbacks for caller-specific behavior (storage, JSONL writing, etc.)
 *
 * The stream processor handles all streaming logic and renderer events.
 * Callers provide callbacks for their specific needs:
 * - Main agent: persists to conversation.service, saves session ID
 * - Automation: writes to JSONL via session-store
 */
export interface StreamCallbacks {
  /** Called once when stream finishes — caller handles storage.
   *  Optional: consumer-based callers handle persistence externally. */
  onComplete?(result: StreamResult): void
  /** Called for each raw SDK message (for JSONL persistence in automation) */
  onRawMessage?(sdkMessage: any): void
  /** Called when continuing for an injected mid-turn message.
   *  Caller should persist the user message to the conversation between turns.
   *  @deprecated Used only by legacy do-while loop path. Consumer handles injection externally. */
  onInjectionContinue?(userMessage: string): void
  /** Called when CC emits `system:init` — signals the start of a new turn.
   *  Consumer uses this to create the assistant placeholder message.
   *  Fires once per stream() call (first system:init only). */
  onTurnInit?(): void
}

/**
 * Result returned when stream processing finishes.
 * Contains all data needed by callers for post-stream handling.
 */
export interface StreamResult {
  /** Final text content (last text block or streaming fallback) */
  finalContent: string
  /** Whether finalContent carries real text (non-whitespace). False when the
   *  content is only the empty-response repair placeholder injected by the
   *  openai-compat router. Consumers use this — not a raw truthiness check on
   *  finalContent — to decide error reporting, persistence, and IM replies. */
  hasMeaningfulContent: boolean
  /** Accumulated thoughts (thinking, tool_use, tool_result, text, error, etc.) */
  thoughts: Thought[]
  /** Token usage from the result message */
  tokenUsage: TokenUsage | null
  /** Captured session ID (from system/result messages, for session persistence) */
  capturedSessionId?: string
  /** Whether the stream was interrupted (no result message or error_during_execution) */
  isInterrupted: boolean
  /** Whether the user aborted via AbortController */
  wasAborted: boolean
  /** Whether an error thought was received (e.g., rate limit, auth failure) */
  hasErrorThought: boolean
  /** The error thought itself, if any */
  errorThought?: Thought
  /** Whether the session hit the SDK's maxTurns limit (error_max_turns subtype) */
  reachedMaxTurns: boolean
  /** Whether at least one event was received in this stream() call */
  firstEventReceived: boolean
  /** Whether the post-abort drain timed out without receiving a result.
   *  When true, the REPL pipe is dirty — the session must be closed and rebuilt.
   *  Consumer uses this to break its loop and trigger session rebuild. */
  drainTimedOut: boolean
}

/**
 * Parameters for processStream.
 * All data needed to process a V2 SDK session stream.
 */
export interface ProcessStreamParams {
  /** The V2 SDK session (already created by caller) */
  v2Session: any
  /** Session state (holds thoughts array — shared with session-manager) */
  sessionState: SessionState
  /** Space ID for renderer event routing */
  spaceId: string
  /** Conversation ID for renderer event routing (can be virtual like "app-chat:{appId}") */
  conversationId: string
  /** Already-prepared message content (string or multi-modal content blocks).
   *  Optional: when using session-consumer, the consumer's caller sends directly
   *  and processStream only consumes the stream. */
  messageContent?: string | Array<{ type: string; [key: string]: unknown }>
  /** Display model name for thought parsing (user's configured model, not SDK internal) */
  displayModel: string
  /** Source-resolved context window (same value injected into the CC subprocess).
   *  When provided, token-usage display uses it instead of guessing from the
   *  model name — keeps the UI window consistent with compaction behavior. */
  contextWindow?: number
  /** Abort controller for cancellation */
  abortController: AbortController
  /** Timestamp of send start (for timing logs) */
  t0: number
  /** Strategy callbacks for caller-specific behavior */
  callbacks: StreamCallbacks
}

// ============================================
// Stream Processor
// ============================================

/**
 * Process the message stream from a V2 SDK session.
 *
 * This is the core streaming engine shared by both the main conversation agent
 * and the automation app runtime. It handles:
 * - Sending the message to the session
 * - Processing all stream_event types (thinking, text, tool_use blocks with deltas)
 * - Processing non-stream SDK messages (assistant, user, system, result)
 * - Emitting renderer events via emitAgentEvent for real-time UI updates
 * - Token usage tracking (per-call and cumulative)
 * - Session ID capture from system/result messages
 * - MCP status broadcasting
 * - Stream end handling with the complete interrupt/error truth table
 *
 * @param params - All parameters needed for stream processing
 * @returns StreamResult with final content, thoughts, token usage, and status flags
 */
export async function processStream(params: ProcessStreamParams): Promise<StreamResult> {
  const {
    v2Session,
    sessionState,
    spaceId,
    conversationId,
    messageContent,
    displayModel,
    contextWindow,
    abortController,
    t0,
    callbacks
  } = params

  // Only keep track of the LAST text block as the final reply
  // Intermediate text blocks are shown in thought process, not accumulated into message bubble
  //
  // TODO: lastTextContent can be corrupted by dual-path state interference.
  //   The for-await loop processes both stream_events (token-level SSE) and SDK messages
  //   (complete assistant/result messages). Both paths write to lastTextContent and share
  //   the hadSubstantiveToolSinceLastText flag. When parseSDKMessage (message-utils.ts)
  //   skips tool_use blocks for assistant messages, the SDK message path's text handler
  //   resets hadSubstantiveToolSinceLastText without the corresponding tool_use ever
  //   setting it — corrupting the stream_event path's merge/overwrite logic.
  //
  //   Current impact: IM channels (app-chat.ts) now bypass this by extracting text
  //   directly from raw SDK messages (same principle as JSONL → AppChatView path).
  //   Halo UI uses frontend delta accumulation (unaffected).
  //   The main chat path (send-message.ts) persists finalContent via updateLastMessage —
  //   investigate whether this path is also affected under certain provider/adapter configs.
  //
  //   Root fix options:
  //   - Skip SDK message path writes to shared state when stream_events are active
  //   - Make parseSDKMessage return tool_use thoughts for assistant messages
  //   - Separate state tracking per path
  let lastTextContent = ''

  // Authoritative final content locked at the SDK result thought.
  // Set exactly once when the result message arrives. Unlike lastTextContent, this variable
  // is never touched after the result thought, so subsequent stream_events (e.g. a trailing
  // content_block_stop that re-fires after the result) cannot corrupt it.
  //
  // Note: this only protects against POST-result corruption. If lastTextContent is already
  // wrong at result time (due to the dual-path issue above), lockedFinalContent locks a bad value.
  // IM channels have a separate fix (see app-chat.ts lastAssistantText).
  let lockedFinalContent = ''

  let capturedSessionId: string | undefined

  // Token usage tracking
  // lastSingleUsage: Last API call usage (single call, represents current context size)
  let lastSingleUsage: SingleCallUsage | null = null
  let tokenUsage: TokenUsage | null = null

  // Telemetry: timestamp of the previous llm.invocation emit. Used to derive
  // PER-CALL durationMs (delta from the previous call's emit, or from t0 for
  // the first call) so dashboards see per-call latency rather than a
  // monotonically-increasing "elapsed since send" number.
  let lastInvocationEmitAt = t0
  // Telemetry: did we emit at least one `llm.invocation` (status: 'ok')
  // during this stream? Used to suppress a redundant `status: 'error'`
  // tail-emit when the turn ultimately aborts/interrupts AFTER one or
  // more successful invocations.
  let invocationOkEmitted = false
  // Telemetry: invocation pending its boundary flush. Engines split one API
  // response into several assistant frames sharing one message id; only one
  // frame (if any) carries real usage. Emission is therefore deferred to the
  // call boundary — the next assistant frame with a different id, or stream
  // end — so providers that never return usage still produce exactly one
  // `llm.invocation` per call (count must never be lost), with token fields
  // attached only when usage was observed.
  let pendingInvocation: { messageId: string | undefined; usage: SingleCallUsage | null } | null = null

  const flushPendingInvocation = (): void => {
    if (!pendingInvocation) return
    const now = Date.now()
    void analytics.track(AnalyticsEvents.LLM_INVOCATION, {
      ...deriveAnalyticsSource(conversationId),
      conversationId,
      modelName: displayModel,
      durationMs: now - lastInvocationEmitAt,
      status: 'ok',
      ...(pendingInvocation.usage && {
        inputTokens: pendingInvocation.usage.inputTokens,
        outputTokens: pendingInvocation.usage.outputTokens,
      }),
    })
    lastInvocationEmitAt = now
    invocationOkEmitted = true
    pendingInvocation = null
  }

  // Token-level streaming state
  let currentStreamingText = ''  // Accumulates text_delta tokens
  let isStreamingTextBlock = false  // True when inside a text content block
  const STREAM_THROTTLE_MS = 30  // Throttle updates to ~33fps

  // Track if SDK reported error_during_execution (for interrupted detection)
  let hadErrorDuringExecution = false
  // Track if SDK reported error_max_turns (session hit the configured maxTurns limit)
  let hadMaxTurnsReached = false
  // Track if we received a result message (for detecting stream interruption)
  let receivedResult = false

  // Silent drain mode: after abort, continue consuming events without emitting to UI,
  // until the result message arrives. This ensures the CC subprocess's REPL pipe is
  // fully drained before the consumer re-enters stream() for the next turn.
  // Without this, leftover drain events from the interrupted turn would be picked up
  // by the next turn, causing "responds to previous instruction" bugs.
  let drainStartTime: number | null = null
  const DRAIN_TIMEOUT_MS = 5_000  // Safety: force break if result never arrives

  // [TEAM-DEBUG] Diagnostic tracking for post-result stream behavior
  let resultReceivedAt: number | null = null  // Timestamp when first result arrived
  let postResultEventCount = 0               // Events received AFTER result
  let loopIterationCount = 0                 // Total loop iterations

  // Text block merge strategy:
  // AI sometimes splits its final reply across consecutive text blocks. We merge them.
  // A "substantive" tool_use breaks continuity — text before it is transitional
  // ("let me do X…") and should not appear in the final bubble.
  // TRANSPARENT_TOOLS are bookkeeping/coordination-only and do NOT break continuity.
  // See services/agent/constants.ts for the authoritative list.
  //
  // When true, the next text block overwrites; when false, it appends.
  let hadSubstantiveToolSinceLastText = false

  // Streaming block state - track active blocks by index for delta/stop correlation
  // Key: block index, Value: { type, thoughtId, content/partialJson }
  const streamingBlocks = new Map<number, {
    type: 'thinking' | 'tool_use'
    thoughtId: string
    content: string  // For thinking: accumulated thinking text, for tool_use: accumulated partial JSON
    toolName?: string
    toolId?: string
  }>()

  // Tool ID to Thought ID mapping - for merging tool_result into tool_use
  const toolIdToThoughtId = new Map<string, string>()

  const t1 = Date.now()

  // Send the message if provided (legacy callers pass messageContent;
  // consumer-based callers send directly and pass no messageContent).
  if (messageContent != null) {
    console.log(`[Agent][${conversationId}] Sending message to V2 session...`)
    if (typeof messageContent === 'string') {
      v2Session.send(messageContent)
    } else {
      const userMessage = {
        type: 'user' as const,
        message: {
          role: 'user' as const,
          content: messageContent
        }
      }
      v2Session.send(userMessage as any)
    }
  } else {
    console.log(`[Agent][${conversationId}] Consuming stream (no send — consumer mode)...`)
  }

  // Track whether any event was received in this stream() call
  let firstEventFired = false
  // Track whether onTurnInit has been called (once per stream() call)
  let turnInitFired = false

  // Stream messages from V2 session
  // Single-turn stream consumption: process events until stream() completes.
  // The consumer's outer loop handles turn boundaries and re-entering stream().
  for await (const sdkMessage of v2Session.stream()) {
    loopIterationCount++

    // Track first event for no-event detection
    if (!firstEventFired) {
      firstEventFired = true
    }

    // Detect CC's system:init — the official turn boundary signal.
    // Fires once per stream() call; consumer uses this to create assistant placeholder.
    if (!turnInitFired && sdkMessage.type === 'system' && (sdkMessage as any).subtype === 'init') {
      turnInitFired = true
      if (callbacks.onTurnInit) {
        callbacks.onTurnInit()
      }
    }

    // Handle abort — enter silent drain mode instead of breaking immediately.
    // CC subprocess's interrupt() produces a result (error_during_execution) that MUST
    // be consumed. Breaking here would leave it in the pipe, corrupting the next turn.
    if (abortController.signal.aborted) {
      if (!drainStartTime) {
        drainStartTime = Date.now()
        console.log(`[Agent][${conversationId}] Aborted — entering silent drain mode`)
      }

      // Safety timeout: if CC never produces a result (crash, bug), force break
      if (Date.now() - drainStartTime > DRAIN_TIMEOUT_MS) {
        console.warn(`[Agent][${conversationId}] Drain timeout (${DRAIN_TIMEOUT_MS}ms), force breaking`)
        break
      }

      // Consume the result and exit cleanly
      if (sdkMessage.type === 'result') {
        receivedResult = true
        hadErrorDuringExecution = true
        // Extract session ID for persistence
        const msg = sdkMessage as Record<string, unknown>
        if (!capturedSessionId) {
          const sessionIdFromMsg = msg.session_id || (msg.message as Record<string, unknown>)?.session_id
          capturedSessionId = sessionIdFromMsg as string
        }
        // Extract token usage
        tokenUsage = buildTokenUsage(msg, lastSingleUsage, displayModel, contextWindow)
        console.log(`[Agent][${conversationId}] Drain complete — result consumed after ${Date.now() - drainStartTime}ms`)
        break
      }

      // Skip all processing (no UI events, no thought accumulation) — just drain
      continue
    }

    // [TEAM-DEBUG] Log every message that arrives AFTER result to understand SDK stream lifecycle
    if (resultReceivedAt !== null) {
      const msSinceResult = Date.now() - resultReceivedAt
      const subtype = (sdkMessage as any).subtype ?? ''
      const parentId = (sdkMessage as any).parent_tool_use_id ?? null
      postResultEventCount++
      console.log(
        `[TEAM-DEBUG][${conversationId}] POST-RESULT event #${postResultEventCount}` +
        ` +${msSinceResult}ms | type=${sdkMessage.type}${subtype ? ` subtype=${subtype}` : ''}` +
        `${parentId ? ` parent=${String(parentId).slice(0, 8)}` : ''}`
      )
    }

    // Notify caller of raw SDK message (for JSONL persistence in automation)
    if (callbacks.onRawMessage) {
      callbacks.onRawMessage(sdkMessage)
    }

    // Handle stream_event for token-level streaming (text only)
    if (sdkMessage.type === 'stream_event') {
      const event = (sdkMessage as any).event
      if (!event) continue

      // DEBUG: Log all stream events with timestamp (ms since send)
      // Uses console.debug — only written to file when Developer Mode is enabled.
      // Guard JSON.stringify with isDeveloperMode() to avoid compute on hot path when disabled.
      if (isDeveloperMode()) {
        const elapsed = Date.now() - t1
        if (event.type === 'message_start') {
          console.debug(`[Agent][${conversationId}] +${elapsed}ms message_start:`, JSON.stringify(event))
        } else {
          console.debug(`[Agent][${conversationId}] +${elapsed}ms stream_event: type=${event.type}, index=${event.index}`)
        }
      }

      // Text block started
      if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
        isStreamingTextBlock = true
        const blockText = event.content_block.text || ''

        if (hadSubstantiveToolSinceLastText) {
          // A substantive tool occurred — previous text was transitional, start fresh
          currentStreamingText = blockText
          hadSubstantiveToolSinceLastText = false
        } else {
          // Consecutive text block (or only transparent tools in between) — append
          if (currentStreamingText) {
            currentStreamingText += '\n\n' + blockText
          } else {
            currentStreamingText = blockText
          }
        }

        // 🔑 Send precise signal for new text block (fixes truncation bug)
        // This is 100% reliable - comes directly from SDK's content_block_start event
        emitAgentEvent('agent:message', spaceId, conversationId, {
          type: 'message',
          content: '',
          isComplete: false,
          isStreaming: false,
          isNewTextBlock: true  // Signal: new text block started
        })

      }

      // ========== Thinking block streaming ==========
      // Thinking block started - send empty thought immediately
      if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
        const blockIndex = event.index ?? 0
        const thoughtId = `thought-thinking-${Date.now()}-${blockIndex}`

        // Track this block for delta correlation
        streamingBlocks.set(blockIndex, {
          type: 'thinking',
          thoughtId,
          content: ''
        })

        // Create and send streaming thought immediately
        const thought: Thought = {
          id: thoughtId,
          type: 'thinking',
          content: '',
          timestamp: new Date().toISOString(),
          isStreaming: true
        }

        // Add to session state
        sessionState.thoughts.push(thought)

        // Send to renderer for immediate display
        emitAgentEvent('agent:thought', spaceId, conversationId, { thought })
      }

      // Thinking delta - append to thought content
      if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
        const blockIndex = event.index ?? 0
        const blockState = streamingBlocks.get(blockIndex)

        if (blockState && blockState.type === 'thinking') {
          const delta = event.delta.thinking || ''
          blockState.content += delta

          // Send delta to renderer for incremental update
          emitAgentEvent('agent:thought-delta', spaceId, conversationId, {
            thoughtId: blockState.thoughtId,
            delta,
            content: blockState.content  // Also send full content for fallback
          })
        }
      }

      // Text delta - accumulate locally, send delta to frontend
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && isStreamingTextBlock) {
        const delta = event.delta.text || ''
        currentStreamingText += delta

        // Send delta immediately without throttling
        emitAgentEvent('agent:message', spaceId, conversationId, {
          type: 'message',
          delta,
          isComplete: false,
          isStreaming: true
        })
      }

      // ========== Tool use block streaming ==========
      // Tool use block started - send thought with tool name immediately
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        const blockIndex = event.index ?? 0
        const toolId = event.content_block.id || `tool-${Date.now()}`
        const toolName = event.content_block.name || 'Unknown'
        const thoughtId = `thought-tool-${Date.now()}-${blockIndex}`

        // Mark substantive tool — breaks text continuity (transparent tools like TodoWrite do not)
        if (!TRANSPARENT_TOOLS.has(toolName)) {
          hadSubstantiveToolSinceLastText = true
        }

        // Track this block for delta correlation
        streamingBlocks.set(blockIndex, {
          type: 'tool_use',
          thoughtId,
          content: '',  // Will accumulate partial JSON
          toolName,
          toolId
        })

        // Create and send streaming tool thought immediately
        const thought: Thought = {
          id: thoughtId,
          type: 'tool_use',
          content: '',
          timestamp: new Date().toISOString(),
          toolName,
          toolInput: {},  // Empty initially, will be populated on stop
          isStreaming: true,
          isReady: false  // Params not complete yet
        }

        // Add to session state
        sessionState.thoughts.push(thought)

        // Send to renderer for immediate display (shows tool name + preparing state)
        emitAgentEvent('agent:thought', spaceId, conversationId, { thought })

        // Agent Team: detect Agent tool_use with name + team_name (team mode spawn)
        // Note: full input JSON is not available yet at content_block_start,
        // so team spawn detection is deferred to content_block_stop when input is parsed.
        // We track the toolId here so we can check when the block completes.
      }

      // Tool use input JSON delta - accumulate partial JSON
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        const blockIndex = event.index ?? 0
        const blockState = streamingBlocks.get(blockIndex)

        if (blockState && blockState.type === 'tool_use') {
          const partialJson = event.delta.partial_json || ''
          blockState.content += partialJson

          // Send delta to renderer (for progress indication, not for parsing)
          emitAgentEvent('agent:thought-delta', spaceId, conversationId, {
            thoughtId: blockState.thoughtId,
            delta: partialJson,
            isToolInput: true  // Flag: this is tool input JSON, not thinking text
          })
        }
      }

      // ========== Block stop handling ==========
      // content_block_stop - finalize streaming blocks
      if (event.type === 'content_block_stop') {
        const blockIndex = event.index ?? 0
        const blockState = streamingBlocks.get(blockIndex)

        if (blockState) {
          if (blockState.type === 'thinking') {
            // Thinking block complete - send final state
            emitAgentEvent('agent:thought-delta', spaceId, conversationId, {
              thoughtId: blockState.thoughtId,
              content: blockState.content,
              isComplete: true  // Signal: thinking is complete
            })

            // Update session state thought
            const thought = sessionState.thoughts.find((t: Thought) => t.id === blockState.thoughtId)
            if (thought) {
              thought.content = blockState.content
              thought.isStreaming = false
            }

            console.log(`[Agent][${conversationId}] Thinking block complete, length: ${blockState.content.length}`)
          } else if (blockState.type === 'tool_use') {
            // Tool use block complete - parse JSON and send final state
            let toolInput: Record<string, unknown> = {}
            try {
              if (blockState.content) {
                toolInput = JSON.parse(blockState.content)
              }
            } catch (e) {
              // Attempt repair for malformed JSON from LLMs (e.g. missing closing braces)
              try {
                toolInput = JSON.parse(jsonrepair(blockState.content))
                console.warn(`[Agent][${conversationId}] Repaired malformed tool input JSON for ${blockState.toolName} (${blockState.content.length} chars)`)
              } catch {
                console.error(`[Agent][${conversationId}] Failed to parse tool input JSON (${blockState.content.length} chars), raw: ${blockState.content}`, e)
              }
            }

            // Record mapping for merging tool_result later
            if (blockState.toolId) {
              toolIdToThoughtId.set(blockState.toolId, blockState.thoughtId)
            }

            // Send complete signal with parsed input
            emitAgentEvent('agent:thought-delta', spaceId, conversationId, {
              thoughtId: blockState.thoughtId,
              toolInput,
              isComplete: true,  // Signal: tool params are complete
              isReady: true,     // Tool is ready for execution
              isToolInput: true  // Flag: this is tool input completion (triggers isReady update in frontend)
            })

            // Update session state thought
            const thought = sessionState.thoughts.find((t: Thought) => t.id === blockState.thoughtId)
            if (thought) {
              thought.toolInput = toolInput
              thought.isStreaming = false
              thought.isReady = true
            }

            // Send tool-call event for tool approval/tracking
            // This replaces the event that was previously sent from parseSDKMessage
            const toolCall: ToolCall = {
              id: blockState.toolId || blockState.thoughtId,
              name: blockState.toolName || '',
              status: 'running',
              input: toolInput
            }
            emitAgentEvent('agent:tool-call', spaceId, conversationId, toolCall as unknown as Record<string, unknown>)
            // Telemetry: track tool usage; mcp:* names are redacted at flush time.
            incrementToolCall(conversationId, blockState.toolName || '')

            if (is.dev) {
              console.log(`[Agent][${conversationId}] Tool block complete [${blockState.toolName}], input: ${JSON.stringify(toolInput).substring(0, 100)}`)
            }
          }

          // Clean up tracking state
          streamingBlocks.delete(blockIndex)
        }

        // Handle text block stop (existing logic)
        if (isStreamingTextBlock) {
          isStreamingTextBlock = false
          // Send final content of this block (full accumulated text including merged blocks)
          emitAgentEvent('agent:message', spaceId, conversationId, {
            type: 'message',
            content: currentStreamingText,
            isComplete: false,
            isStreaming: false
          })
          // Update lastTextContent — currentStreamingText already contains merged consecutive blocks
          lastTextContent = currentStreamingText
          console.log(`[Agent][${conversationId}] Text block completed, length: ${currentStreamingText.length}`)
        }
      }

      continue  // stream_event handled, skip normal processing
    }

    // ========== Sub-agent message routing ==========
    // SDK emits sub-agent assistant/user messages with parent_tool_use_id set.
    // Route these to the dedicated handler — they must NOT enter the main agent
    // processing path (which expects stream_event-created tool_use thoughts).
    const parentToolUseId = (sdkMessage as any).parent_tool_use_id as string | null | undefined
    if (parentToolUseId != null && (sdkMessage.type === 'assistant' || sdkMessage.type === 'user')) {
      const subCtx: SubAgentContext = { spaceId, conversationId, sessionState, toolIdToThoughtId }
      handleSubAgentMessage(sdkMessage, parentToolUseId, subCtx)
      continue  // Sub-agent message handled, skip main processing
    }

    // DEBUG: Log all SDK messages with timestamp
    const elapsed = Date.now() - t1
    console.log(`[Agent] SDK messages [${conversationId}] 🔵 +${elapsed}ms ${sdkMessage.type}:`,
      JSON.stringify(sdkMessage, null, 2)
    )

    // Capture per-call usage from real assistant messages (represents current
    // context size). Synthetic messages (interrupt/cancel/reject) are skipped
    // entirely — they are bookkeeping, not API calls, and must neither
    // overwrite the last real usage nor open/flush a pending invocation.
    if (sdkMessage.type === 'assistant' && !isSyntheticAssistantMessage(sdkMessage)) {
      const messageId = (sdkMessage as { message?: { id?: string } }).message?.id
      // A frame with a different message id signals the previous API call's
      // boundary — flush it (with or without observed usage).
      if (pendingInvocation && pendingInvocation.messageId !== messageId) {
        flushPendingInvocation()
      }
      if (!pendingInvocation) {
        pendingInvocation = { messageId, usage: null }
      }
      const usage = extractRealAssistantUsage(sdkMessage)
      if (usage) {
        lastSingleUsage = usage
        pendingInvocation.usage = usage
      }
    }

    // Parse SDK message into Thought and send to renderer
    // Pass credentials.model to display the user's actual configured model
    const thought = parseSDKMessage(sdkMessage, displayModel)

    if (thought) {
      // Handle tool_result specially - merge into corresponding tool_use thought
      if (thought.type === 'tool_result') {
        const toolUseThoughtId = toolIdToThoughtId.get(thought.id)
        if (toolUseThoughtId) {
          // Found corresponding tool_use - merge result into it
          const toolResult = {
            output: thought.toolOutput || '',
            isError: thought.isError || false,
            timestamp: thought.timestamp
          }

          // Update backend session state
          const toolUseThought = sessionState.thoughts.find((t: Thought) => t.id === toolUseThoughtId)
          if (toolUseThought) {
            toolUseThought.toolResult = toolResult
          }

          // Send thought-delta to merge result into tool_use on frontend
          emitAgentEvent('agent:thought-delta', spaceId, conversationId, {
            thoughtId: toolUseThoughtId,
            toolResult,
            isToolResult: true  // Flag: this is a tool result merge
          })

          // Still send tool-result event for any listeners
          emitAgentEvent('agent:tool-result', spaceId, conversationId, {
            type: 'tool_result',
            toolId: thought.id,
            result: thought.toolOutput || '',
            isError: thought.isError || false
          })
          // Telemetry: count tool errors by the original tool's name (looked up
          // via the tool_use thought, since tool_result thoughts don't carry the name).
          if (thought.isError) {
            incrementToolError(conversationId, toolUseThought?.toolName)
          }

          console.log(`[Agent][${conversationId}] Tool result merged into thought ${toolUseThoughtId}`)
        } else {
          // No mapping found - fall back to separate thought (shouldn't happen normally)
          sessionState.thoughts.push(thought)
          emitAgentEvent('agent:thought', spaceId, conversationId, { thought })
          emitAgentEvent('agent:tool-result', spaceId, conversationId, {
            type: 'tool_result',
            toolId: thought.id,
            result: thought.toolOutput || '',
            isError: thought.isError || false
          })
          // Telemetry: fallback path — name may be on the thought itself.
          if (thought.isError) {
            incrementToolError(conversationId, thought.toolName)
          }
          console.log(`[Agent][${conversationId}] Tool result fallback (no mapping): ${thought.id}`)
        }
      } else {
        // Non tool_result thoughts - handle normally
        // Accumulate thought in backend session (Single Source of Truth)
        sessionState.thoughts.push(thought)

        // Send ALL thoughts to renderer for real-time display in thought process area
        // This includes text blocks - they appear in the timeline during generation
        emitAgentEvent('agent:thought', spaceId, conversationId, { thought })

        // Handle specific thought types
        if (thought.type === 'text') {
          // Merge consecutive text blocks: append if no substantive tool in between
          if (hadSubstantiveToolSinceLastText || !lastTextContent) {
            lastTextContent = thought.content
            hadSubstantiveToolSinceLastText = false
          } else {
            // Consecutive text (or only transparent tools like TodoWrite in between) — append
            lastTextContent += '\n\n' + thought.content
          }

          // Send streaming update - frontend shows this during generation
          emitAgentEvent('agent:message', spaceId, conversationId, {
            type: 'message',
            content: lastTextContent,
            isComplete: false
          })
        } else if (thought.type === 'tool_use') {
          // Mark substantive tool — breaks text continuity
          if (!TRANSPARENT_TOOLS.has(thought.toolName || '')) {
            hadSubstantiveToolSinceLastText = true
          }
          // Send tool call event
          const toolCall: ToolCall = {
            id: thought.id,
            name: thought.toolName || '',
            status: 'running',
            input: thought.toolInput || {}
          }
          emitAgentEvent('agent:tool-call', spaceId, conversationId, toolCall as unknown as Record<string, unknown>)
          // Telemetry: track tool usage (non-stream_event path, e.g. assistant SDK messages).
          incrementToolCall(conversationId, thought.toolName || '')
        } else if (thought.type === 'error') {
          // SDK reported an error (rate_limit, authentication_failed, etc.)
          // Send error to frontend - user should see the actual error from provider
          console.log(`[Agent][${conversationId}] Error thought received: ${thought.content}`)
          emitAgentEvent('agent:error', spaceId, conversationId, {
            type: 'error',
            error: thought.content,
            errorCode: thought.errorCode  // Preserve error code for debugging
          })
        } else if (thought.type === 'result') {
          // Final result - use the last text block as the final reply
          const finalContent = lastTextContent || thought.content
          // Lock the final content now. lastTextContent is correct at this moment, but the stream
          // loop may continue after the result thought and overwrite it with trailing events.
          // lockedFinalContent captures the value here and is never written again.
          lockedFinalContent = finalContent
          emitAgentEvent('agent:message', spaceId, conversationId, {
            type: 'message',
            content: finalContent,
            isComplete: true
          })
          // Fallback: if no text block was received, use result content for persistence
          if (!lastTextContent && thought.content) {
            lastTextContent = thought.content
          }
          // Note: updateLastMessage is called after loop to include tokenUsage
          console.log(`[Agent][${conversationId}] Result thought received, ${sessionState.thoughts.length} thoughts accumulated`)
        }
      }
    }

    // Capture session ID and MCP status from system/result messages
    // Use type assertion for SDK message properties that may vary
    const msg = sdkMessage as Record<string, unknown>
    if (sdkMessage.type === 'system') {
      const subtype = msg.subtype as string | undefined
      const sessionIdFromMsg = msg.session_id || (msg.message as Record<string, unknown>)?.session_id
      if (sessionIdFromMsg) {
        capturedSessionId = sessionIdFromMsg as string
        console.log(`[Agent][${conversationId}] Captured session ID:`, capturedSessionId)
      }

      // Handle compact_boundary - context compression notification
      if (subtype === 'compact_boundary') {
        const compactMetadata = msg.compact_metadata as { trigger: 'manual' | 'auto'; pre_tokens: number } | undefined
        if (compactMetadata) {
          console.log(`[Agent][${conversationId}] Context compressed: trigger=${compactMetadata.trigger}, pre_tokens=${compactMetadata.pre_tokens}`)
          // Send compact notification to renderer
          emitAgentEvent('agent:compact', spaceId, conversationId, {
            type: 'compact',
            trigger: compactMetadata.trigger,
            preTokens: compactMetadata.pre_tokens
          })
        }
      }

      // Extract MCP server status and tools list from system message
      // SDKSystemMessage includes mcp_servers: { name: string; status: string }[]
      // and tools: string[] (flat list of all available tool names)
      const mcpServers = msg.mcp_servers as Array<{ name: string; status: string }> | undefined
      const tools = msg.tools as string[] | undefined

      if (mcpServers && mcpServers.length > 0) {
        if (is.dev) {
          console.log(`[Agent][${conversationId}] MCP server status:`, JSON.stringify(mcpServers))
          if (tools) console.log(`[Agent][${conversationId}] Available tools: ${tools.length}`)
        }
        // Broadcast MCP status + tools to frontend (global event, not conversation-specific)
        broadcastMcpStatus(mcpServers, tools)
      }

      // Task lifecycle events — update sub-agent progress + forward to Agent Team
      if (subtype === 'task_started' || subtype === 'task_progress' || subtype === 'task_notification') {
        const subCtx: SubAgentContext = { spaceId, conversationId, sessionState, toolIdToThoughtId }

        // Update the Task thought's taskProgress for sub-agent timeline display
        if (subtype === 'task_started') {
          handleTaskStarted(msg, subCtx)
        } else if (subtype === 'task_progress') {
          handleTaskProgress(msg, subCtx)
        } else {
          handleTaskNotification(msg, subCtx)
        }
      }

      // Forward slash_commands / skills / agents to renderer for input autocomplete.
      // These are only present on the init subtype message.
      if (subtype === 'init') {
        const sdkSlashCommands = msg.slash_commands as string[] | undefined
        const sdkSkills = msg.skills as string[] | undefined
        const sdkAgents = msg.agents as string[] | undefined
        if (sdkSlashCommands || sdkSkills || sdkAgents) {
          emitAgentEvent('agent:session-info', spaceId, conversationId, {
            slashCommands: sdkSlashCommands ?? [],
            skills: sdkSkills ?? [],
            agents: sdkAgents ?? []
          })
        }
      }
    } else if (sdkMessage.type === 'result') {
      receivedResult = true  // Mark that we received a result message
      resultReceivedAt = Date.now()

      // [TEAM-DEBUG] Snapshot active team agents at result time
      const teamThoughts = sessionState.thoughts.filter(
        t => t.type === 'tool_use' && t.toolName === 'Agent' && (t.toolInput as any)?.team_name
      )
      if (teamThoughts.length > 0) {
        const summary = teamThoughts.map(t =>
          `${(t.toolInput as any)?.name ?? '?'}(${t.taskProgress?.status ?? 'no-task-started'})`
        ).join(', ')
        console.log(
          `[TEAM-DEBUG][${conversationId}] result received at iteration #${loopIterationCount}` +
          ` | team agents: [${summary}]` +
          ` | subtype=${(sdkMessage as any).subtype ?? 'success'}`
        )
      } else {
        console.log(
          `[TEAM-DEBUG][${conversationId}] result received at iteration #${loopIterationCount}` +
          ` | no team agents in session` +
          ` | subtype=${(sdkMessage as any).subtype ?? 'success'}`
        )
      }

      if (!capturedSessionId) {
        const sessionIdFromMsg = msg.session_id || (msg.message as Record<string, unknown>)?.session_id
        capturedSessionId = sessionIdFromMsg as string
      }

      // Check for error_during_execution (interrupted) vs real errors
      // Note: Real API errors (is_error=true) are already handled by parseSDKMessage above
      // which creates an error thought and triggers agent:error via the thought.type === 'error' branch
      const isError = (sdkMessage as any).is_error === true
      if (isError) {
        const errors = (sdkMessage as any).errors as unknown[] | undefined
        console.log(`[Agent][${conversationId}] ⚠️ SDK error (is_error=${isError}, errors=${errors?.length || 0}): ${((sdkMessage as any).result || '').substring(0, 200)}`)
      } else if ((sdkMessage as any).subtype === 'error_during_execution') {
        // Mark as interrupted - will be used for empty response handling
        hadErrorDuringExecution = true
        console.log(`[Agent][${conversationId}] SDK result subtype=error_during_execution but is_error=false, errors=[] - marked as interrupted`)
      } else if ((sdkMessage as any).subtype === 'error_max_turns') {
        // Session hit the configured maxTurns limit - this is a graceful SDK termination,
        // not an error. Track it so we can show a clear message instead of "empty response".
        hadMaxTurnsReached = true
        console.log(`[Agent][${conversationId}] SDK result subtype=error_max_turns, num_turns=${(sdkMessage as any).num_turns} - session reached turn limit`)
      }

      // Extract token usage from result message
      tokenUsage = buildTokenUsage(msg, lastSingleUsage, displayModel, contextWindow)
      if (tokenUsage) {
        console.log(`[Agent][${conversationId}] Token usage (single API):`, tokenUsage)
      }
    }
  }

  // ========== Stream End Handling ==========
  //
  // Error conditions (truth table):
  // | Case | hasContent | isInterrupted | hasErrorThought | wasAborted | reachedMaxTurns | Send error?      |
  // |------|------------|---------------|-----------------|------------|-----------------|------------------|
  // | 1a   | yes        | -             | -               | yes        | -               | stopped by user  |
  // | 1b   | yes        | yes           | -               | no         | -               | interrupted      |
  // | 2    | yes        | no            | -               | no         | -               | no               |
  // | 3    | no         | yes           | no              | no         | -               | interrupted      |
  // | 4    | no         | no            | no              | no         | no              | empty response   |
  // | 5    | no         | -             | yes             | -          | -               | no               |
  // | 6    | no         | -             | -               | yes        | -               | no               |
  // | 7    | no         | no            | no              | no         | yes             | max turns notice |

  // Prefer lockedFinalContent (captured at result thought, immune to post-result stream mutations).
  // Fall back to lastTextContent for interrupted streams that never reach a result thought,
  // then to currentStreamingText for streams that ended mid-block without a text_block_stop.
  const finalContent = lockedFinalContent || lastTextContent || currentStreamingText || ''
  // Whitespace-only content is the repair placeholder injected by the
  // openai-compat router when the provider returned an empty response. Treat
  // it as empty for error reporting so the user still sees the empty-response
  // notice — while the placeholder keeps the session transcript valid, so
  // continuing the conversation works.
  const hasMeaningfulContent = finalContent.trim().length > 0
  const wasAborted = abortController.signal.aborted
  const hasErrorThought = sessionState.thoughts.some((t: Thought) => t.type === 'error')
  // Two independent interrupt reasons: SDK reported error_during_execution, or stream ended unexpectedly
  const isInterrupted = !receivedResult || hadErrorDuringExecution

  // Find the error thought for callers
  const errorThought = hasErrorThought
    ? sessionState.thoughts.find((t: Thought) => t.type === 'error')
    : undefined

  // Log content source for debugging. Gate on meaningful content so the
  // repair placeholder (whitespace-only) is logged as "no content", matching
  // the error-reporting and persistence decisions below.
  if (hasMeaningfulContent) {
    const contentSource = lockedFinalContent
      ? 'lockedFinalContent'
      : lastTextContent
        ? 'lastTextContent'
        : 'currentStreamingText (fallback)'
    console.log(`[Agent][${conversationId}] Stream content from ${contentSource}: ${finalContent.length} chars`)
  } else {
    console.log(`[Agent][${conversationId}] No content from stream`)
  }
  if (hasErrorThought) {
    console.log(`[Agent][${conversationId}] Error thought present: ${errorThought?.content}`)
  }

  // Build the result object
  const result: StreamResult = {
    finalContent,
    hasMeaningfulContent,
    thoughts: sessionState.thoughts,
    tokenUsage,
    capturedSessionId,
    isInterrupted,
    wasAborted,
    hasErrorThought,
    errorThought,
    reachedMaxTurns: hadMaxTurnsReached,
    firstEventReceived: firstEventFired,
    drainTimedOut: wasAborted && drainStartTime !== null && !receivedResult,
  }

  const turnDurationMs = Date.now() - t0
  if (isInterrupted || hasErrorThought || wasAborted) {
    const errorSummary = String((errorThought?.content as unknown) ?? '').slice(0, 300).replace(/"/g, "'")
    console.log(`[Agent] turn_error conv=${conversationId} duration_ms=${turnDurationMs} aborted=${wasAborted} interrupted=${isInterrupted} hasErrorThought=${hasErrorThought} maxTurns=${hadMaxTurnsReached} content_len=${finalContent.length} error="${errorSummary}"`)
  } else {
    console.log(`[Agent] turn_end conv=${conversationId} duration_ms=${turnDurationMs} content_len=${finalContent.length} tokens_in=${tokenUsage?.inputTokens ?? 0} tokens_out=${tokenUsage?.outputTokens ?? 0} cache_read=${tokenUsage?.cacheReadTokens ?? 0} cache_creation=${tokenUsage?.cacheCreationTokens ?? 0}`)
  }

  // Notify caller for storage handling (optional — consumer-based callers
  // handle persistence externally, legacy callers like app-chat.ts use this)
  if (callbacks.onComplete) {
    callbacks.onComplete(result)
  }

  // Emit agent:complete for legacy callers that don't use the consumer.
  // Consumer-based callers emit agent:complete themselves after persistence.
  // Legacy callers are identified by providing messageContent (they own the full lifecycle).
  if (messageContent != null) {
    emitAgentEvent('agent:complete', spaceId, conversationId, {
      type: 'complete',
      duration: 0,
      tokenUsage
    })
  }

  // Determine if interrupted error should be sent
  const getInterruptedErrorMessage = (): string | null => {
    if (hasMeaningfulContent) {
      // Has content: user aborted shows friendly message, other interrupts show warning
      if (wasAborted) return 'Stopped by user.'
      return isInterrupted ? 'Model response interrupted unexpectedly.' : null
    } else {
      // No content: skip if already has error thought or user aborted
      if (hasErrorThought || wasAborted) return null
      // Max turns is a graceful SDK limit, not a crash — show a clear actionable message
      if (hadMaxTurnsReached) return 'Reached the maximum turn limit. Send a message to continue.'
      return isInterrupted
        ? 'Model response interrupted unexpectedly.'
        : `Unexpected empty response. ${FALLBACK_ERROR_HINT}`
    }
  }

  const errorMessage = getInterruptedErrorMessage()
  if (errorMessage) {
    const reason = hadMaxTurnsReached
      ? 'max_turns'
      : isInterrupted
        ? (hadErrorDuringExecution ? 'error_during_execution' : 'stream interrupted')
        : 'empty response'
    console.log(`[Agent][${conversationId}] Sending interrupted error (${reason}, content: ${hasMeaningfulContent ? 'yes' : 'no'})`)
    emitAgentEvent('agent:error', spaceId, conversationId, {
      type: 'error',
      errorType: 'interrupted',
      error: errorMessage
    })
  } else if (wasAborted) {
    console.log(`[Agent][${conversationId}] User stopped - no error sent`)
  }

  // Telemetry: flush the last API call of this stream. Mid-stream calls flush
  // at the next call's boundary; the final one has no successor, so it flushes
  // here. This also covers providers that never return usage — the count is
  // preserved even when token fields are absent.
  flushPendingInvocation()

  // Telemetry: drain tool usage stats for this stream. Emitting here covers
  // both legacy callers (who get agent:complete via line 963 above) and
  // consumer-based callers (who emit agent:complete externally after persistence)
  // — every processStream call results in at most one tool.usage_summary
  // event, and the stats map can never leak entries.
  const toolSummary = flushToolStats(conversationId)
  if (toolSummary) {
    void analytics.track(AnalyticsEvents.TOOL_USAGE_SUMMARY, {
      ...deriveAnalyticsSource(conversationId),
      conversationId,
      ...toolSummary,
    })
  }
  // Telemetry: on error/interrupt paths where no successful invocation was
  // ever emitted in this stream (e.g. session crashed before any assistant
  // message), surface a single failed invocation so the dashboard reflects
  // the attempt. Suppress when an `ok` was already emitted — an abort that
  // hits AFTER successful invocations does not retroactively turn those
  // calls into failures, and double-emitting `ok` + `error` for the same
  // turn with no turnId would corrupt dashboard aggregates.
  if (!invocationOkEmitted && (hasErrorThought || isInterrupted || wasAborted)) {
    void analytics.track(AnalyticsEvents.LLM_INVOCATION, {
      ...deriveAnalyticsSource(conversationId),
      conversationId,
      modelName: displayModel,
      durationMs: Date.now() - lastInvocationEmitAt,
      status: 'error',
      errorCode: deriveErrorCode(errorThought?.content ?? (wasAborted ? 'aborted' : 'interrupted')),
    })
  }

  return result
}
