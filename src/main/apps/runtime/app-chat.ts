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
import { randomUUID } from 'crypto'
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
import { createTerminalMcpServer, getGlobalTerminalContext, isTerminalAvailable } from '../../services/ai-terminal'
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
import { buildDisabledCapabilitiesGuidance, buildUnconfiguredCapabilitiesGuidance } from './prompt/capabilities'
import { NATIVE_CHAT_ENTRY } from './prompt/entry-native'
import { buildImEntry, buildImConstraints, type ImSessionContext } from './im-channels/im-prompt'
import { createFileSendMcpServer } from './im-channels/file-send-mcp'
import { mergeConfigWithDefaults } from './config-defaults'
import { tmpdir as osTmpdir } from 'os'
import { createNotifyToolServer } from './notify-tool'
import { resolveNotifyAvailability } from './notify-availability'
import { FileExportGate } from './file-export-gate'
import { truncateUtf16Safe } from './text-truncate'
import { getImSessionRegistry } from './im-session-registry'
import { createHaloAppsMcpServer } from '../conversation-mcp'
import { createWebSearchMcpServer } from '../../services/web-search'
import { createOcrMcpServer } from '../../services/ocr'
import { createEmailMcpServer } from '../../services/email-mcp'
import { getSpace, getSpaceDir } from '../../services/space.service'
import { openSessionWriter, readSessionMessages, saveChatSessionId, loadChatSessionId, deleteChatSessionId, copySessionJsonl } from './session-store'
import { getAppMemoryService } from './index'
import { createMemoryStatusMcpServer } from '../../platform/memory/snapshot'
// Key builders live in shared/ so the renderer can import them without
// depending on main-process modules.
import { getAppChatConversationId, buildImSessionKey, buildLocalSessionKey, parseAppChatKey } from '../../../shared/apps/im-keys'
import { classifySessionSource, LOCAL_SESSION_CHANNEL } from '../../../shared/types/im-channel'
import type { ImSessionRecord } from '../../../shared/types/im-channel'
import { sendToRenderer } from '../../foundation/window.service'
import { broadcastToAll } from '../../http/websocket'
import type { ProgressEvent } from '../../../shared/types/inbound-message'
import type { ImageAttachment } from '../../services/agent/types'
import { ProgressEventParser } from './progress-formatter'
import { ReplyTextAccumulator } from './reply-accumulator'
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
 * Halo MCP servers that are always safe for guests (read-only, no side effects,
 * no local-filesystem reach). These are injected into guest sessions regardless
 * of GuestPolicy. OCR is deliberately NOT here: it reads arbitrary local file
 * paths, so it is host-controlled via GUEST_TOGGLEABLE_MCP below.
 */
const GUEST_SAFE_MCP = new Set(['web-search', 'halo-memory'])

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
  'ocr':          'allowOcr',
}

/**
 * Build a filtered MCP servers map for guest sessions.
 *
 * Three-tier filtering:
 *   1. User-installed MCPs (from db) → only if listed in allowedUserMcp whitelist
 *   2. Halo safe MCPs → always injected (web-search, halo-memory)
 *   3. Halo toggleable MCPs → injected only if corresponding GuestPolicy flag is true
 *   4. Unknown MCPs (future additions) → NOT injected (conservative strategy)
 *
 * @param allMcpServers - Complete MCP servers map (already built for owner session)
 * @param dbMcpServers - User-installed MCP servers from database (null if none)
 * @param policy - Guest policy from channel instance config
 */
export function buildGuestMcpServers(
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

/**
 * Register an external (HTTP) app-chat session so it shows in the conversation
 * list and is readable via the same HTTP path as IM sessions.
 *
 * IM sessions are skipped: dispatch-inbound already registers them with a live
 * instanceId, and re-registering here with an empty instanceId would clobber
 * that binding and break IM push. Native chat keys parse to null and are ignored.
 */
function registerExternalChatSession(
  conversationId: string,
  appId: string,
  opts?: { displayName?: string; lastSender?: string; lastMessage?: string }
): void {
  const parsed = parseAppChatKey(conversationId)
  if (!parsed || parsed.appId !== appId) return
  if (classifySessionSource(parsed.channel) === 'im') return

  const registry = getImSessionRegistry()
  if (!registry) return

  registry.register(appId, parsed.channel, parsed.chatId, parsed.chatType, '', {
    displayName: opts?.displayName,
    lastSender: opts?.lastSender,
    lastMessage: opts?.lastMessage,
  })

  // Notify desktop + remote clients so the session panel refreshes in real time.
  const sessionEvent = {
    appId,
    channel: parsed.channel,
    chatId: parsed.chatId,
    chatType: parsed.chatType,
    instanceId: '',
    lastMessage: opts?.lastMessage !== undefined ? truncateUtf16Safe(opts.lastMessage, 50) : undefined,
    lastSender: opts?.lastSender,
  }
  sendToRenderer('app:im-session-updated', sessionEvent)
  broadcastToAll('app:im-session-updated', sessionEvent)
}

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

  // Register external (HTTP/API) sessions for UI visibility + HTTP read parity.
  // No-op for native chat and for IM sessions (owned by dispatch-inbound).
  registerExternalChatSession(conversationId, app.id, {
    displayName: senderIdentity?.name,
    lastSender: senderIdentity?.name,
    lastMessage: message,
  })

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
  const usesTerminal = resolvePermission(app, 'ai-terminal') && isTerminalAvailable()
  const usesEmail = resolvePermission(app, 'email') // gated on channel config downstream
  const usesImPush = resolvePermission(app, 'im-push') // AI-driven IM push

  // Runtime facts a capability toggle cannot convey: a capability can be ON yet
  // still tool-less until its channel/contact exists. Computed once here and
  // reused for the notify MCP server, the capability-awareness prompt, and the
  // IM entry's notify_bot constraints.
  const imSessions = usesImPush
    ? (getImSessionRegistry()?.getPushableSessions(app.id) ?? [])
    : []
  const notifyAvail = resolveNotifyAvailability(app, config.notificationChannels, imSessions)

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
    appId: app.id,
    appSpec: app.spec,
    memoryInstructions,
    userConfig: mergedConfig,
    usesAIBrowser,
    usesTerminal,
    workDir,
    modelInfo: resolvedCreds.displayModel,
    disabledCapabilities: buildDisabledCapabilitiesGuidance(app) ?? undefined,
    unconfiguredCapabilities: buildUnconfiguredCapabilitiesGuidance(app, {
      emailChannelConfigured: notifyAvail.emailChannelConfigured,
      imContactsAvailable: notifyAvail.imContactsAvailable,
    }) ?? undefined,
  })
  const entry = imSession
    ? buildImEntry(imSession, permCtx?.ownerIds, notifyAvail.notifyBotAvailable)
    : NATIVE_CHAT_ENTRY
  const constraints = imSession
    ? buildImConstraints(imSession, permCtx?.ownerIds)
    : []
  const systemPrompt = assembleAppChatPrompt({ identity, entry, constraints })

  // ── 4. Build MCP servers ─────────────────────────────
  const memoryMcpServer = createMemoryStatusMcpServer(memoryScope)

  // Include user-installed external MCPs (same as regular space chat), minus
  // any this digital human has explicitly disabled (requires.mcps[].enabled ===
  // false) so the per-app switch is consistent between chat and automation runs.
  const disabledMcpIds = new Set(
    (app.spec.requires?.mcps ?? [])
      .filter(d => d.enabled === false)
      .map(d => d.id)
  )
  const dbMcpServersRaw = getDbMcpServers(spaceId)
  const dbMcpServers = dbMcpServersRaw && disabledMcpIds.size > 0
    ? Object.fromEntries(Object.entries(dbMcpServersRaw).filter(([id]) => !disabledMcpIds.has(id)))
    : dbMcpServersRaw

  // Get or create scoped browser context for this chat session
  let scopedBrowserCtx: BrowserContext | undefined
  if (usesAIBrowser) {
    scopedBrowserCtx = scopedContexts.get(conversationId)
    if (!scopedBrowserCtx) {
      scopedBrowserCtx = createScopedBrowserContext()
      scopedContexts.set(conversationId, scopedBrowserCtx)
      console.log(`[AppChat][${appId}] Created scoped browser context`)
    }
  }

  // Notify tool: allows AI to send notifications to channels and IM contacts.
  // FileExportGate roots = the space's working directory (matches the AI's
  // cwd) + tmpdir. Not the same as memoryScope.spacePath, which targets
  // space.path (internal storage) — see getSpaceDir().
  const exportGate = new FileExportGate([getSpaceDir(app.spaceId!), osTmpdir()])
  const notifyMcpServer = createNotifyToolServer({
    appId: app.id,
    appName: app.spec.name,
    runId: deriveRunId(conversationId, appId),
    imSessions,
    usesImPush,
    exportGate,
  })
  // NOTE: report_to_user (halo-report) is intentionally NOT injected in chat/IM
  // mode. It writes to activity_entries, whose run_id has a FK to automation_runs.
  // Chat sessions have no automation_runs row, so any call fails with a FOREIGN
  // KEY constraint and the model retries in a loop (see issue #200). Chat replies
  // reach the user directly as text, so the Activity Thread is not needed here.
  // Built-in server ids below are mirrored in shared/apps/builtin-mcp.ts — keep in sync.
  const mcpServers: Record<string, any> = {
    ...(dbMcpServers ?? {}),
    'halo-memory': memoryMcpServer,
    'halo-notify': notifyMcpServer,
    ...(digitalHumansEnabled ? { 'halo-apps': createHaloAppsMcpServer(spaceId) } : {}),
    'web-search': createWebSearchMcpServer(),
    'ocr': createOcrMcpServer(),
    ...(usesAIBrowser ? { 'ai-browser': createAIBrowserMcpServer(scopedBrowserCtx, workDir) } : {}),
    ...(usesTerminal
      ? { 'ai-terminal': createTerminalMcpServer(getGlobalTerminalContext(workDir), { spaceId, workDir }) }
      : {}),
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

  // Peek a pending resume-and-fork marker for native local sessions (set when
  // this session was forked from an IM/other session via "continue in client").
  // Peek, not consume: the marker is cleared only after the first message
  // captures the new forked session id, so a failed first attempt can retry.
  const forkParsedKey = parseAppChatKey(conversationId)
  const forkResumeSessionId =
    forkParsedKey?.channel === LOCAL_SESSION_CHANNEL
      ? getImSessionRegistry()?.getPendingResume(appId, forkParsedKey.channel, forkParsedKey.chatId)
      : undefined

  try {
    const t0 = Date.now()

    // ── 6. Get or create V2 session (reused across messages) ──
    // Load saved sessionId for resume when V2 session is rebuilt after idle
    // timeout, process crash, or config change (same pattern as send-message.ts)
    const savedSessionId = spacePath
      ? loadChatSessionId(spacePath, appId, chatRunId)
      : undefined

    // Fork-on-first-message: a local session created via "continue in client"
    // carries a pending source SDK session id. With no session of its own yet,
    // resume that source AND branch to a fresh session id (forkSession) so the
    // two windows evolve independently. The captured new id is persisted in
    // onComplete and the pending marker is cleared, so later messages take the
    // normal resume path. Only reachable when the engine advertises sessionFork
    // (the fork UI is gated on it), so no engine guard is needed here.
    let resumeSessionId = savedSessionId
    let forkFromChannel: string | undefined
    let forkFromChatId: string | undefined
    if (!resumeSessionId && forkResumeSessionId) {
      resumeSessionId = forkResumeSessionId
      sdkOptions.forkSession = true
      forkFromChannel = forkParsedKey?.channel
      forkFromChatId = forkParsedKey?.chatId
      console.log(`[AppChat][${appId}] Forking new local session from source SDK session ${forkResumeSessionId}`)
    }

    // No displayModel: app-chat drives its own processStream(), so it must not
    // start a persistent session consumer (that would fight over the stream).
    const v2Session = await getOrCreateV2Session(
      spaceId,
      conversationId,
      sdkOptions,
      resumeSessionId,
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

    // Accumulate the final reply text from raw SDK assistant messages. Keeps the
    // last contiguous run of text blocks so multi-segment answers survive intact
    // (a tool_use resets the run — preceding text is intermediate narration).
    // This is the authoritative source for IM replies; reading directly from SDK
    // output sidesteps processStream's lastTextContent dual-path pollution.
    const replyAccumulator = new ReplyTextAccumulator()

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

            // Fork established: the captured id is the NEW forked session
            // (distinct from the source). Clear the pending marker so later
            // messages resume this session normally instead of re-forking.
            if (forkFromChannel && forkFromChatId) {
              getImSessionRegistry()?.clearPendingResume(appId, forkFromChannel, forkFromChatId)
            }
          }

          // App chat doesn't use conversation.service for storage.
          // Messages are persisted to JSONL via onRawMessage for reload.
          const assistantText = replyAccumulator.getReply()
          const replyContent = assistantText || streamResult.finalContent
          console.log(
            `[AppChat][${appId}] Stream complete: ` +
            `content=${replyContent.length} chars` +
            `${assistantText ? ' (from SDK message)' : ' (from streamResult)'}, ` +
            `thoughts=${streamResult.thoughts.length}, ` +
            `tokens=${streamResult.tokenUsage ? 'yes' : 'no'}`
          )

          // Invoke onReply callback for external bridges (WeCom Bot auto-reply).
          // Always fire when content exists — including the whitespace-only
          // empty-response placeholder — because the bridge's onReply is what
          // terminates a streaming IM session. Whether the placeholder is shown
          // or replaced with a notice is the bridge's decision, not ours.
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

          // Accumulate assistant text for the IM reply. SDK assistant messages
          // carry complete text blocks in order, so the accumulator can track
          // the last contiguous run across a multi-step (text/tool_use) flow.
          replyAccumulator.feed(sdkMessage)

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
 * Stop generation for a single app-chat conversation (native default, native
 * local, or IM session). Used so stopping one session does not interrupt the
 * app's other concurrently-generating sessions.
 *
 * @param conversationId - The specific session to stop
 */
export async function stopAppChatConversation(conversationId: string): Promise<void> {
  await stopGeneration(conversationId)
  console.log(`[AppChat] Generation stopped for conversation: ${conversationId}`)
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
 * Whether a single conversation is generating, for the HTTP status endpoint's
 * per-conversation polling. (isAppChatGenerating reports across all sessions.)
 */
export function isAppChatConversationGenerating(conversationId: string): boolean {
  return activeSessions.has(conversationId)
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
 * Load persisted chat messages for any app-chat conversation by its
 * conversationId (native default, native local, IM, or HTTP). Derives the JSONL
 * runId from the key and reads the transcript. Used by the messages IPC/HTTP
 * path when a specific session is requested.
 *
 * @param spacePath - Space directory path
 * @param appId - App ID
 * @param conversationId - Full app-chat conversationId
 */
export function loadChatMessagesForConversation(
  spacePath: string,
  appId: string,
  conversationId: string
): any[] {
  return readSessionMessages(spacePath, appId, deriveRunId(conversationId, appId))
}

/**
 * Get session state for recovery after page refresh.
 *
 * @param appId - App ID
 * @param conversationId - Optional specific session; defaults to the app's
 *   native default session ("app-chat:{appId}"). Native local sessions pass
 *   their own "app-chat:{appId}:local:direct:{uuid}" key.
 */
export function getAppChatSessionState(appId: string, conversationId?: string): {
  isActive: boolean
  thoughts: any[]
  spaceId?: string
} {
  const convId = conversationId ?? getAppChatConversationId(appId)
  const session = activeSessions.get(convId)
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
export async function clearAppChat(appId: string, spaceId: string, conversationId?: string): Promise<void> {
  // Default to the app's native default session. Native local sessions pass
  // their own key so only that session's history is reset. Guard: the key must
  // belong to this app's app-chat namespace, so an arbitrary key can't be used
  // to clear unrelated storage.
  const convId = conversationId ?? getAppChatConversationId(appId)
  const defaultConvId = getAppChatConversationId(appId)
  if (convId !== defaultConvId) {
    const parsed = parseAppChatKey(convId)
    if (!parsed || parsed.appId !== appId) {
      throw new Error(`Invalid conversationId for clear: ${convId}`)
    }
    // IM sessions have a dedicated clear path (clearImSession); refuse to reset
    // their transcript here so a caller on this entry point can only touch the
    // native default, local, or HTTP sessions of the same app.
    if (classifySessionSource(parsed.channel) === 'im') {
      throw new Error(`Cannot clear IM session via clearAppChat: ${convId}`)
    }
  }
  await clearSessionByConversationId(convId, appId, spaceId)
  console.log(`[AppChat][${appId}] Chat history cleared: ${convId}`)
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
 * In-flight handling depends on `interruptActive`:
 *   - false (default, all automatic config-change restarts): a mid-generation
 *     session is LEFT ALONE — the reply is not dropped. Its session-inputs
 *     fingerprint (systemPrompt + MCP set + guest permission envelope) has
 *     changed, so the very next message rebuilds it with the new wiring. Only
 *     idle sessions are torn down eagerly.
 *   - true (manual "Restart agent" only): a mid-generation session is aborted
 *     via `stopGeneration()` first — the UI banner warns that work in progress
 *     is stopped.
 *
 * Idempotent: returns `sessionsClosed: 0` when nothing is active.
 *
 * @param appId - App ID
 * @param options.interruptActive - Abort in-flight turns (manual restart only). Default false.
 * @returns Count of sessions that were closed
 */
export async function restartAppChat(
  appId: string,
  options: { interruptActive?: boolean } = {}
): Promise<{ sessionsClosed: number }> {
  const { interruptActive = false } = options
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
  let deferred = 0
  for (const convId of sessionIds) {
    try {
      const isActive = activeSessions.has(convId)

      // Mid-generation + non-interrupting edit: leave the live turn to finish.
      // The fingerprint rebuilds this session on its next message.
      if (isActive && !interruptActive) {
        deferred++
        continue
      }

      // 1. Abort any in-flight generation before closing the underlying session.
      if (isActive) {
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

  console.log(
    `[AppChat][${appId}] Restart complete: ${closed} session(s) closed` +
    `${deferred > 0 ? `, ${deferred} deferred to next message` : ''} (history preserved)`
  )
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

// ============================================
// Native Multi-Session Lifecycle
// ============================================
//
// The desktop user can open multiple named chat windows for one digital human,
// alongside the legacy default session ("app-chat:{appId}"). Each extra window
// is a 'local'-source session keyed "app-chat:{appId}:local:direct:{uuid}",
// reusing the same send/JSONL/registry plumbing as IM sessions. Listing and
// renaming reuse the generic im-sessions APIs (getAllSessions / setCustomName);
// only create, fork, and delete need dedicated lifecycle here.

/** Result of creating or forking a native local chat session. */
export interface NativeSessionResult {
  /** Virtual conversationId for the new session */
  conversationId: string
  /** The persisted session record */
  record: ImSessionRecord
}

/**
 * Create a fresh native local chat session for an app.
 *
 * No files are written until the first message; only the registry record is
 * created so the session appears in the list immediately. The renderer
 * localizes the display label (first-message preview / "New chat").
 */
export function createNativeChatSession(appId: string): NativeSessionResult {
  const registry = getImSessionRegistry()
  if (!registry) throw new Error('IM session registry not initialized')

  const sessionUuid = randomUUID()
  const record = registry.createLocalSession(appId, sessionUuid)
  const conversationId = buildLocalSessionKey(appId, sessionUuid)
  console.log(`[AppChat][${appId}] Native local session created: ${conversationId}`)
  return { conversationId, record }
}

/**
 * Fork an existing session (IM/http/local) into a new native local session
 * that continues in the client with the full prior context.
 *
 * Copies the source transcript so the new window shows history immediately, and
 * records the source SDK session id as a pending resume-and-fork marker. On the
 * new session's first message, sendAppChatMessage resumes that source context
 * and branches to a fresh SDK session id (see forkResumeSessionId), so the two
 * windows evolve independently and the source is never polluted.
 *
 * Requires the active engine to support session forking; callers gate the UI on
 * the `sessionFork` capability before invoking this.
 */
export function forkNativeChatSession(
  appId: string,
  spaceId: string,
  sourceConversationId: string
): NativeSessionResult {
  const registry = getImSessionRegistry()
  if (!registry) throw new Error('IM session registry not initialized')

  // Trust boundary: the source must belong to this app. Forking legitimately
  // sources any of the app's own sessions (native default, IM, http, local),
  // but a key owned by another app must never be readable through this entry
  // point. The native default key ("app-chat:{appId}") parses to null, so it is
  // allowed explicitly; every other form must parse and match appId.
  const defaultKey = getAppChatConversationId(appId)
  if (sourceConversationId !== defaultKey) {
    const parsedSource = parseAppChatKey(sourceConversationId)
    if (!parsedSource || parsedSource.appId !== appId) {
      throw new Error(`Invalid sourceConversationId for fork: ${sourceConversationId}`)
    }
  }

  const spacePath = getSpace(spaceId)?.path ?? ''
  const sessionUuid = randomUUID()
  const conversationId = buildLocalSessionKey(appId, sessionUuid)

  const sourceRunId = deriveRunId(sourceConversationId, appId)
  const newRunId = deriveRunId(conversationId, appId)

  // Copy the source transcript for immediate display, and read the source SDK
  // session id to seed the resume-and-fork on first message. Both are
  // best-effort: absent history/session degrade to a fresh window.
  let copied = false
  let sourceSdkSessionId: string | undefined
  if (spacePath) {
    copied = copySessionJsonl(spacePath, appId, sourceRunId, newRunId)
    sourceSdkSessionId = loadChatSessionId(spacePath, appId, sourceRunId)
  }

  const record = registry.createLocalSession(appId, sessionUuid, {
    forkOrigin: sourceConversationId,
    pendingResumeSessionId: sourceSdkSessionId,
  })

  console.log(
    `[AppChat][${appId}] Forked native local session ${conversationId} from ${sourceConversationId} ` +
    `(transcript ${copied ? 'copied' : 'absent'}, resume ${sourceSdkSessionId ? 'seeded' : 'none'})`
  )
  return { conversationId, record }
}

/**
 * Delete a native local chat session: abort any generation, tear down the V2
 * session and browser context, empty its transcript, and remove the registry
 * record. Only 'local'-source sessions are deletable this way; other keys are
 * rejected so the default session and IM sessions can't be removed here.
 */
export async function deleteNativeChatSession(
  appId: string,
  spaceId: string,
  conversationId: string
): Promise<void> {
  const parsed = parseAppChatKey(conversationId)
  if (!parsed || parsed.appId !== appId || parsed.channel !== LOCAL_SESSION_CHANNEL) {
    throw new Error(`Not a deletable native local session: ${conversationId}`)
  }

  await clearSessionByConversationId(conversationId, appId, spaceId)
  getImSessionRegistry()?.removeSession(appId, parsed.channel, parsed.chatId)
  console.log(`[AppChat][${appId}] Native local session deleted: ${conversationId}`)
}
