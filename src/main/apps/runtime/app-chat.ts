/**
 * apps/runtime -- App Chat
 *
 * Interactive chat entry point for automation Apps.
 * Allows users to chat with an App's AI agent in real-time,
 * reusing the main Agent's full streaming capabilities via stream-processor.
 *
 * This is separate from execute.ts (scheduled runs):
 * - execute.ts:  Automated runs triggered by schedule/events, batch processing
 * - app-chat.ts: Interactive chat triggered by user, real-time streaming
 *
 * The V2 session is keyed by "app-chat:{appId}" for reuse across messages.
 * Messages are persisted to JSONL ({spacePath}/.halo/apps/{appId}/runs/chat.jsonl)
 * for reload recovery. Session IDs are persisted for SDK-level resume when the
 * V2 process is rebuilt (idle timeout, crash, config change).
 *
 * Design:
 * - Uses stream-processor.ts for all streaming logic (shared with main agent)
 * - Uses session-manager.ts for V2 session lifecycle (same reuse/invalidation)
 * - Sends renderer events via the virtual conversationId "app-chat:{appId}"
 * - Frontend subscribes to agent:* events filtered by this conversationId
 */

import { writeFile } from 'fs/promises'
import { join } from 'path'
import { getAppManager } from '../manager'
import { resolvePermission } from '../../../shared/apps/app-types'
import type { MemoryCallerScope } from '../../platform/memory'
import { getConfig } from '../../foundation/config.service'
import {
  getApiCredentials,
  getApiCredentialsForSource,
  getWorkingDir,
  getHeadlessElectronPath,
  getDbMcpServers
} from '../../services/agent/helpers'
import { emitAgentEvent } from '../../services/agent/events'
import { resolveCredentialsForSdk, buildBaseSdkOptions } from '../../services/agent/sdk-config'
import { createCanUseTool } from '../../services/agent/permission-handler'
import { getImPermissionContext } from './im-permission-registry'
import type { GuestPolicy } from '../../../shared/types/im-channel'
import { createAIBrowserMcpServer, createScopedBrowserContext } from '../../services/ai-browser'
import type { BrowserContext } from '../../services/ai-browser/context'
import { processStream } from '../../services/agent/stream-processor'
import { buildMessageContent } from '../../services/agent/message-utils'
import {
  getOrCreateV2Session,
  closeV2Session,
  createSessionState,
  registerActiveSession,
  unregisterActiveSession,
  activeSessions,
  v2Sessions
} from '../../services/agent/session-manager'
import { stopGeneration } from '../../services/agent/control'
import { assembleAppChatPrompt } from './prompt/assembler'
import { buildIdentityFragments } from './prompt/identity'
import { NATIVE_CHAT_ENTRY } from './prompt/entry-native'
import { buildImEntry, buildImConstraints, type ImSessionContext } from './im-channels/im-prompt'
import { createFileSendMcpServer } from './im-channels/file-send-mcp'
import { mergeConfigWithDefaults } from './config-defaults'
import { createReportToolServer, type ReportToolContext } from './report-tool'
import { tmpdir as osTmpdir } from 'os'
import { createNotifyToolServer } from './notify-tool'
import { FileExportGate } from './file-export-gate'
import { getImSessionRegistry } from './im-session-registry'
import { createHaloAppsMcpServer } from '../conversation-mcp'
import { createWebSearchMcpServer } from '../../services/web-search'
import { createEmailMcpServer } from '../../services/email-mcp'
import { getSpace, getSpaceDir } from '../../services/space.service'
import { openSessionWriter, readSessionMessages, saveChatSessionId, loadChatSessionId, deleteChatSessionId } from './session-store'
import { getAppMemoryService, getActivityStore } from './index'
import { createMemoryStatusMcpServer } from '../../platform/memory/snapshot'
// Key builders live in shared/ so the renderer can import them without
// depending on main-process modules.
import { getAppChatConversationId, buildImSessionKey } from '../../../shared/apps/im-keys'
import type { ProgressEvent } from '../../../shared/types/inbound-message'
import type { ImageAttachment } from '../../services/agent/types'
import { ProgressEventParser } from './progress-formatter'
import { flushSupplementBuffer } from './dispatch-inbound'
export { getAppChatConversationId, buildImSessionKey }

// ============================================
// Constants
// ============================================

/**
 * Complete list of SDK built-in tools (from SDK init event).
 *
 * Used to compute the guest disallowed list: ALL minus guest's whitelist = blacklist.
 * Must be kept in sync when upgrading the Claude Code SDK — if a new built-in tool
 * is added and not listed here, guests would have access to it by default.
 *
 * NOTE: SDK `tools` option (API-level whitelist) was tested and confirmed non-functional —
 * the SDK ignores it entirely. `disallowedTools` is the only working mechanism.
 */
const ALL_BUILTIN_TOOLS = [
  'AskUserQuestion',
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Read',
  'Skill',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
]

/**
 * Halo MCP servers that are always safe for guests (read-only, no side effects).
 * These are injected into guest sessions regardless of GuestPolicy.
 */
const GUEST_SAFE_MCP = new Set(['web-search', 'halo-report', 'halo-memory'])

/**
 * Halo MCP servers controlled by GuestPolicy toggle switches.
 * Maps MCP server name → GuestPolicy boolean field name.
 * If the toggle is not set (undefined/false), the MCP is not injected for guests.
 */
const GUEST_TOGGLEABLE_MCP: Record<string, keyof GuestPolicy> = {
  'ai-browser':   'allowAiBrowser',
  'halo-email':   'allowEmail',
  'halo-notify':  'allowNotify',
  'halo-apps':    'allowApps',
  'im-file-send': 'allowFileSend',
}

/**
 * Build a filtered MCP servers map for guest sessions.
 *
 * Three-tier filtering:
 *   1. User-installed MCPs (from db) → only if listed in allowedUserMcp whitelist
 *   2. Halo safe MCPs → always injected (web-search, halo-report, halo-memory)
 *   3. Halo toggleable MCPs → injected only if corresponding GuestPolicy flag is true
 *   4. Unknown MCPs (future additions) → NOT injected (conservative strategy)
 *
 * @param allMcpServers - Complete MCP servers map (already built for owner session)
 * @param dbMcpServers - User-installed MCP servers from database (null if none)
 * @param policy - Guest policy from channel instance config
 */
function buildGuestMcpServers(
  allMcpServers: Record<string, any>,
  dbMcpServers: Record<string, unknown> | null,
  policy?: GuestPolicy
): Record<string, any> {
  const result: Record<string, any> = {}

  for (const [name, server] of Object.entries(allMcpServers)) {
    // User-installed MCP → whitelist control
    if (dbMcpServers && name in dbMcpServers) {
      if (policy?.allowedUserMcp?.includes(name)) {
        result[name] = server
      }
      continue
    }

    // Halo safe MCP → always inject
    if (GUEST_SAFE_MCP.has(name)) {
      result[name] = server
      continue
    }

    // Halo toggleable MCP → check policy switch
    const toggleKey = GUEST_TOGGLEABLE_MCP[name]
    if (toggleKey) {
      if (policy?.[toggleKey]) {
        result[name] = server
      }
      continue
    }

    // Unknown MCP (future additions) → NOT injected (conservative)
  }

  return result
}

// ============================================
// Types
// ============================================

/** Request parameters for sending a chat message to an App */
export interface AppChatRequest {
  /** App ID */
  appId: string
  /** Space ID (where the App is installed) */
  spaceId: string
  /** User's message text */
  message: string
  /** Optional image attachments for multimodal input */
  images?: ImageAttachment[]
  /** Enable extended thinking mode */
  thinkingEnabled?: boolean
  /**
   * Optional callback invoked with each progress event during AI execution.
   * Used by IM channel adapters for real-time streaming progress to the IM channel.
   * Called for tool_call, tool_result, thinking, text_delta, and status events.
   * Errors in this callback are caught and logged — they must not interrupt execution.
   */
  onProgress?: (event: ProgressEvent) => void
  /**
   * Optional callback invoked with the AI's final response text.
   * Used by external bridges (e.g., WeCom Bot) to auto-reply
   * the result back to the originating chat.
   */
  onReply?: (finalContent: string) => void
  /**
   * Optional override for the conversation/session ID.
   * When provided, this is used instead of the default "app-chat:{appId}".
   * Used by IM channel adapters to achieve per-chat session isolation:
   *   "app-chat:{appId}:{channel}:{chatType}:{chatId}"
   */
  conversationId?: string
  /**
   * Optional file-send function for IM channels that support outbound file delivery.
   *
   * When present, a `send_file_to_chat` MCP tool is injected into the agent session,
   * allowing the AI to send local files (reports, exports, images) back to the user.
   * The function is pre-bound to the current chatId and chatType by dispatch-inbound.ts.
   * Absent for text-only channels and for the native Halo chat UI.
   */
  imFileSend?: (filePath: string, filename?: string) => Promise<boolean>
  /**
   * Sender identity for direct IM chats.
   * Injected into the system prompt (tamper-proof) instead of prefixing user messages,
   * so slash commands / skills reach the SDK cleanly.
   * Not provided for group chats (which use per-message <msg-sender> tags).
   */
  senderIdentity?: { id: string; name: string }
  /**
   * IM session context for system prompt injection.
   * Tells the AI where it is (group/direct, channel, session ID, display name).
   * Absent for native Halo chat UI.
   */
  imSession?: ImSessionContext
}

// ============================================
// Constants
// ============================================

/** Fixed runId used for chat session JSONL storage */
const CHAT_RUN_ID = 'chat'


/**
 * Derive a storage-safe JSONL runId from a conversationId.
 *
 * - Halo native ("app-chat:{appId}") → "chat"
 * - IM channel ("app-chat:{appId}:wecom-bot:group:xxx") → "chat-wecom-bot-group-xxx"
 */
function deriveRunId(conversationId: string, appId: string): string {
  const defaultPrefix = `app-chat:${appId}`
  if (conversationId === defaultPrefix) {
    return CHAT_RUN_ID
  }
  // Strip "app-chat:{appId}:" prefix, replace colons with dashes
  const suffix = conversationId.slice(defaultPrefix.length + 1)
  return `chat-${suffix.replace(/:/g, '-')}`
}

/**
 * Scoped browser contexts for app chat sessions.
 * Each app chat gets its own context so activeViewId is isolated
 * from the user's browser and other concurrent sessions.
 * Cleaned up when the V2 session is closed (on error) or explicitly.
 */
const scopedContexts = new Map<string, BrowserContext>()

// ============================================
// Core
// ============================================

/**
 * Send a chat message to an automation App's AI agent.
 *
 * This provides real-time streaming with the same capabilities as the main
 * conversation agent: thinking, tool use, token tracking, interruption.
 *
 * The V2 session is reused across messages (keyed by "app-chat:{appId}"),
 * providing in-memory conversation continuity without session restart.
 *
 * @param request - Chat request parameters
 */
export async function sendAppChatMessage(
  request: AppChatRequest
): Promise<void> {
  const { appId, spaceId, message, images, thinkingEnabled, onReply, onProgress, imFileSend, senderIdentity, imSession } = request
  const conversationId = request.conversationId ?? getAppChatConversationId(appId)

  console.log(`[AppChat][${appId}] sendMessage: "${message.substring(0, 100)}"`)

  // ── 1. Resolve app + credentials ─────────────────────
  const manager = getAppManager()
  if (!manager) throw new Error('App services not initialized')

  const app = manager.getApp(appId)
  if (!app) throw new Error(`App not found: ${appId}`)

  const memory = getAppMemoryService()
  if (!memory) throw new Error('Memory service not initialized')

  const config = getConfig()
  const digitalHumansEnabled = config.agent?.enableDigitalHumans !== false
  const credentials = app.userOverrides?.modelSourceId
    ? await getApiCredentialsForSource(config, app.userOverrides.modelSourceId, app.userOverrides.modelId)
    : await getApiCredentials(config)
  const resolvedCreds = await resolveCredentialsForSdk(credentials)
  const electronPath = getHeadlessElectronPath()
  const workDir = getWorkingDir(spaceId)

  // ── 2. Build memory scope ────────────────────────────
  const memoryScope: MemoryCallerScope = {
    type: 'app',
    spaceId: app.spaceId!, // Automation apps always have a spaceId
    spacePath: getSpace(app.spaceId!)?.path ?? '',
    appId: app.id,
  }

  // ── 3. Build system prompt for interactive chat ──────
  const memoryInstructions = memory.getPromptInstructions()
  const usesAIBrowser = resolvePermission(app, 'ai-browser')
  const usesEmail = resolvePermission(app, 'email', false) // default false — higher trust
  const usesImPush = resolvePermission(app, 'im-push') // default true — AI-driven IM push

  // ── Merge config_schema defaults into userConfig ────
  const mergedConfig = mergeConfigWithDefaults(app.userConfig, app.spec.config_schema)

  // Read IM permission context early — needed for both system prompt (ownerIds)
  // and SDK options (guest tool restrictions). null for native Halo chat.
  const permCtx = getImPermissionContext(conversationId)

  // Three-layer prompt assembly. The assembler is channel-agnostic;
  // this call site is the only place that knows whether the entry is
  // IM (group/direct) or native UI. See src/main/apps/runtime/prompt/
  // and src/main/apps/runtime/im-channels/im-prompt.ts.
  const identity = buildIdentityFragments({
    appSpec: app.spec,
    memoryInstructions,
    userConfig: mergedConfig,
    usesAIBrowser,
    workDir,
    modelInfo: resolvedCreds.displayModel,
  })
  const entry = imSession
    ? buildImEntry(imSession, permCtx?.ownerIds)
    : NATIVE_CHAT_ENTRY
  const constraints = imSession
    ? buildImConstraints(imSession, permCtx?.ownerIds)
    : []
  const systemPrompt = assembleAppChatPrompt({ identity, entry, constraints })

  // ── 4. Build MCP servers ─────────────────────────────
  const memoryMcpServer = createMemoryStatusMcpServer(memoryScope)

  // Include user-installed external MCPs (same as regular space chat)
  const dbMcpServers = getDbMcpServers(spaceId)

  // Get or create scoped browser context for this chat session
  let scopedBrowserCtx: BrowserContext | undefined
  if (usesAIBrowser) {
    scopedBrowserCtx = scopedContexts.get(conversationId)
    if (!scopedBrowserCtx) {
      scopedBrowserCtx = createScopedBrowserContext(null)
      scopedContexts.set(conversationId, scopedBrowserCtx)
      console.log(`[AppChat][${appId}] Created scoped browser context`)
    }
  }

  // Notify tool: allows AI to send notifications to channels and IM contacts.
  // FileExportGate roots = the space's working directory (matches the AI's
  // cwd) + tmpdir. Not the same as memoryScope.spacePath, which targets
  // space.path (internal storage) — see getSpaceDir().
  const exportGate = new FileExportGate([getSpaceDir(app.spaceId!), osTmpdir()])
  const imSessions = usesImPush
    ? (getImSessionRegistry()?.getAllSessions(app.id) ?? [])
    : []
  const notifyMcpServer = createNotifyToolServer({
    appId: app.id,
    appName: app.spec.name,
    runId: deriveRunId(conversationId, appId),
    imSessions,
    usesImPush,
    exportGate,
  })

  // Report tool: allows AI to write activity entries in chat mode
  const activityStore = getActivityStore()
  const reportContext: ReportToolContext = {
    appId: app.id,
    appName: app.spec.name,
    runId: CHAT_RUN_ID,
    sessionKey: conversationId,
    notificationLevel: app.userOverrides?.notificationLevel,
  }

  const mcpServers: Record<string, any> = {
    ...(dbMcpServers ?? {}),
    'halo-memory': memoryMcpServer,
    ...(activityStore ? { 'halo-report': createReportToolServer(activityStore, reportContext) } : {}),
    'halo-notify': notifyMcpServer,
    ...(digitalHumansEnabled ? { 'halo-apps': createHaloAppsMcpServer(spaceId) } : {}),
    'web-search': createWebSearchMcpServer(),
    ...(usesAIBrowser ? { 'ai-browser': createAIBrowserMcpServer(scopedBrowserCtx, workDir) } : {}),
    ...(usesEmail && config.notificationChannels?.email?.enabled
      ? { 'halo-email': createEmailMcpServer(config.notificationChannels.email) }
      : {}),
    // Inject file-send tool when the originating IM channel supports file delivery
    ...(imFileSend ? { 'im-file-send': createFileSendMcpServer(imFileSend) } : {}),
  }
  console.log(
    `[AppChat][${appId}] MCP servers: [${Object.keys(mcpServers).join(', ')}], ` +
    `aiBrowser=${usesAIBrowser}, email=${usesEmail}, fileSend=${imFileSend ? 'yes' : 'no'}`
  )

  // ── 5. Build SDK options ─────────────────────────────
  const abortController = new AbortController()
  const sessionState = createSessionState(spaceId, conversationId, abortController)

  const sdkOptions = buildBaseSdkOptions({
    credentials: resolvedCreds,
    workDir,
    electronPath,
    spaceId,
    conversationId,
    stderrHandler: (data: string) => {
      console.error(`[AppChat][${appId}] CLI stderr:`, data)
    },
    mcpServers,
  })

  // Override for app chat context
  sdkOptions.systemPrompt = systemPrompt

  // Non-native sessions (IM channels, etc.) are non-interactive — the user
  // cannot respond to interactive tool prompts, so deny them preemptively
  const defaultConvId = getAppChatConversationId(appId)
  if (conversationId !== defaultConvId) {
    sdkOptions.canUseTool = createCanUseTool({
      spaceId,
      conversationId,
      nonInteractive: true,
    })
  }

  // ── IM guest permission control ────────────────────────────────
  // For non-owner senders in IM sessions, restrict available tools via SDK options.
  // Two layers:
  //   1. disallowedTools (built-in) — blacklist computed by inverting the guest's whitelist.
  //      ALL_BUILTIN_TOOLS minus guest's allowed tools = disallowed. The SDK removes
  //      these from the model's visible tool pool entirely (API-level removal).
  //   2. MCP injection control — filter which MCP servers are injected for guests.
  //      Not injected = model can't see the tool at all. Replaces old allowedTools MCP approach.
  // Owner sessions are unaffected (bypassPermissions, full tool access).
  // permCtx was read earlier (before system prompt build) for ownerIds injection.
  if (permCtx && !permCtx.isOwner) {
    const guestAllowed = permCtx.guestPolicy?.allowedTools ?? []
    // Split: built-in tools only (mcp__ entries are legacy, ignored here)
    const builtinAllowedSet = new Set(guestAllowed.filter(t => !t.startsWith('mcp__')))
    // Invert whitelist → blacklist for built-in tools
    const disallowed = ALL_BUILTIN_TOOLS.filter(t => !builtinAllowedSet.has(t))
    sdkOptions.disallowedTools = disallowed
    sdkOptions.allowedTools = []
    if (sdkOptions.extraArgs) {
      delete sdkOptions.extraArgs['dangerously-skip-permissions']
    }
    sdkOptions.permissionMode = 'default'
    // MCP injection control: only inject servers the guest is allowed to see
    sdkOptions.mcpServers = buildGuestMcpServers(mcpServers, dbMcpServers, permCtx.guestPolicy)
    console.log(
      `[AppChat][${appId}] Guest session: sender=${permCtx.senderId}, ` +
      `allowed=[${Array.from(builtinAllowedSet)}], disallowed=${disallowed.length} tools, ` +
      `mcpServers=[${Object.keys(sdkOptions.mcpServers).join(', ')}]`
    )
  }

  // ── Resolve space path and run ID early (needed for both session resume and JSONL) ──
  const spacePath = getSpace(spaceId)?.path ?? ''
  const chatRunId = deriveRunId(conversationId, appId)

  try {
    const t0 = Date.now()

    // ── 6. Get or create V2 session (reused across messages) ──
    // Load saved sessionId for resume when V2 session is rebuilt after idle
    // timeout, process crash, or config change (same pattern as send-message.ts)
    const savedSessionId = spacePath
      ? loadChatSessionId(spacePath, appId, chatRunId)
      : undefined

    const v2Session = await getOrCreateV2Session(
      spaceId,
      conversationId,
      sdkOptions,
      savedSessionId,
      { aiBrowserEnabled: usesAIBrowser },
      workDir
    )

    registerActiveSession(conversationId, sessionState)

    // Set thinking tokens dynamically
    if (typeof v2Session.setMaxThinkingTokens === 'function') {
      try {
        await v2Session.setMaxThinkingTokens(thinkingEnabled ? 10240 : null)
      } catch (e) {
        console.error(`[AppChat][${appId}] Failed to set thinking tokens:`, e)
      }
    }

    console.log(`[AppChat][${appId}] V2 session ready: ${Date.now() - t0}ms`)

    // ── 7. Open session writer for JSONL persistence ──
    const sessionWriter = spacePath
      ? openSessionWriter(spacePath, appId, chatRunId)
      : undefined

    // Write user message to JSONL for reload recovery
    if (sessionWriter) {
      sessionWriter.writeTrigger(message)
    }

    // ── 8. Process stream ──────────────────────────────
    const messageContent = buildMessageContent(message, images)

    // Track the last assistant message's text content from raw SDK messages.
    // This is the authoritative source for IM replies — same principle as the JSONL
    // path used by AppChatView (readSessionMessages → extractTextContent).
    // Unlike processStream's internal lastTextContent which can be corrupted by
    // dual-path (stream_event + SDK message) state interference, this reads directly
    // from the SDK's output which is always correct.
    // See: stream-processor.ts TODO about lastTextContent pollution.
    let lastAssistantText = ''

    // One stateful parser per message: accumulates tool input JSON and thinking
    // text across delta events, emits complete ProgressEvents on block_stop.
    const progressParser = onProgress ? new ProgressEventParser() : null

    await processStream({
      v2Session,
      sessionState,
      spaceId,
      conversationId,
      messageContent,
      displayModel: resolvedCreds.displayModel,
      abortController,
      t0,
      callbacks: {
        onComplete: (streamResult) => {
          // Save session ID for future resumption (same pattern as send-message.ts).
          // When V2 session is rebuilt after idle timeout or process crash,
          // this allows the SDK to restore conversation history from disk.
          if (streamResult.capturedSessionId && spacePath) {
            saveChatSessionId(spacePath, appId, chatRunId, streamResult.capturedSessionId)
          }

          // App chat doesn't use conversation.service for storage.
          // Messages are persisted to JSONL via onRawMessage for reload.
          const replyContent = lastAssistantText || streamResult.finalContent
          console.log(
            `[AppChat][${appId}] Stream complete: ` +
            `content=${replyContent.length} chars` +
            `${lastAssistantText ? ' (from SDK message)' : ' (from streamResult)'}, ` +
            `thoughts=${streamResult.thoughts.length}, ` +
            `tokens=${streamResult.tokenUsage ? 'yes' : 'no'}`
          )

          // Invoke onReply callback for external bridges (WeCom Bot auto-reply)
          if (onReply && replyContent) {
            try {
              onReply(replyContent)
            } catch (replyErr) {
              console.error(`[AppChat][${appId}] onReply callback error:`, replyErr)
            }
          }
        },
        onRawMessage: (sdkMessage) => {
          // Persist SDK messages to JSONL for "View process" / reload recovery.
          //
          // We skip `stream_event` for both engines: token-level deltas are
          // too granular for JSONL (hundreds per response) and the engine
          // adapters are required to ALSO emit aggregate top-level
          // `assistant`/`user` envelopes (see services/agent/codex/event-
          // normalizer.ts → aggregateBlock). The aggregates are what
          // session-store.convertEventsToMessages reconstructs the chat
          // history from. Engine-specific persistence gates here are a
          // protocol-conformance smell; if a future engine needs them, fix
          // the engine adapter, not this consumer.
          if (sessionWriter && sdkMessage.type !== 'stream_event') {
            sessionWriter.writeEvent(sdkMessage)
          }

          // Extract text from assistant messages for IM reply.
          // SDK assistant messages contain the complete, correct text blocks
          // (unlike processStream's stateful lastTextContent which can be corrupted).
          if (sdkMessage.type === 'assistant') {
            const content = sdkMessage.message?.content
            if (Array.isArray(content)) {
              const text = content
                .filter((b: any) => b.type === 'text' && b.text)
                .map((b: any) => b.text)
                .join('')
              if (text) lastAssistantText = text
            }
          }

          // Emit progress events to IM channel if callback provided
          if (onProgress && progressParser) {
            const progressEvent = progressParser.feed(sdkMessage)
            if (progressEvent) {
              try {
                onProgress(progressEvent)
              } catch (progressErr) {
                console.error(`[AppChat][${appId}] onProgress callback error:`, progressErr)
              }
            }
          }
        }
      }
    })

    console.log(`[AppChat][${appId}] Chat message processed successfully`)
  } catch (error: unknown) {
    const err = error as Error

    // Abort is expected (user stopped generation)
    if (err.name === 'AbortError' || abortController.signal.aborted) {
      console.log(`[AppChat][${appId}] Aborted by user`)
      return
    }

    console.error(`[AppChat][${appId}] Error:`, error)
    emitAgentEvent('agent:error', spaceId, conversationId, {
      type: 'error',
      error: err.message || 'Unknown error during app chat'
    })

    // Close session on error to force fresh session next time
    closeV2Session(conversationId)

    // Destroy scoped browser context on error for IM sessions only.
    // The native app-chat context (defaultConvId) is reused across messages — preserve it
    // so the next message can resume with the same browser state (cookies, session storage).
    // IM session contexts are per-conversation and can be recreated cheaply.
    const defaultConvId = getAppChatConversationId(appId)
    if (conversationId !== defaultConvId) {
      const ctx = scopedContexts.get(conversationId)
      if (ctx) {
        ctx.destroy()
        scopedContexts.delete(conversationId)
        console.log(`[AppChat][${appId}] IM scoped browser context destroyed (error)`)
      }
    }
  } finally {
    // Clean up active session (but keep V2 session for reuse)
    unregisterActiveSession(conversationId)

    // For IM sessions (not the native app-chat key), destroy scoped browser context
    // on successful completion. The native app-chat key reuses its context across messages,
    // but IM sessions can accumulate unboundedly — clean up to prevent memory leaks.
    const defaultConvId = getAppChatConversationId(appId)
    if (conversationId !== defaultConvId) {
      const ctx = scopedContexts.get(conversationId)
      if (ctx) {
        ctx.destroy()
        scopedContexts.delete(conversationId)
        console.log(`[AppChat][${appId}] IM scoped browser context destroyed (completion)`)
      }
    }

    console.log(`[AppChat][${appId}] Active session cleaned up`)

    // Flush buffered IM supplements (deferred so busy lock is released first)
    if (conversationId !== defaultConvId) {
      setImmediate(() => {
        try {
          flushSupplementBuffer(conversationId)
        } catch (err) {
          console.error(`[AppChat][${appId}] flushSupplementBuffer failed:`, err)
        }
      })
    }
  }
}

/**
 * Stop an active app chat generation.
 *
 * Stops the native Halo chat session AND all IM channel sessions for this app.
 * Uses the same stop mechanism as the main agent (V2 session interrupt + drain).
 *
 * @param appId - App ID to stop chat for
 */
export async function stopAppChat(appId: string): Promise<void> {
  const prefix = getAppChatConversationId(appId)
  // Collect all conversation IDs belonging to this app:
  // - "app-chat:{appId}" (native chat)
  // - "app-chat:{appId}:{channel}:{chatType}:{chatId}" (IM sessions)
  const toStop = Array.from(activeSessions.keys()).filter(
    k => k === prefix || k.startsWith(prefix + ':')
  )
  for (const convId of toStop) {
    await stopGeneration(convId)
  }
  console.log(`[AppChat][${appId}] Generation stopped (${toStop.length} session(s))`)
}

/**
 * Check if an app chat session is currently generating.
 *
 * Returns true if the native chat OR any IM session for this app is active.
 *
 * @param appId - App ID to check
 */
export function isAppChatGenerating(appId: string): boolean {
  const prefix = getAppChatConversationId(appId)
  for (const key of activeSessions.keys()) {
    if (key === prefix || key.startsWith(prefix + ':')) return true
  }
  return false
}

/**
 * Load persisted chat messages for an app.
 *
 * Reads the JSONL file and converts to renderer-compatible Message[] format.
 * Returns empty array if no chat session exists.
 *
 * @param spacePath - Space directory path
 * @param appId - App ID
 */
export function loadAppChatMessages(spacePath: string, appId: string): any[] {
  return readSessionMessages(spacePath, appId, CHAT_RUN_ID)
}

/**
 * Load persisted chat messages for an IM session.
 *
 * Constructs the conversationId from IM session parameters, derives the
 * corresponding JSONL runId, and reads the persisted messages.
 *
 * @param spacePath - Space directory path
 * @param appId - App ID
 * @param channel - IM channel identifier (e.g., 'wecom-bot')
 * @param chatType - Conversation type ('direct' | 'group')
 * @param chatId - Platform-side conversation ID
 */
export function loadImChatMessages(
  spacePath: string,
  appId: string,
  channel: string,
  chatType: 'direct' | 'group',
  chatId: string
): any[] {
  const conversationId = buildImSessionKey(appId, channel, chatType, chatId)
  const runId = deriveRunId(conversationId, appId)
  return readSessionMessages(spacePath, appId, runId)
}

/**
 * Get session state for recovery after page refresh.
 *
 * @param appId - App ID
 */
export function getAppChatSessionState(appId: string): {
  isActive: boolean
  thoughts: any[]
  spaceId?: string
} {
  const conversationId = getAppChatConversationId(appId)
  const session = activeSessions.get(conversationId)
  if (!session) {
    return { isActive: false, thoughts: [] }
  }
  return {
    isActive: true,
    thoughts: [...session.thoughts],
    spaceId: session.spaceId
  }
}

/**
 * Clean up scoped browser context for an app chat session.
 * Call when deleting an app, resetting chat, or shutting down.
 *
 * @param appId - App ID
 */
export function cleanupAppChatBrowserContext(appId: string): void {
  const conversationId = getAppChatConversationId(appId)
  const ctx = scopedContexts.get(conversationId)
  if (ctx) {
    ctx.destroy()
    scopedContexts.delete(conversationId)
    console.log(`[AppChat][${appId}] Scoped browser context cleaned up`)
  }
}

// ============================================
// Session Clear (shared logic)
// ============================================

/**
 * Internal: clear a chat session by its conversationId.
 *
 * Shared by clearAppChat() and clearImSession(). Steps:
 * 1. If the session is actively generating, abort it first
 * 2. Close the V2 session (forces fresh session on next message)
 * 3. Destroy scoped browser context (if any)
 * 4. Empty the JSONL persistence file
 *
 * Idempotent: safe to call even if the session doesn't exist.
 */
async function clearSessionByConversationId(
  conversationId: string,
  appId: string,
  spaceId: string
): Promise<void> {
  // 1. Abort active generation (if any) before closing
  if (activeSessions.has(conversationId)) {
    console.log(`[AppChat][${appId}] Session is generating, aborting first...`)
    await stopGeneration(conversationId)
  }

  // 2. Close V2 session to force fresh session on next message
  closeV2Session(conversationId)

  // 3. Clean up scoped browser context
  const ctx = scopedContexts.get(conversationId)
  if (ctx) {
    ctx.destroy()
    scopedContexts.delete(conversationId)
    console.log(`[AppChat][${appId}] Scoped browser context cleaned up`)
  }

  // 4. Clear the JSONL file and saved sessionId
  const space = getSpace(spaceId)
  if (space?.path) {
    const runId = deriveRunId(conversationId, appId)
    const filePath = join(space.path, '.halo', 'apps', appId, 'runs', `${runId}.jsonl`)
    try {
      await writeFile(filePath, '', 'utf8')
    } catch {
      // File may not exist yet, that's fine
    }
    // Remove saved sessionId so next session starts truly fresh
    deleteChatSessionId(space.path, appId, runId)
  }
}

/**
 * Clear all chat history for an app's native Halo chat, resetting to a fresh session.
 * Aborts active generation, closes the V2 session, cleans up browser context,
 * and empties the JSONL file.
 *
 * @param appId - App ID
 * @param spaceId - Space ID (for resolving JSONL path)
 */
export async function clearAppChat(appId: string, spaceId: string): Promise<void> {
  const conversationId = getAppChatConversationId(appId)
  await clearSessionByConversationId(conversationId, appId, spaceId)
  console.log(`[AppChat][${appId}] Chat history cleared`)
}

// ============================================
// Restart (no history loss)
// ============================================

/**
 * Restart all chat sessions for an app — closes V2 sessions so the system
 * prompt and config are reloaded on the next message.
 *
 * Why this exists: Claude Code subprocesses load their system prompt at
 * session creation time and persist across messages for reuse. When a user
 * edits the prompt or config_schema values, existing sessions keep using
 * the stale prompt until they're torn down. This function tears them down.
 *
 * Scope: native Halo chat (`app-chat:{appId}`) + every IM channel session
 * for this app (`app-chat:{appId}:*`). Cross-app sessions are untouched.
 *
 * History: the JSONL transcript and the saved SDK session ID are kept, so
 * the next message resumes the conversation context via SDK session resume.
 * Only the in-process CC subprocess + cached V2 session are reset.
 *
 * In-flight generations are aborted first via `stopGeneration()`, then the
 * V2 session is closed and any per-session browser context is destroyed.
 *
 * Idempotent: returns `sessionsClosed: 0` when nothing is active.
 *
 * @param appId - App ID
 * @returns Count of sessions that were closed
 */
export async function restartAppChat(appId: string): Promise<{ sessionsClosed: number }> {
  const prefix = getAppChatConversationId(appId)

  // Collect all session keys belonging to this app from both maps:
  //   - activeSessions: currently generating (needs abort)
  //   - v2Sessions:     cached CC subprocesses (idle but stuck with old prompt)
  // A session may live in only one of the two; use a Set to dedupe.
  const sessionIds = new Set<string>()
  for (const k of activeSessions.keys()) {
    if (k === prefix || k.startsWith(prefix + ':')) sessionIds.add(k)
  }
  for (const k of v2Sessions.keys()) {
    if (k === prefix || k.startsWith(prefix + ':')) sessionIds.add(k)
  }

  let closed = 0
  for (const convId of sessionIds) {
    try {
      // 1. Abort any in-flight generation before closing the underlying session.
      if (activeSessions.has(convId)) {
        await stopGeneration(convId)
      }

      // 2. Close the V2 session — next message will create a fresh CC process
      //    with the up-to-date system prompt; saved sessionId resumes history.
      closeV2Session(convId)

      // 3. Destroy any per-session browser context. The next message rebuilds
      //    it on demand; keeping a stale context tied to a dead CC process is
      //    pointless and wastes resources.
      const ctx = scopedContexts.get(convId)
      if (ctx) {
        ctx.destroy()
        scopedContexts.delete(convId)
      }

      closed++
    } catch (err) {
      // Per-session failures are logged but do not abort the loop: a stuck
      // IM session must not prevent the native chat from being restarted.
      console.error(`[AppChat][${appId}] Restart failed for ${convId}:`, err)
    }
  }

  console.log(`[AppChat][${appId}] Restart complete: ${closed} session(s) closed (history preserved)`)
  return { sessionsClosed: closed }
}

/**
 * Clear an IM session's chat history, resetting to a fresh session.
 * Aborts active generation, closes the V2 session, cleans up browser context,
 * and empties the JSONL file.
 *
 * @param appId - App ID
 * @param spaceId - Space ID (for resolving JSONL path)
 * @param channel - IM channel identifier (e.g., 'wecom-bot')
 * @param chatType - Conversation type ('direct' | 'group')
 * @param chatId - Platform-side conversation ID
 */
export async function clearImSession(
  appId: string,
  spaceId: string,
  channel: string,
  chatType: 'direct' | 'group',
  chatId: string
): Promise<void> {
  const conversationId = buildImSessionKey(appId, channel, chatType, chatId)
  await clearSessionByConversationId(conversationId, appId, spaceId)
  console.log(`[AppChat][${appId}] IM session cleared: ${conversationId}`)
}
