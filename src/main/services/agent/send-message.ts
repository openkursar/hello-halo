/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * Agent Module - Send Message
 *
 * Core message sending logic including:
 * - API credential resolution and routing
 * - V2 Session management
 * - SDK message streaming and processing
 * - Token-level streaming support
 * - Error handling and recovery
 */

import { BrowserWindow } from 'electron'
import { getConfig } from '../config.service'
import { getConversation, saveSessionId, addMessage, updateLastMessage } from '../conversation.service'
import { type FileChangesSummary, extractFileChangesSummaryFromThoughts } from '../../../shared/file-changes'
import { notifyTaskComplete } from '../notification.service'
import {
  AI_BROWSER_SYSTEM_PROMPT,
  createAIBrowserMcpServer
} from '../ai-browser'
import type {
  AgentRequest,
  ToolCall,
  Thought,
  SessionConfig,
  TokenUsage,
  SingleCallUsage
} from './types'
import {
  getHeadlessElectronPath,
  getWorkingDir,
  getApiCredentials,
  getEnabledMcpServers,
  sendToRenderer,
  setMainWindow
} from './helpers'
import { buildSystemPromptWithAIBrowser } from './system-prompt'
import {
  getOrCreateV2Session,
  closeV2Session,
  createSessionState,
  registerActiveSession,
  unregisterActiveSession,
  v2Sessions
} from './session-manager'
import { broadcastMcpStatus } from './mcp-manager'
import {
  formatCanvasContext,
  buildMessageContent,
  parseSDKMessage,
  extractSingleUsage,
  extractResultUsage
} from './message-utils'
import { onAgentError, runPpidScanAndCleanup } from '../health'
import { resolveCredentialsForSdk, buildBaseSdkOptions } from './sdk-config'

// Unified fallback error suffix - guides user to check logs
const FALLBACK_ERROR_HINT = 'Check logs in Settings > System > Logs.'

// ============================================
// Send Message
// ============================================

/**
 * Send message to agent (supports multiple concurrent sessions)
 *
 * This is the main entry point for sending messages to the AI agent.
 * It handles:
 * - API credential resolution (Anthropic, OpenAI, OAuth providers)
 * - V2 Session creation/reuse
 * - Message streaming with token-level updates
 * - Tool calls and permissions
 * - Error handling and recovery
 */
export async function sendMessage(
  mainWindow: BrowserWindow | null,
  request: AgentRequest
): Promise<void> {
  setMainWindow(mainWindow)

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

  // Get API credentials and resolve for SDK use
  const credentials = await getApiCredentials(config)
  console.log(`[Agent] sendMessage using: ${credentials.provider}, model: ${credentials.model}`)

  // Resolve credentials for SDK (handles OpenAI compat router for non-Anthropic providers)
  const resolvedCredentials = await resolveCredentialsForSdk(credentials)

  // Get conversation for session resumption
  const conversation = getConversation(spaceId, conversationId)
  const sessionId = resumeSessionId || conversation?.sessionId

  // Create abort controller for this session
  const abortController = new AbortController()

  // Accumulate stderr for detailed error messages
  let stderrBuffer = ''

  // Register this session in the active sessions map
  const sessionState = createSessionState(spaceId, conversationId, abortController)
  registerActiveSession(conversationId, sessionState)

  // Add user message to conversation (with images if provided)
  addMessage(spaceId, conversationId, {
    role: 'user',
    content: message,
    images: images  // Include images in the saved message
  })

  // Add placeholder for assistant response
  addMessage(spaceId, conversationId, {
    role: 'assistant',
    content: '',
    toolCalls: []
  })

  try {
    // Use headless Electron binary (outside .app bundle on macOS to prevent Dock icon)
    const electronPath = getHeadlessElectronPath()
    console.log(`[Agent] Using headless Electron as Node runtime: ${electronPath}`)

    // Get enabled MCP servers
    const enabledMcpServers = getEnabledMcpServers(config.mcpServers || {})

    // Build MCP servers config (including AI Browser if enabled)
    const mcpServers: Record<string, any> = enabledMcpServers ? { ...enabledMcpServers } : {}
    if (aiBrowserEnabled) {
      mcpServers['ai-browser'] = createAIBrowserMcpServer()
      console.log(`[Agent][${conversationId}] AI Browser MCP server added`)
    }

    // Build base SDK options using shared configuration
    const sdkOptions = buildBaseSdkOptions({
      credentials: resolvedCredentials,
      workDir,
      electronPath,
      spaceId,
      conversationId,
      abortController,
      stderrHandler: (data: string) => {
        console.error(`[Agent][${conversationId}] CLI stderr:`, data)
        stderrBuffer += data  // Accumulate for error reporting
      },
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : null
    })

    // Apply dynamic configurations (AI Browser system prompt, Thinking mode)
    // These are specific to sendMessage and not part of base options
    if (aiBrowserEnabled) {
      sdkOptions.systemPrompt = buildSystemPromptWithAIBrowser(
        { workDir, modelInfo: resolvedCredentials.displayModel },
        AI_BROWSER_SYSTEM_PROMPT
      )
    }
    if (thinkingEnabled) {
      sdkOptions.maxThinkingTokens = 10240
    }

    const t0 = Date.now()
    console.log(`[Agent][${conversationId}] Getting or creating V2 session...`)

    // Log MCP servers if configured (only enabled ones)
    const mcpServerNames = enabledMcpServers ? Object.keys(enabledMcpServers) : []
    if (mcpServerNames.length > 0) {
      console.log(`[Agent][${conversationId}] MCP servers configured: ${mcpServerNames.join(', ')}`)
    }

    // Session config for rebuild detection
    const sessionConfig: SessionConfig = {
      aiBrowserEnabled: !!aiBrowserEnabled
    }

    // Get or create persistent V2 session for this conversation
    // Pass config for rebuild detection when aiBrowserEnabled changes
    // Pass workDir for session migration support (from old ~/.claude to new config dir)
    const v2Session = await getOrCreateV2Session(spaceId, conversationId, sdkOptions, sessionId, sessionConfig, workDir)

    // Dynamic runtime parameter adjustment (via SDK patch)
    // Note: Model switching is handled by session rebuild (model change triggers
    // credentialsGeneration bump in config.service). setModel is kept for SDK
    // compatibility but is not effective for actual model routing when all providers
    // route through the OpenAI compat router (model is baked into ANTHROPIC_API_KEY).
    try {
      // Set model in SDK (informational; actual model determined by session credentials)
      if (v2Session.setModel) {
        await v2Session.setModel(resolvedCredentials.sdkModel)
        console.log(`[Agent][${conversationId}] Model set: ${resolvedCredentials.sdkModel}`)
      }

      // Set thinking tokens dynamically
      if (v2Session.setMaxThinkingTokens) {
        await v2Session.setMaxThinkingTokens(thinkingEnabled ? 10240 : null)
        console.log(`[Agent][${conversationId}] Thinking mode: ${thinkingEnabled ? 'ON (10240 tokens)' : 'OFF'}`)
      }
    } catch (e) {
      console.error(`[Agent][${conversationId}] Failed to set dynamic params:`, e)
    }
    console.log(`[Agent][${conversationId}] ⏱️ V2 session ready: ${Date.now() - t0}ms`)

    // Process the stream
    await processMessageStream(
      v2Session,
      sessionState,
      spaceId,
      conversationId,
      message,
      images,
      canvasContext,
      resolvedCredentials.displayModel,
      abortController,
      t0
    )

    // System notification for task completion (if window not focused)
    notifyTaskComplete(conversation?.title || 'Conversation')

  } catch (error: unknown) {
    const err = error as Error

    // Don't report abort as error
    if (err.name === 'AbortError') {
      console.log(`[Agent][${conversationId}] Aborted by user`)
      return
    }

    console.error(`[Agent][${conversationId}] Error:`, error)

    // Extract detailed error message from stderr if available
    let errorMessage = err.message || `Unknown error. ${FALLBACK_ERROR_HINT}`

    // Windows: Check for Git Bash related errors
    if (process.platform === 'win32') {
      const isExitCode1 = errorMessage.includes('exited with code 1') ||
                          errorMessage.includes('process exited') ||
                          errorMessage.includes('spawn ENOENT')
      const isBashError = stderrBuffer?.includes('bash') ||
                          stderrBuffer?.includes('ENOENT') ||
                          errorMessage.includes('ENOENT')

      if (isExitCode1 || isBashError) {
        // Check if Git Bash is properly configured
        const { detectGitBash } = require('../git-bash.service')
        const gitBashStatus = detectGitBash()

        if (!gitBashStatus.found) {
          errorMessage = 'Command execution environment not installed. Please restart the app and complete setup, or install manually in settings.'
        } else {
          // Git Bash found but still got error - could be path issue
          errorMessage = 'Command execution failed. This may be an environment configuration issue, please try restarting the app.\n\n' +
                        `Technical details: ${err.message}`
        }
      }
    }

    if (stderrBuffer && !errorMessage.includes('Command execution')) {
      // Try to extract the most useful error info from stderr
      const mcpErrorMatch = stderrBuffer.match(/Error: Invalid MCP configuration:[\s\S]*?(?=\n\s*at |$)/m)
      const genericErrorMatch = stderrBuffer.match(/Error: [\s\S]*?(?=\n\s*at |$)/m)
      if (mcpErrorMatch) {
        errorMessage = mcpErrorMatch[0].trim()
      } else if (genericErrorMatch) {
        errorMessage = genericErrorMatch[0].trim()
      }
    }

    sendToRenderer('agent:error', spaceId, conversationId, {
      type: 'error',
      error: errorMessage
    })

    // Persist error to the assistant placeholder message so it survives conversation reload
    updateLastMessage(spaceId, conversationId, {
      content: '',
      error: errorMessage
    })

    // Emit health event for monitoring
    onAgentError(conversationId, errorMessage)

    // Run PPID scan to clean up dead processes (async, don't wait)
    runPpidScanAndCleanup().catch(err => {
      console.error('[Agent] PPID scan after error failed:', err)
    })

    // Close V2 session on error (it may be in a bad state)
    closeV2Session(conversationId)
  } finally {
    // Clean up active session state (but keep V2 session for reuse)
    unregisterActiveSession(conversationId)
    console.log(`[Agent][${conversationId}] Active session state cleaned up. V2 sessions: ${v2Sessions.size}`)
  }
}

// ============================================
// Stream Processing
// ============================================

/**
 * Process the message stream from V2 session
 */
async function processMessageStream(
  v2Session: any,
  sessionState: any,
  spaceId: string,
  conversationId: string,
  message: string,
  images: AgentRequest['images'],
  canvasContext: AgentRequest['canvasContext'],
  displayModel: string,
  abortController: AbortController,
  t0: number
): Promise<void> {
  // Only keep track of the LAST text block as the final reply
  // Intermediate text blocks are shown in thought process, not accumulated into message bubble
  let lastTextContent = ''
  let capturedSessionId: string | undefined

  // Token usage tracking
  // lastSingleUsage: Last API call usage (single call, represents current context size)
  let lastSingleUsage: SingleCallUsage | null = null
  let tokenUsage: TokenUsage | null = null

  // Token-level streaming state
  let currentStreamingText = ''  // Accumulates text_delta tokens
  let isStreamingTextBlock = false  // True when inside a text content block
  const STREAM_THROTTLE_MS = 30  // Throttle updates to ~33fps

  // Track if SDK reported error_during_execution (for interrupted detection)
  let hadErrorDuringExecution = false
  // Track if we received a result message (for detecting stream interruption)
  let receivedResult = false

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
  console.log(`[Agent][${conversationId}] Sending message to V2 session...`)
  if (images && images.length > 0) {
    console.log(`[Agent][${conversationId}] Message includes ${images.length} image(s)`)
  }

  // Inject Canvas Context prefix if available
  // This provides AI awareness of what user is currently viewing
  const canvasPrefix = formatCanvasContext(canvasContext)
  const messageWithContext = canvasPrefix + message

  // Build message content (text-only or multi-modal with images)
  const messageContent = buildMessageContent(messageWithContext, images)

  // Send message to V2 session and stream response
  // For multi-modal messages, we need to send as SDKUserMessage
  if (typeof messageContent === 'string') {
    v2Session.send(messageContent)
  } else {
    // Multi-modal message: construct SDKUserMessage
    const userMessage = {
      type: 'user' as const,
      message: {
        role: 'user' as const,
        content: messageContent
      }
    }
    v2Session.send(userMessage as any)
  }

  // Stream messages from V2 session
  for await (const sdkMessage of v2Session.stream()) {
    // Handle abort - check this session's controller
    if (abortController.signal.aborted) {
      console.log(`[Agent][${conversationId}] Aborted`)
      break
    }

    // Handle stream_event for token-level streaming (text only)
    if (sdkMessage.type === 'stream_event') {
      const event = (sdkMessage as any).event
      if (!event) continue

      // DEBUG: Log all stream events with timestamp (ms since send)
      const elapsed = Date.now() - t1
      // For message_start, log the full event to see if it contains content structure hints
      if (event.type === 'message_start') {
        console.log(`[Agent][${conversationId}] 🔴 +${elapsed}ms message_start FULL:`, JSON.stringify(event))
      } else {
        // console.log(`[Agent][${conversationId}] 🔴 +${elapsed}ms stream_event:`, JSON.stringify({
        //   type: event.type,
        //   index: event.index,
        //   content_block: event.content_block,
        //   delta: event.delta
        // }))
      }

      // Text block started
      if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
        isStreamingTextBlock = true
        currentStreamingText = event.content_block.text || ''

        // 🔑 Send precise signal for new text block (fixes truncation bug)
        // This is 100% reliable - comes directly from SDK's content_block_start event
        sendToRenderer('agent:message', spaceId, conversationId, {
          type: 'message',
          content: '',
          isComplete: false,
          isStreaming: false,
          isNewTextBlock: true  // Signal: new text block started
        })

        console.log(`[Agent][${conversationId}] ⏱️ Text block started (isNewTextBlock signal): ${Date.now() - t1}ms after send`)
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
        sendToRenderer('agent:thought', spaceId, conversationId, { thought })
        console.log(`[Agent][${conversationId}] ⏱️ Thinking block started (streaming): ${Date.now() - t1}ms after send`)
      }

      // Thinking delta - append to thought content
      if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
        const blockIndex = event.index ?? 0
        const blockState = streamingBlocks.get(blockIndex)

        if (blockState && blockState.type === 'thinking') {
          const delta = event.delta.thinking || ''
          blockState.content += delta

          // Send delta to renderer for incremental update
          sendToRenderer('agent:thought-delta', spaceId, conversationId, {
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
        sendToRenderer('agent:message', spaceId, conversationId, {
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

        // Send to renderer for immediate display (shows tool name, "准备中...")
        sendToRenderer('agent:thought', spaceId, conversationId, { thought })
        console.log(`[Agent][${conversationId}] ⏱️ Tool block started [${toolName}] (streaming): ${Date.now() - t1}ms after send`)
      }

      // Tool use input JSON delta - accumulate partial JSON
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        const blockIndex = event.index ?? 0
        const blockState = streamingBlocks.get(blockIndex)

        if (blockState && blockState.type === 'tool_use') {
          const partialJson = event.delta.partial_json || ''
          blockState.content += partialJson

          // Send delta to renderer (for progress indication, not for parsing)
          sendToRenderer('agent:thought-delta', spaceId, conversationId, {
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
            sendToRenderer('agent:thought-delta', spaceId, conversationId, {
              thoughtId: blockState.thoughtId,
              content: blockState.content,
              isComplete: true  // Signal: thinking is complete
            })

            // Update session state thought
            const thought = sessionState.thoughts.find(t => t.id === blockState.thoughtId)
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
              console.error(`[Agent][${conversationId}] Failed to parse tool input JSON:`, e)
            }

            // Record mapping for merging tool_result later
            if (blockState.toolId) {
              toolIdToThoughtId.set(blockState.toolId, blockState.thoughtId)
            }

            // Send complete signal with parsed input
            sendToRenderer('agent:thought-delta', spaceId, conversationId, {
              thoughtId: blockState.thoughtId,
              toolInput,
              isComplete: true,  // Signal: tool params are complete
              isReady: true,     // Tool is ready for execution
              isToolInput: true  // Flag: this is tool input completion (triggers isReady update in frontend)
            })

            // Update session state thought
            const thought = sessionState.thoughts.find(t => t.id === blockState.thoughtId)
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
            sendToRenderer('agent:tool-call', spaceId, conversationId, toolCall as unknown as Record<string, unknown>)

            console.log(`[Agent][${conversationId}] Tool block complete [${blockState.toolName}], input: ${JSON.stringify(toolInput).substring(0, 100)}`)
          }

          // Clean up tracking state
          streamingBlocks.delete(blockIndex)
        }

        // Handle text block stop (existing logic)
        if (isStreamingTextBlock) {
          isStreamingTextBlock = false
          // Send final content of this block
          sendToRenderer('agent:message', spaceId, conversationId, {
            type: 'message',
            content: currentStreamingText,
            isComplete: false,
            isStreaming: false
          })
          // Update lastTextContent for final result
          lastTextContent = currentStreamingText
          console.log(`[Agent][${conversationId}] Text block completed, length: ${currentStreamingText.length}`)
        }
      }

      continue  // stream_event handled, skip normal processing
    }

    // DEBUG: Log all SDK messages with timestamp
    const elapsed = Date.now() - t1
    console.log(`[Agent] SDK messages [${conversationId}] 🔵 +${elapsed}ms ${sdkMessage.type}:`,
      JSON.stringify(sdkMessage, null, 2)
    )

    // Extract single API call usage from assistant message (represents current context size)
    if (sdkMessage.type === 'assistant') {
      const usage = extractSingleUsage(sdkMessage)
      if (usage) {
        lastSingleUsage = usage
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
          const toolUseThought = sessionState.thoughts.find(t => t.id === toolUseThoughtId)
          if (toolUseThought) {
            toolUseThought.toolResult = toolResult
          }

          // Send thought-delta to merge result into tool_use on frontend
          sendToRenderer('agent:thought-delta', spaceId, conversationId, {
            thoughtId: toolUseThoughtId,
            toolResult,
            isToolResult: true  // Flag: this is a tool result merge
          })

          // Still send tool-result event for any listeners
          sendToRenderer('agent:tool-result', spaceId, conversationId, {
            type: 'tool_result',
            toolId: thought.id,
            result: thought.toolOutput || '',
            isError: thought.isError || false
          })

          console.log(`[Agent][${conversationId}] Tool result merged into thought ${toolUseThoughtId}`)
        } else {
          // No mapping found - fall back to separate thought (shouldn't happen normally)
          sessionState.thoughts.push(thought)
          sendToRenderer('agent:thought', spaceId, conversationId, { thought })
          sendToRenderer('agent:tool-result', spaceId, conversationId, {
            type: 'tool_result',
            toolId: thought.id,
            result: thought.toolOutput || '',
            isError: thought.isError || false
          })
          console.log(`[Agent][${conversationId}] Tool result fallback (no mapping): ${thought.id}`)
        }
      } else {
        // Non tool_result thoughts - handle normally
        // Accumulate thought in backend session (Single Source of Truth)
        sessionState.thoughts.push(thought)

        // Send ALL thoughts to renderer for real-time display in thought process area
        // This includes text blocks - they appear in the timeline during generation
        sendToRenderer('agent:thought', spaceId, conversationId, { thought })

        // Handle specific thought types
        if (thought.type === 'text') {
          // Keep only the latest text block (overwritten by each new text block)
          // This becomes the final reply when generation completes
          // Intermediate texts stay in the thought process area only
          lastTextContent = thought.content

          // Send streaming update - frontend shows this during generation
          sendToRenderer('agent:message', spaceId, conversationId, {
            type: 'message',
            content: lastTextContent,
            isComplete: false
          })
        } else if (thought.type === 'tool_use') {
          // Send tool call event
          const toolCall: ToolCall = {
            id: thought.id,
            name: thought.toolName || '',
            status: 'running',
            input: thought.toolInput || {}
          }
          sendToRenderer('agent:tool-call', spaceId, conversationId, toolCall as unknown as Record<string, unknown>)
        } else if (thought.type === 'error') {
          // SDK reported an error (rate_limit, authentication_failed, etc.)
          // Send error to frontend - user should see the actual error from provider
          console.log(`[Agent][${conversationId}] Error thought received: ${thought.content}`)
          sendToRenderer('agent:error', spaceId, conversationId, {
            type: 'error',
            error: thought.content,
            errorCode: thought.errorCode  // Preserve error code for debugging
          })
        } else if (thought.type === 'result') {
          // Final result - use the last text block as the final reply
          const finalContent = lastTextContent || thought.content
          sendToRenderer('agent:message', spaceId, conversationId, {
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
          sendToRenderer('agent:compact', spaceId, conversationId, {
            type: 'compact',
            trigger: compactMetadata.trigger,
            preTokens: compactMetadata.pre_tokens
          })
        }
      }

      // Extract MCP server status from system init message
      // SDKSystemMessage includes mcp_servers: { name: string; status: string }[]
      const mcpServers = msg.mcp_servers as Array<{ name: string; status: string }> | undefined
      if (mcpServers && mcpServers.length > 0) {
        console.log(`[Agent][${conversationId}] MCP server status:`, JSON.stringify(mcpServers))
        // Broadcast MCP status to frontend (global event, not conversation-specific)
        broadcastMcpStatus(mcpServers)
      }

      // Also capture tools list if available
      const tools = msg.tools as string[] | undefined
      if (tools) {
        console.log(`[Agent][${conversationId}] Available tools: ${tools.length}`)
      }
    } else if (sdkMessage.type === 'result') {
      receivedResult = true  // Mark that we received a result message
      if (!capturedSessionId) {
        const sessionIdFromMsg = msg.session_id || (msg.message as Record<string, unknown>)?.session_id
        capturedSessionId = sessionIdFromMsg as string
      }

      // 🔑 Check for real API errors - only report if is_error=true OR errors array has content
      // Note: subtype="error_during_execution" alone does NOT mean error - it's a normal completion state
      const isError = (sdkMessage as any).is_error === true
      const errors = (sdkMessage as any).errors as unknown[] | undefined
      const hasErrors = Array.isArray(errors) && errors.length > 0

      if (isError || hasErrors) {
        // Pass through the real error from SDK
        const realError = hasErrors
          ? JSON.stringify(errors)
          : ((sdkMessage as any).result || `Unknown API error. ${FALLBACK_ERROR_HINT}`)
        console.log(`[Agent][${conversationId}] ⚠️ SDK error (is_error=${isError}, errors=${errors?.length || 0}): ${realError}`)
        const errorThought: Thought = {
          id: `thought-error-${Date.now()}`,
          type: 'error',
          content: realError,
          timestamp: new Date().toISOString()
        }
        sessionState.thoughts.push(errorThought)
        sendToRenderer('agent:thought', spaceId, conversationId, {
          type: 'thought',
          thought: errorThought
        })
      } else if ((sdkMessage as any).subtype === 'error_during_execution') {
        // Mark as interrupted - will be used for empty response handling
        hadErrorDuringExecution = true
        console.log(`[Agent][${conversationId}] SDK result subtype=error_during_execution but is_error=false, errors=[] - marked as interrupted`)
      }

      // Extract token usage from result message
      tokenUsage = extractResultUsage(msg, lastSingleUsage)
      if (tokenUsage) {
        console.log(`[Agent][${conversationId}] Token usage (single API):`, tokenUsage)
      }
    }
  }

  // Save session ID for future resumption
  if (capturedSessionId) {
    saveSessionId(spaceId, conversationId, capturedSessionId)
    console.log(`[Agent][${conversationId}] Session ID saved:`, capturedSessionId)
  }

  // ========== Stream End Handling ==========
  //
  // Error conditions (truth table):
  // | Case | hasContent | isInterrupted | hasErrorThought | wasAborted | Send error?      |
  // |------|------------|---------------|-----------------|------------|------------------|
  // | 1a   | yes        | -             | -               | yes        | stopped by user  |
  // | 1b   | yes        | yes           | -               | no         | interrupted      |
  // | 2    | yes        | no            | -               | no         | no               |
  // | 3    | no         | yes           | no              | no         | interrupted      |
  // | 4    | no         | no            | no              | no         | empty response   |
  // | 5    | no         | -             | yes             | -          | no               |
  // | 6    | no         | -             | -               | yes        | no               |

  // Merge content: prefer lastTextContent (confirmed), fallback to currentStreamingText (accumulated)
  const finalContent = lastTextContent || currentStreamingText || ''
  const wasAborted = abortController.signal.aborted
  const hasErrorThought = sessionState.thoughts.some(t => t.type === 'error')
  // Two independent interrupt reasons: SDK reported error_during_execution, or stream ended unexpectedly
  const isInterrupted = !receivedResult || hadErrorDuringExecution

  // Step 1: Save content and/or error to disk
  // Persist when there's content OR an error thought (e.g., 429 rate limit)
  const errorThought = hasErrorThought
    ? sessionState.thoughts.find(t => t.type === 'error')
    : undefined
  if (finalContent || hasErrorThought) {
    if (finalContent) {
      const contentSource = lastTextContent ? 'lastTextContent' : 'currentStreamingText (fallback)'
      console.log(`[Agent][${conversationId}] Saving content from ${contentSource}: ${finalContent.length} chars`)
    }
    if (hasErrorThought) {
      console.log(`[Agent][${conversationId}] Persisting error to message: ${errorThought?.content}`)
    }

    // Extract file changes summary for immediate display (without loading thoughts)
    let metadata: { fileChanges?: FileChangesSummary } | undefined
    if (sessionState.thoughts.length > 0) {
      try {
        const fileChangesSummary = extractFileChangesSummaryFromThoughts(sessionState.thoughts)
        if (fileChangesSummary) {
          metadata = { fileChanges: fileChangesSummary }
          console.log(`[Agent][${conversationId}] File changes: ${fileChangesSummary.totalFiles} files, +${fileChangesSummary.totalAdded} -${fileChangesSummary.totalRemoved}`)
        }
      } catch (error) {
        console.error(`[Agent][${conversationId}] Failed to extract file changes:`, error)
      }
    }

    updateLastMessage(spaceId, conversationId, {
      content: finalContent,
      thoughts: sessionState.thoughts.length > 0 ? [...sessionState.thoughts] : undefined,
      tokenUsage: tokenUsage || undefined,
      metadata,
      error: errorThought?.content
    })
  } else {
    console.log(`[Agent][${conversationId}] No content to save`)
  }

  // Step 2: Always send complete event to unblock frontend
  sendToRenderer('agent:complete', spaceId, conversationId, {
    type: 'complete',
    duration: 0,
    tokenUsage
  })

  // Step 3: Determine if interrupted error should be sent
  const getInterruptedErrorMessage = (): string | null => {
    if (finalContent) {
      // Has content: user aborted shows friendly message, other interrupts show warning
      if (wasAborted) return 'Stopped by user.'
      return isInterrupted ? 'Model response interrupted unexpectedly.' : null
    } else {
      // No content: skip if already has error thought or user aborted
      if (hasErrorThought || wasAborted) return null
      return isInterrupted
        ? 'Model response interrupted unexpectedly.'
        : `Unexpected empty response. ${FALLBACK_ERROR_HINT}`
    }
  }

  const errorMessage = getInterruptedErrorMessage()
  if (errorMessage) {
    const reason = isInterrupted
      ? (hadErrorDuringExecution ? 'error_during_execution' : 'stream interrupted')
      : 'empty response'
    console.log(`[Agent][${conversationId}] Sending interrupted error (${reason}, content: ${finalContent ? 'yes' : 'no'})`)
    sendToRenderer('agent:error', spaceId, conversationId, {
      type: 'error',
      errorType: 'interrupted',
      error: errorMessage
    })
  } else if (wasAborted) {
    console.log(`[Agent][${conversationId}] User stopped - no error sent`)
  }
}
