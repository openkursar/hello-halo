/**
 * Agent Module - Send Message
 *
 * Sends a user message to the CC subprocess's REPL.
 *
 * Architecture (REPL consumer model):
 *   This module is responsible ONLY for sending. Consuming the response is handled
 *   by the persistent session consumer (session-consumer.ts), which runs for the
 *   lifetime of the V2 session.
 *
 *   Flow:
 *     1. Resolve API credentials and prepare SDK options
 *     2. Get or create V2 session (starts consumer if new session)
 *     3. Add user message to conversation (assistant placeholder is NOT created here)
 *     4. v2Session.send(message) → CC emits system:init → consumer creates placeholder
 *     5. Return immediately (no await on stream processing)
 */

import { getConfig } from '../../foundation/config.service'
import { addMessage, updateMessageById } from '../conversation.service'
import { buildCreationTimeServers, openToolset } from './toolsets/broker'
import { buildToolsetSection } from './toolsets/capability-index'
import { getOpenToolsets } from './toolsets/state'
import { HALO_API_TOOLSET_ID } from '../api-ref'
// The toolset broker (above) supplies AI Browser / web-search / apps as
// on-demand toolsets; only the knowledge-base helpers are still called directly.
import { getKBChatContext } from '../tlon'
import { resolveConversationKnowledgeBases, resolveConversationKnowledgeBaseIds } from './knowledge-context'
import type {
  AgentRequest,
} from './types'
import {
  getHeadlessElectronPath,
  getWorkingDir,
  getApiCredentialsForConversation,
  getDbMcpServers
} from './helpers'
import { emitAgentEvent } from './events'
import {
  acquireV2Session,
  updateConsumerDisplayModel,
  type V2SessionLease,
} from './session-manager'
import {
  formatCanvasContext,
  buildMessageContent,
} from './message-utils'
import { formatTurnAttachments } from './references'
import { prepareNonVisionImageFallback, OCR_TOOLSET_ID } from './image-attachments'
import { resolveCredentialsForSdk, buildUserSessionSdkOptions } from './sdk-config'
import { resolveSpaceMemorySession, buildSpaceMemoryPreamble } from './space-memory'
import { applyReasoningEffort, pickReasoningEffort } from './reasoning-effort'
import { createConversationSink } from './conversation-sink'
import { prepareGoalInput, setGoalForTurn } from './goal'
import { flushToolStats } from './stream-processor'
import { workingDirErrorDetail } from './working-dir'
import { onAgentError, runPpidScanAndCleanup } from '../health'
import { analytics } from '../analytics/analytics.service'
import { AnalyticsEvents } from '../analytics/types'

// ============================================
// Send Message
// ============================================

/**
 * Send a user message to the CC subprocess's REPL.
 *
 * Resolves credentials, ensures the V2 session exists (with a persistent
 * consumer), persists the user message, and calls v2Session.send().
 * Returns immediately — the session consumer handles the response.
 */
export async function sendMessage(
  request: AgentRequest
): Promise<void> {

  const {
    spaceId,
    conversationId,
    message,
    resumeSessionId,
    images,
    thinkingEnabled,
    canvasContext,
    references,
    task
  } = request
  // Validated before the message is recorded, so a refused goal leaves no trace.
  const turnGoal = request.goal ? prepareGoalInput(request.goal) : null

  console.log(`[Agent] sendMessage: conv=${conversationId}${images && images.length > 0 ? `, images=${images.length}` : ''}${thinkingEnabled ? ', thinking=ON' : ''}${canvasContext?.isOpen ? `, canvas tabs=${canvasContext.tabCount}` : ''}${references?.length ? `, references=${references.length}` : ''}${task ? `, task=${task.type}/${task.variant}` : ''}`)

  // Counted here, not at the IPC handler, so every transport that reaches
  // space chat (desktop IPC and remote HTTP) goes through one call site.
  void analytics.track(AnalyticsEvents.MESSAGE_SENT, {
    source: 'agent',
    direction: 'inbound',
    spaceId,
    conversationId,
    hasImages: Array.isArray(images) && images.length > 0,
  })

  const config = getConfig()
  // "Chat with this KB" turns (knowledgeBaseId set) target one KB directly: the
  // working dir becomes that KB's text/ dir so Read/Glob/Grep search its
  // extracted documents. Resolved up front so the working dir is correct for
  // MCP setup below too.
  const kbChatCtx = request.knowledgeBaseId ? getKBChatContext(request.knowledgeBaseId) : null
  if (request.knowledgeBaseId && !kbChatCtx) {
    console.warn(`[Agent] knowledgeBaseId ${request.knowledgeBaseId} has no chat context; falling back to space context`)
  }
  let workDir = kbChatCtx ? kbChatCtx.workDir : getWorkingDir(spaceId)
  if (request.knowledgeBaseId) {
    console.log(`[Agent] KB chat turn: knowledgeBaseId=${request.knowledgeBaseId} ctx=${kbChatCtx ? 'resolved' : 'NULL'} workDir=${workDir}`)
  }

  // Accumulate stderr for detailed error messages
  let stderrBuffer = ''
  let sessionLease: V2SessionLease | undefined

  // Add user message to conversation (with images if provided).
  // Assistant placeholder is NOT created here — it is created by the session
  // consumer when CC emits system:init (unified for user + autonomous turns).
  const messageMetadata = {
    ...(turnGoal ? { goal: turnGoal } : {}),
    ...(references && references.length > 0 ? { references } : {}),
    ...(task ? { task } : {}),
  }
  const userMessage = addMessage(spaceId, conversationId, {
    role: 'user',
    content: message,
    images: images,
    ...(Object.keys(messageMetadata).length > 0 ? { metadata: messageMetadata } : {})
  })
  let goalApplied = false
  let dispatchAttempted = false
  let failureReported = false

  const reportFailure = (error: unknown): void => {
    if (failureReported) return
    failureReported = true
    const err = error as Error
    if (err.name === 'AbortError') {
      console.log(`[Agent][${conversationId}] Aborted by user`)
      return
    }

    console.error(`[Agent][${conversationId}] Error during send:`, error)

    if (turnGoal && !goalApplied) {
      const { goal: _goal, ...metadata } = userMessage.metadata ?? {}
      updateMessageById(spaceId, conversationId, userMessage.id, { metadata })
      console.warn(`[Agent][${conversationId}] Send failed before its goal was set; dropped the goal from the message`)
    }

    let errorMessage = err.message || 'Unknown error. Check logs in Settings > System > Logs.'
    if (process.platform === 'win32') {
      const isExitCode1 = errorMessage.includes('exited with code 1') ||
                          errorMessage.includes('process exited') ||
                          errorMessage.includes('spawn ENOENT')
      const isBashError = stderrBuffer?.includes('bash') ||
                          stderrBuffer?.includes('ENOENT') ||
                          errorMessage.includes('ENOENT')

      if (isExitCode1 || isBashError) {
        const { detectGitBash } = require('../git-bash')
        const gitBashStatus = detectGitBash()
        errorMessage = !gitBashStatus.found
          ? 'Command execution environment not installed. Please restart the app and complete setup, or install manually in settings.'
          : `Command execution failed. This may be an environment configuration issue, please try restarting the app.\n\nTechnical details: ${err.message}`
      }
    }

    if (stderrBuffer && !errorMessage.includes('Command execution')) {
      const mcpErrorMatch = stderrBuffer.match(/Error: Invalid MCP configuration:[\s\S]*?(?=\n\s*at |$)/m)
      const genericErrorMatch = stderrBuffer.match(/Error: [\s\S]*?(?=\n\s*at |$)/m)
      if (mcpErrorMatch) errorMessage = mcpErrorMatch[0].trim()
      else if (genericErrorMatch) errorMessage = genericErrorMatch[0].trim()
    }

    analytics.trackErrorSurface('agent-send', err)
    const toolSummary = flushToolStats(conversationId)
    if (toolSummary) {
      void analytics.track(AnalyticsEvents.TOOL_USAGE_SUMMARY, {
        source: 'agent', conversationId, ...toolSummary,
      })
    }

    emitAgentEvent('agent:error', spaceId, conversationId, { type: 'error', error: errorMessage, ...workingDirErrorDetail(error, spaceId) })
    try {
      addMessage(spaceId, conversationId, {
        role: 'assistant', content: '', error: errorMessage, toolCalls: [],
      })
    } finally {
      emitAgentEvent('agent:complete', spaceId, conversationId, { type: 'complete', duration: 0 })
    }

    onAgentError(conversationId, errorMessage)
    void runPpidScanAndCleanup().catch(e => {
      console.error('[Agent] PPID scan after error failed:', e)
    })
  }

  try {
    // Load the conversation first: it carries both the resume sessionId and the
    // per-conversation model pin used to resolve credentials.
    const { getConversation } = await import('../conversation.service')
    const conversation = getConversation(spaceId, conversationId)
    const sessionId = resumeSessionId || conversation?.sessionId

    // The conversation's pinned account, or the global selection when it has no pin.
    const credentials = await getApiCredentialsForConversation(conversation)
    console.log(`[Agent] sendMessage using: ${credentials.provider}, model: ${credentials.model}, prompt: ${config.agent?.promptProfile ?? 'halo'}`)
    console.log(`[Agent] turn_start conv=${conversationId} model=${credentials.model} ts=${Date.now()}`)

    // The conversation's own level wins over one the send carries (API callers).
    const pickedEffort = pickReasoningEffort(conversation?.reasoningEffort, request.reasoningEffort)
    const resolvedCredentials = await resolveCredentialsForSdk(credentials, pickedEffort)
    const electronPath = getHeadlessElectronPath()

    // Non-vision models can't receive image blocks: persist images to files and
    // inject their paths for the ocr_image tool instead. Runs before session
    // creation — the OCR auto-open below schedules a rebuild that must be
    // seeded into this turn's session.
    const toolsetScope = { spaceId, conversationId, workDir }
    const imageFallback = prepareNonVisionImageFallback({
      scope: toolsetScope,
      credentials,
      images
    })
    if (imageFallback) {
      const opened = openToolset(toolsetScope, OCR_TOOLSET_ID, 'system')
      if (!opened.ok) {
        // Non-fatal: the paths are still injected; the model can request_toolset.
        console.warn(`[Agent][${conversationId}] Failed to auto-open OCR toolset: ${opened.error}`)
      }
    }

    // Creation-time MCP servers: external process-based servers (user-installed
    // apps) plus the complete in-process set (always-on web-search / halo-apps,
    // broker meta tools, and currently-enabled toolsets). Assembled lazily by
    // getOrCreateV2Session only when a session is actually created — in-process
    // instances bind to one session, so instantiating them before the
    // reuse/rebuild decision would hand a rebuilt session dead instances.
    const buildMcpServers = (): Record<string, unknown> | null => {
      const dbMcpServers = getDbMcpServers(spaceId)
      const record: Record<string, unknown> = dbMcpServers ? { ...dbMcpServers } : {}
      Object.assign(record, buildCreationTimeServers({ spaceId, conversationId, workDir }))
      return Object.keys(record).length > 0 ? record : null
    }

    // Knowledge context for the session. A KB-chat turn targets just its KB; a
    // normal turn uses the conversation's own knowledge set — snapshotted at
    // creation from the space's bindings plus the default KB
    // (conversation.service), then user-editable per conversation. Must match
    // ensureSessionWarm exactly so a warmed session isn't reused without the
    // Knowledge section on the first turn. Ids are resolved cheaply for the
    // per-message fingerprint; the index.md reads happen only if a session is
    // actually created (resolveKnowledgeBases, invoked by getOrCreateV2Session).
    const resolvedKbIds = kbChatCtx
      ? [kbChatCtx.reference.id]
      : resolveConversationKnowledgeBaseIds(conversation)
    const resolveKnowledgeBases = () => kbChatCtx
      ? [kbChatCtx.reference]
      : resolveConversationKnowledgeBases(conversation)

    // Space memory — not for a KB-chat turn, which works on one KB's documents.
    const spaceMemory = kbChatCtx ? null : resolveSpaceMemorySession(spaceId, conversationId)

    // Build base SDK options
    const sdkOptions = await buildUserSessionSdkOptions({
      // Same switch that loads the halo_api_ref tool: a session without the
      // manual has no way to discover the API, so the credentials would only
      // widen what an injected instruction can reach.
      selfApiAccess: getOpenToolsets(spaceId, conversationId).has(HALO_API_TOOLSET_ID),
      credentials: resolvedCredentials,
      workDir,
      electronPath,
      spaceId,
      conversationId,
      stderrHandler: (data: string) => {
        console.error(`[Agent][${conversationId}] CLI stderr:`, data)
        stderrBuffer += data
      },
      toolsetIndex: buildToolsetSection(spaceId, conversationId),
      memoryInstructions: spaceMemory?.instructions,
      memoryGuard: spaceMemory?.guard,
    })

    const thinkingBudget = applyReasoningEffort(
      sdkOptions, thinkingEnabled, resolvedCredentials.capabilities, pickedEffort
    )

    const t0 = Date.now()
    console.log(`[Agent][${conversationId}] Getting or creating V2 session...`)

    // The lease protects asynchronous preparation before the consumer sees a turn.
    sessionLease = await acquireV2Session(
      spaceId, conversationId, sdkOptions, sessionId, workDir,
      {
        displayModel: resolvedCredentials.displayModel,
        contextWindow: resolvedCredentials.capabilities?.contextWindow,
        sink: createConversationSink(spaceId, conversationId),
      },
      resolvedKbIds,
      buildMcpServers,
      resolveKnowledgeBases,
      { creationContext: spaceMemory?.contextKey },
      reportFailure
    )

    const v2Session = sessionLease.session

    // Ensure consumer's displayModel is up-to-date.
    // When the session is reused (no rebuild), the consumer retains the old displayModel.
    // This keeps thought parsing ("Connected | Model: X") in sync after model switches.
    updateConsumerDisplayModel(
      conversationId, resolvedCredentials.displayModel, resolvedCredentials.capabilities?.contextWindow
    )

    // Dynamic runtime parameter adjustment. Model is intentionally NOT set
    // here: model changes rebuild the session via credentialsFingerprint, and
    // the CLI's set_model handler injects "/model" replay messages into the
    // transcript on every call, polluting context and surfacing in the chat UI.
    try {
      if (v2Session.setMaxThinkingTokens) {
        await v2Session.setMaxThinkingTokens(thinkingBudget)
      }
    } catch (e) {
      console.error(`[Agent][${conversationId}] Failed to set dynamic params:`, e)
    }
    console.log(`[Agent][${conversationId}] ⏱️ V2 session ready: ${Date.now() - t0}ms`)

    if (!sessionLease.isCurrent) throw new Error('The acquired session is no longer available')

    if (turnGoal) {
      setGoalForTurn(spaceId, conversationId, v2Session, turnGoal, Boolean(sessionId))
      goalApplied = true
    }

    // Prepare message content (canvas context prefix + multi-modal images).
    // With the non-vision fallback active, image blocks are replaced by the
    // injected attachment-paths block.
    const canvasPrefix = formatCanvasContext(canvasContext)
    // The space's memory opens a new conversation only: a resumed one carries
    // it forward in its own transcript.
    const memoryPreamble = spaceMemory && !sessionId
      ? await buildSpaceMemoryPreamble(spaceMemory.layout, conversationId)
      : ''
    const attachments = formatTurnAttachments({ references, task, taskInstructions: request.taskInstructions, workDir })
    const messageWithContext = memoryPreamble + canvasPrefix + attachments + (imageFallback?.contextBlock ?? '') + message
    const messageContent = buildMessageContent(messageWithContext, imageFallback ? undefined : images)

    // Dispatch transfers lease protection to awaiting-init before releasing it.
    dispatchAttempted = true
    if (typeof messageContent === 'string') {
      await sessionLease.send(messageContent, reportFailure)
    } else {
      const userMessage = {
        type: 'user' as const,
        message: { role: 'user' as const, content: messageContent }
      }
      await sessionLease.send(userMessage as any, reportFailure)
    }

    console.log(`[Agent][${conversationId}] Message sent to REPL (${typeof messageContent === 'string' ? messageContent.length : 'multi-modal'} chars). Consumer handles response.`)

  } catch (error: unknown) {
    if (!dispatchAttempted) {
      if (!sessionLease || sessionLease.isCurrent) {
        reportFailure(error)
      } else {
        console.warn(`[Agent][${conversationId}] Discarded retired session's preparation failure`)
      }
      sessionLease?.close()
    }
  } finally {
    sessionLease?.release()
  }
}
