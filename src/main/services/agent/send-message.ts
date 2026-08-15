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
import { addMessage } from '../conversation.service'
import { buildCreationTimeServers, openToolset } from './toolsets/broker'
import { buildToolsetSection } from './toolsets/capability-index'
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
  getOrCreateV2Session,
  closeV2Session,
  updateConsumerDisplayModel,
  markTurnDispatched,
} from './session-manager'
import {
  formatCanvasContext,
  buildMessageContent,
} from './message-utils'
import { prepareNonVisionImageFallback, OCR_TOOLSET_ID } from './image-attachments'
import { resolveCredentialsForSdk, buildBaseSdkOptions } from './sdk-config'
import { applyReasoningEffort } from './reasoning-effort'
import { createConversationSink } from './conversation-sink'
import { flushToolStats } from './stream-processor'
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
    canvasContext
  } = request

  console.log(`[Agent] sendMessage: conv=${conversationId}${images && images.length > 0 ? `, images=${images.length}` : ''}${thinkingEnabled ? ', thinking=ON' : ''}${canvasContext?.isOpen ? `, canvas tabs=${canvasContext.tabCount}` : ''}`)

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
  const digitalHumansEnabled = config.agent?.enableDigitalHumans !== false

  // Accumulate stderr for detailed error messages
  let stderrBuffer = ''
  // Track whether V2 session was obtained (for defensive cleanup on error)
  let sessionObtained = false

  // Add user message to conversation (with images if provided).
  // Assistant placeholder is NOT created here — it is created by the session
  // consumer when CC emits system:init (unified for user + autonomous turns).
  addMessage(spaceId, conversationId, {
    role: 'user',
    content: message,
    images: images
  })

  try {
    // Load the conversation first: it carries both the resume sessionId and the
    // per-conversation model pin used to resolve credentials.
    const { getConversation } = await import('../conversation.service')
    const conversation = getConversation(spaceId, conversationId)
    const sessionId = resumeSessionId || conversation?.sessionId

    // Get API credentials (per-conversation pin, falling back to global) and resolve for SDK use
    const credentials = await getApiCredentialsForConversation(config, conversation)
    console.log(`[Agent] sendMessage using: ${credentials.provider}, model: ${credentials.model}, prompt: ${config.agent?.promptProfile ?? 'halo'}`)
    console.log(`[Agent] turn_start conv=${conversationId} model=${credentials.model} ts=${Date.now()}`)

    const resolvedCredentials = await resolveCredentialsForSdk(credentials)
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

    // Build base SDK options
    const sdkOptions = buildBaseSdkOptions({
      credentials: resolvedCredentials,
      workDir,
      electronPath,
      spaceId,
      conversationId,
      stderrHandler: (data: string) => {
        console.error(`[Agent][${conversationId}] CLI stderr:`, data)
        stderrBuffer += data
      },
      maxTurns: config.agent?.maxTurns,
      promptProfile: config.agent?.promptProfile,
      configDirMode: config.agent?.configDirMode,
      customConfigDir: config.agent?.customConfigDir,
      enableTeams: config.agent?.enableTeams,
      disabledTools: config.agent?.disabledTools,
      digitalHumansEnabled,
      toolsetIndex: buildToolsetSection(spaceId, conversationId),
    })

    // Apply dynamic configurations (Thinking mode)
    const thinkingBudget = applyReasoningEffort(
      sdkOptions, thinkingEnabled, resolvedCredentials.capabilities
    )

    const t0 = Date.now()
    console.log(`[Agent][${conversationId}] Getting or creating V2 session...`)

    // Get or create persistent V2 session (also starts persistent consumer if new)
    const v2Session = await getOrCreateV2Session(
      spaceId, conversationId, sdkOptions, sessionId, workDir,
      {
        displayModel: resolvedCredentials.displayModel,
        contextWindow: resolvedCredentials.capabilities?.contextWindow,
        sink: createConversationSink(spaceId, conversationId),
      },
      resolvedKbIds,
      buildMcpServers,
      resolveKnowledgeBases
    )

    sessionObtained = true

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

    // Prepare message content (canvas context prefix + multi-modal images).
    // With the non-vision fallback active, image blocks are replaced by the
    // injected attachment-paths block.
    const canvasPrefix = formatCanvasContext(canvasContext)
    const messageWithContext = canvasPrefix + (imageFallback?.contextBlock ?? '') + message
    const messageContent = buildMessageContent(messageWithContext, imageFallback ? undefined : images)

    // Send to CC's REPL — consumer handles the response. Mark the dispatch
    // BEFORE send: from here until system:init the consumer looks idle, and an
    // unguarded rebuild in that window would destroy this message.
    markTurnDispatched(conversationId)
    if (typeof messageContent === 'string') {
      v2Session.send(messageContent)
    } else {
      const userMessage = {
        type: 'user' as const,
        message: { role: 'user' as const, content: messageContent }
      }
      v2Session.send(userMessage as any)
    }

    console.log(`[Agent][${conversationId}] Message sent to REPL (${typeof messageContent === 'string' ? messageContent.length : 'multi-modal'} chars). Consumer handles response.`)

  } catch (error: unknown) {
    const err = error as Error

    if (err.name === 'AbortError') {
      console.log(`[Agent][${conversationId}] Aborted by user`)
      return
    }

    console.error(`[Agent][${conversationId}] Error during send:`, error)

    // Extract detailed error message
    let errorMessage = err.message || 'Unknown error. Check logs in Settings > System > Logs.'

    // Windows: Check for Git Bash related errors
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

    // Telemetry: surface this error to the global error map and drain any
    // tool stats that processStream couldn't (e.g. crash during sendMessage
    // before the stream even started). Both calls are fire-and-forget and
    // internally try/caught — they never re-throw into this path.
    //
    // Idempotency note: when processStream DID run to completion, it already
    // flushed the toolStatsMap entry for this conversationId, so flushToolStats
    // here returns null and the inner emit is skipped. This is intentional
    // belt-and-suspenders: the only path where this branch fires non-null is
    // a crash BEFORE processStream took over the stats map.
    analytics.trackErrorSurface('agent-send', err)
    const toolSummary = flushToolStats(conversationId)
    if (toolSummary) {
      void analytics.track(AnalyticsEvents.TOOL_USAGE_SUMMARY, {
        source: 'agent',
        conversationId,
        ...toolSummary,
      })
    }

    emitAgentEvent('agent:error', spaceId, conversationId, {
      type: 'error',
      error: errorMessage
    })

    // No assistant placeholder exists (it's created by consumer on system:init,
    // which never fired because send failed). Create one now to hold the error.
    addMessage(spaceId, conversationId, {
      role: 'assistant',
      content: '',
      error: errorMessage,
      toolCalls: [],
    })

    // Emit complete so frontend transitions out of generating state
    emitAgentEvent('agent:complete', spaceId, conversationId, {
      type: 'complete',
      duration: 0,
    })

    // Defensive cleanup: close session + consumer if error occurred after session
    // was obtained (e.g., send() threw due to broken transport). Without this,
    // the consumer loop would spin on a potentially corrupted session.
    // Matches old architecture's behavior of always closing on error.
    if (sessionObtained) {
      closeV2Session(conversationId)
    }

    const { onAgentError, runPpidScanAndCleanup } = await import('../health')
    onAgentError(conversationId, errorMessage)
    runPpidScanAndCleanup().catch(e => {
      console.error('[Agent] PPID scan after error failed:', e)
    })
  }
}
