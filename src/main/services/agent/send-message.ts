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
import { createAIBrowserMcpServer } from '../ai-browser'
import { createWebSearchMcpServer } from '../web-search'
import { createHaloAppsMcpServer } from '../app-bridge'
import type {
  AgentRequest,
  SessionConfig,
} from './types'
import {
  getHeadlessElectronPath,
  getWorkingDir,
  getApiCredentials,
  getDbMcpServers
} from './helpers'
import { emitAgentEvent } from './events'
import {
  getOrCreateV2Session,
  closeV2Session,
  updateConsumerDisplayModel,
} from './session-manager'
import {
  formatCanvasContext,
  buildMessageContent,
} from './message-utils'
import { resolveCredentialsForSdk, buildBaseSdkOptions } from './sdk-config'
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
    aiBrowserEnabled,
    thinkingEnabled,
    canvasContext
  } = request

  console.log(`[Agent] sendMessage: conv=${conversationId}${images && images.length > 0 ? `, images=${images.length}` : ''}${aiBrowserEnabled ? ', AI Browser enabled' : ''}${thinkingEnabled ? ', thinking=ON' : ''}${canvasContext?.isOpen ? `, canvas tabs=${canvasContext.tabCount}` : ''}`)

  const config = getConfig()
  const workDir = getWorkingDir(spaceId)
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
    // Get API credentials and resolve for SDK use
    const credentials = await getApiCredentials(config)
    console.log(`[Agent] sendMessage using: ${credentials.provider}, model: ${credentials.model}, prompt: ${config.agent?.promptProfile ?? 'halo'}`)
    console.log(`[Agent] turn_start conv=${conversationId} model=${credentials.model} ts=${Date.now()}`)

    const resolvedCredentials = await resolveCredentialsForSdk(credentials)

    // Get conversation for session resumption
    const { getConversation } = await import('../conversation.service')
    const conversation = getConversation(spaceId, conversationId)
    const sessionId = resumeSessionId || conversation?.sessionId
    const electronPath = getHeadlessElectronPath()

    // Get MCP servers from installed apps database (global + space-scoped, with override)
    const dbMcpServers = getDbMcpServers(spaceId)

    // Build MCP servers config (DB apps + built-in MCPs)
    const mcpServers: Record<string, any> = dbMcpServers ? { ...dbMcpServers } : {}
    if (aiBrowserEnabled) {
      mcpServers['ai-browser'] = createAIBrowserMcpServer(undefined, workDir)
    }
    if (digitalHumansEnabled) {
      const haloApps = createHaloAppsMcpServer(spaceId)
      if (haloApps) mcpServers['halo-apps'] = haloApps
    }
    mcpServers['web-search'] = createWebSearchMcpServer()

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
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : null,
      maxTurns: config.agent?.maxTurns,
      promptProfile: config.agent?.promptProfile,
      configDirMode: config.agent?.configDirMode,
      customConfigDir: config.agent?.customConfigDir,
      enableTeams: config.agent?.enableTeams,
      disabledTools: config.agent?.disabledTools,
      aiBrowserEnabled: !!aiBrowserEnabled,
      digitalHumansEnabled,
    })

    // Apply dynamic configurations (Thinking mode)
    if (thinkingEnabled) {
      sdkOptions.maxThinkingTokens = 10240
    }

    const t0 = Date.now()
    console.log(`[Agent][${conversationId}] Getting or creating V2 session...`)

    // Session config for rebuild detection
    const sessionConfig: SessionConfig = {
      aiBrowserEnabled: !!aiBrowserEnabled
    }

    // Get or create persistent V2 session (also starts persistent consumer if new)
    const v2Session = await getOrCreateV2Session(
      spaceId, conversationId, sdkOptions, sessionId, sessionConfig, workDir,
      resolvedCredentials.displayModel  // Passed to consumer for thought parsing
    )

    sessionObtained = true

    // Ensure consumer's displayModel is up-to-date.
    // When the session is reused (no rebuild), the consumer retains the old displayModel.
    // This keeps thought parsing ("Connected | Model: X") in sync after model switches.
    updateConsumerDisplayModel(conversationId, resolvedCredentials.displayModel)

    // Dynamic runtime parameter adjustment
    try {
      if (v2Session.setModel) {
        await v2Session.setModel(resolvedCredentials.sdkModel)
      }
      if (v2Session.setMaxThinkingTokens) {
        await v2Session.setMaxThinkingTokens(thinkingEnabled ? 10240 : null)
      }
    } catch (e) {
      console.error(`[Agent][${conversationId}] Failed to set dynamic params:`, e)
    }
    console.log(`[Agent][${conversationId}] ⏱️ V2 session ready: ${Date.now() - t0}ms`)

    // Prepare message content (canvas context prefix + multi-modal images)
    const canvasPrefix = formatCanvasContext(canvasContext)
    const messageWithContext = canvasPrefix + message
    const messageContent = buildMessageContent(messageWithContext, images)

    // Send to CC's REPL — consumer handles the response
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
        const { detectGitBash } = require('../git-bash.service')
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
