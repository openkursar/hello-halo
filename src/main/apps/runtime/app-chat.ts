/**
 * apps/runtime -- App Chat
 *
 * Interactive chat entry point for automation Apps.
 * Allows users to chat with an App's AI agent in real-time,
 * reusing the main Agent's session + consumption machinery.
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
 * - This module owns the *entry* half: prompt assembly, tool/permission
 *   envelope, credentials, and dispatching the message.
 * - Consumption is the shared persistent consumer (services/agent/session-
 *   consumer.ts), so CC output produced between messages — a finished
 *   background task, a team agent's turn — is read as it appears instead of
 *   waiting in the pipe for the next message to pick up as its own answer.
 * - Turn results land in the app-chat sink (app-chat-sink.ts): JSONL
 *   persistence plus delivery to whoever sent the message.
 * - Renderer events flow via the virtual conversationId "app-chat:{appId}";
 *   the frontend subscribes to agent:* filtered by it.
 */

import { writeFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getAppManager } from '../manager'
import { analytics } from '../../services/analytics/analytics.service'
import { AnalyticsEvents } from '../../services/analytics/types'
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
import { getEngineCapabilities } from '../../services/agent/resolved-sdk'
import { applyReasoningEffort } from '../../services/agent/reasoning-effort'
import { createCanUseTool } from '../../services/agent/permission-handler'
import { getImPermissionContext } from './im-permission-registry'
import { createAIBrowserMcpServer, createScopedBrowserContext } from '../../services/ai-browser'
import { createTerminalMcpServer, getGlobalTerminalContext, isTerminalAvailable } from '../../services/ai-terminal'
import type { BrowserContext } from '../../services/ai-browser/context'
import { buildMessageContent } from '../../services/agent/message-utils'
import { prepareNonVisionImageFallback } from '../../services/agent/image-attachments'
import {
  getOrCreateV2Session,
  closeV2Session,
  getConsumerHandle,
  getRunningConsumerIds,
  markTurnDispatched,
  updateConsumerDisplayModel,
  v2Sessions
} from '../../services/agent/session-manager'
import { stopGeneration, getSessionState } from '../../services/agent/control'
import {
  getAppChatSink,
  peekAppChatSink,
  hasActiveAppChatRound,
  getConversationsWithActiveRound,
  disposeAppChatSink,
  type AppChatRoundHandle,
} from './app-chat-sink'
import { isAppChatConversationGenerating } from './app-chat-live-turn'
// Re-exported, not defined here: the team runtime needs the same answer
// synchronously and cannot import this module (app-chat imports the team
// runtime accessor, so the edge back would close a cycle).
export { isAppChatConversationGenerating }
import { assembleAppChatPrompt } from './prompt/assembler'
import { buildIdentityFragments } from './prompt/identity'
import { buildDisabledCapabilitiesGuidance, buildUnconfiguredCapabilitiesGuidance } from './prompt/capabilities'
import { NATIVE_CHAT_ENTRY } from './prompt/entry-native'
import { buildImEntry, buildImConstraints, type ImSessionContext } from './im-channels/im-prompt'
import { buildTeamEntry, buildTeamConstraints, buildTeamImBridge } from './team/team-prompt'
import { getActiveTeamRuntime } from './team'
import { forgetTurnOrigin, resolveTurnOrigin } from './team/external-origin'
import { consumeIntentionalStop } from './intentional-stop'
import { createTeamMcpServer } from './team/team-tools'
import { TEAM_MCP_SERVER_NAME } from '../../../shared/apps/team-types'
import {
  applyCapabilityPolicy,
  describeAppliedPolicy,
  isBorrowedTeamTurn,
  resolveDelegationMode,
} from './capability-policy'
import {
  beginDelegatedTurn,
  clearDelegation,
  createDelegationAuditHooks,
  decideDelegatedTool,
} from './delegation-gate'
import type { CapabilityMode, CapabilityPolicy } from '../../../shared/apps/capability-policy'
import type { TeamTriggerContext } from '../../../shared/apps/team-types'
import { createFileSendMcpServer } from './im-channels/file-send-mcp'
import { mergeConfigWithDefaults } from './config-defaults'
import { tmpdir as osTmpdir } from 'os'
import { createNotifyToolServer } from './notify-tool'
import { buildQuoteFromMessage } from './pending-relays'
import { resolveNotifyAvailability } from './notify-availability'
import { FileExportGate } from './file-export-gate'
import { truncateUtf16Safe } from './text-truncate'
import { getImSessionRegistry } from './im-session-registry'
import {
  collectAppConversationIds,
  describeSelfInstance,
  listLiveInstances,
  noteInstanceTurnEnded,
  noteInstanceTurnStarted,
} from './live-instances'
import { createHaloAppsMcpServer } from '../conversation-mcp'
import { createOfficialDocsSession } from '../../services/official-docs-mcp'
import { createWebSearchMcpServer } from '../../services/web-search'
import { createOcrMcpServer } from '../../services/ocr'
import { createApiRefMcpServer, HALO_API_TOOLSET_ID } from '../../services/api-ref'
import { createEmailMcpServer } from '../../services/email-mcp'
import { getSpace, getSpaceDir } from '../../services/space.service'
import { readSessionMessages, saveChatSessionId, loadChatSessionId, deleteChatSessionId, copySessionJsonl } from './session-store'
import { getAppMemoryService, getActivityStore } from './index'
import { resolveExecutionEnvironment, validateExecutionEnvironment, legacySessionEnvironmentKey, resolveChatEnvironment, appChatRunId, validateEnvironmentConnections } from './execution-environment'
import { createPersonContextMcpServer, personContextPrompt } from './person-context-tool'
import type { PersonContextCaller } from '../../../shared/apps/person-context'
import { createMemoryStatusMcpServer } from '../../platform/memory/snapshot'
import { prepareMemoryForTurn, checkAndCompactMemory } from './turn/memory-lifecycle'
import { buildLiveInstancesSection, buildMemorySection } from './prompt'
import { createReportToolServer, type ReportToolContext } from './report-tool'
// Key builders live in shared/ so the renderer can import them without
// depending on main-process modules.
import { getAppChatConversationId, buildImSessionKey, buildTeamSessionKey, parseTeamSessionKey, buildLocalSessionKey, parseAppChatKey } from '../../../shared/apps/im-keys'
import { classifySessionSource, LOCAL_SESSION_CHANNEL, NATIVE_SESSION_CHANNEL, NATIVE_DEFAULT_CHAT_ID } from '../../../shared/types/im-channel'
import type { ImSessionRecord } from '../../../shared/types/im-channel'
import { sendToRenderer } from '../../foundation/window.service'
import { broadcastToAll } from '../../http/websocket'
import type { ProgressEvent } from '../../../shared/types/inbound-message'
import type { ImageAttachment } from '../../../shared/types/image-attachment'
import { ProgressEventParser } from './progress-formatter'
import { ReplyTextAccumulator } from './reply-accumulator'
import { flushSupplementBuffer, clearSupplementBuffer } from './dispatch-inbound'
import { getImStreamHandle, clearImStreamHandle } from './im-stream-registry'
export { getAppChatConversationId, buildImSessionKey }

// ============================================
// Constants
// ============================================

/**
 * The team's own coordination tools are the channel this turn arrives on, not a
 * capability the owner lends out: withholding them would not restrict a teammate,
 * it would cut the digital human off from the conversation it was woken for.
 */
const TEAM_CHANNEL_MCP: ReadonlySet<string> = new Set([TEAM_MCP_SERVER_NAME, 'halo-report', 'halo-person-context'])

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
  /** Callers MUST set conversationId = buildTeamSessionKey(appId, teamId). */
  teamContext?: TeamTriggerContext
  /**
   * Origin facts recorded against any notify_bot push this run makes, so the
   * target session can later attribute the push and report an outcome back.
   *
   * Supplied by the caller because only it has the raw inbound message: the
   * assembled `message` carries runtime tags and possibly a consumed relay
   * block, neither of which belongs in a quote. Absent for native chat, where
   * `message` is the user's own text.
   */
  relayOrigin?: {
    subject?: { id: string; name: string }
    quote?: string
  }
  /**
   * Invoked once the engine has accepted this message, i.e. the text is now
   * part of its conversation history. Callers use it to commit at-most-once
   * context they attached to the message; it never fires if the run fails
   * before reaching the engine.
   */
  onMessageAccepted?: () => void
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
export function deriveRunId(conversationId: string, appId: string): string {
  return appChatRunId(conversationId, appId)
}

/**
 * Scoped browser contexts for app chat sessions.
 * Each app chat gets its own context so activeViewId is isolated
 * from the user's browser and other concurrent sessions.
 * Cleaned up when the V2 session is closed (on error) or explicitly.
 */
const scopedContexts = new Map<string, BrowserContext>()

/** Registry coordinates (channel/chatId/chatType) a conversationId maps to. */
interface SessionRegistryTarget {
  channel: string
  chatId: string
  chatType: 'direct' | 'group'
}

/**
 * Resolve the registry coordinates for a conversationId, including the native
 * default session (the 2-segment "app-chat:{appId}" key that
 * {@link parseAppChatKey} deliberately returns null for). Returns null for
 * keys that don't belong to this app at all.
 */
function resolveSessionRegistryTarget(conversationId: string, appId: string): SessionRegistryTarget | null {
  if (conversationId === getAppChatConversationId(appId)) {
    return { channel: NATIVE_SESSION_CHANNEL, chatId: NATIVE_DEFAULT_CHAT_ID, chatType: 'direct' }
  }
  const parsed = parseAppChatKey(conversationId)
  if (!parsed || parsed.appId !== appId) return null
  return { channel: parsed.channel, chatId: parsed.chatId, chatType: parsed.chatType }
}

/**
 * Notify desktop + remote clients that a session's registry summary changed,
 * so any conversation-list UI subscribed to `app:im-session-updated` refreshes
 * in real time instead of waiting for its fallback poll.
 */
function emitSessionUpdated(
  appId: string,
  target: SessionRegistryTarget,
  opts?: { lastMessage?: string; lastSender?: string }
): void {
  const sessionEvent = {
    appId,
    channel: target.channel,
    chatId: target.chatId,
    chatType: target.chatType,
    instanceId: '',
    lastMessage: opts?.lastMessage !== undefined ? truncateUtf16Safe(opts.lastMessage, 50) : undefined,
    lastSender: opts?.lastSender,
  }
  sendToRenderer('app:im-session-updated', sessionEvent)
  broadcastToAll('app:im-session-updated', sessionEvent)
}

/**
 * The `## Memory` block a session opens with — the same block an automation run
 * gets, because it is the same digital human with the same memory whether it is
 * working alone, talking to its owner, or working inside a team. No `# History`
 * heading is pre-inserted: a session spans many turns, and the heading marks a
 * unit of work, not a turn (see MemoryPrepareOptions).
 *
 * Best-effort — a memory read fault must cost the turn its context, not the turn.
 */
async function buildSessionMemoryPreamble(scope: MemoryCallerScope, appId: string): Promise<string> {
  try {
    const { snapshot } = await prepareMemoryForTurn(scope, { preInsertHistory: false })
    return `${buildMemorySection(snapshot)}\n\n`
  } catch (err) {
    console.error(`[AppChat][${appId}] Memory snapshot failed, continuing without it:`, err)
    return ''
  }
}

/**
 * Register or refresh an app-chat session's registry record so it carries a
 * message-activity summary (lastMessage/lastActiveAt/messageCount) for the
 * conversation list, without the caller loading the full JSONL transcript.
 *
 * IM sessions are skipped: dispatch-inbound already registers them with a live
 * instanceId, and re-registering here with an empty instanceId would clobber
 * that binding and break IM push. The native default session is registered
 * under a synthetic {@link NATIVE_SESSION_CHANNEL} coordinate (see
 * {@link resolveSessionRegistryTarget}) purely for this summary — it has no
 * channel adapter and is never pushable.
 */
function registerExternalChatSession(
  conversationId: string,
  appId: string,
  opts?: { displayName?: string; lastSender?: string; lastMessage?: string }
): void {
  const target = resolveSessionRegistryTarget(conversationId, appId)
  if (!target) return
  if (classifySessionSource(target.channel) === 'im') return

  const registry = getImSessionRegistry()
  if (!registry) return

  registry.register(appId, target.channel, target.chatId, target.chatType, '', {
    displayName: opts?.displayName,
    lastSender: opts?.lastSender,
    lastMessage: opts?.lastMessage,
  })

  emitSessionUpdated(appId, target, { lastMessage: opts?.lastMessage, lastSender: opts?.lastSender })
}

// ============================================
// Core
// ============================================

/**
 * Send a chat message to an automation App's AI agent.
 *
 * Setup failures (the app is gone, services not up, credentials unusable) happen
 * before the turn exists to report them, and every transport that calls this does
 * so fire-and-forget — so they are reported on the same error channel a failed
 * turn uses, then rethrown for the caller's own logging. Without it, sending to a
 * digital human that no longer exists looks exactly like sending to one that does.
 */
export async function sendAppChatMessage(request: AppChatRequest): Promise<void> {
  const conversationId = request.conversationId ?? getAppChatConversationId(request.appId)
  try {
    await runAppChatTurn(request)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[AppChat][${request.appId}] Chat could not start: ${message}`)
    emitAgentEvent('agent:error', request.spaceId, conversationId, { type: 'error', error: message })
    throw error
  }
}

/**
 * One chat turn against an automation App's AI agent.
 *
 * This provides real-time streaming with the same capabilities as the main
 * conversation agent: thinking, tool use, token tracking, interruption.
 *
 * The V2 session is reused across messages (keyed by "app-chat:{appId}"),
 * providing in-memory conversation continuity without session restart.
 *
 * @param request - Chat request parameters
 */
async function runAppChatTurn(
  request: AppChatRequest
): Promise<void> {
  const {
    appId, message, images, thinkingEnabled, onReply, onProgress,
    imFileSend, senderIdentity, imSession, teamContext, relayOrigin, onMessageAccepted,
  } = request
  const conversationId = request.conversationId ?? getAppChatConversationId(appId)

  console.log(`[AppChat][${appId}] sendMessage: "${message.substring(0, 100)}"`)

  // ── 1. Resolve app + credentials ─────────────────────
  const manager = getAppManager()
  if (!manager) throw new Error('App services not initialized')

  const app = manager.getApp(appId)
  if (!app) throw new Error(`App not found: ${appId}`)
  const activityStore = getActivityStore()
  if (!activityStore) throw new Error('Session environment storage is unavailable')
  const environment = resolveChatEnvironment(app, manager, activityStore, conversationId, teamContext?.teamId)
  const spaceId = environment.spaceId!

  // Counted here, not at the IPC/HTTP handlers, so every entry point into
  // digital-human chat (desktop IPC, remote HTTP, IM inbound) is covered by
  // one call site. `channel` separates those entries; IM additionally counts
  // arrivals in dispatch-inbound, which includes messages rejected before
  // they reach this function.
  void analytics.track(AnalyticsEvents.MESSAGE_SENT, {
    source: 'app-chat',
    direction: 'inbound',
    channel: parseAppChatKey(conversationId)?.channel ?? 'native',
    appId,
    specId: app.specId,
    conversationId,
    hasImages: Array.isArray(images) && images.length > 0,
  })

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
  const workDir = environment.workDir

  // Non-vision models can't receive image blocks: persist images to files and
  // inject their paths for the ocr_image tool (mirrors send-message.ts). No
  // toolset open needed — app chat seeds the OCR MCP server unconditionally
  // at session creation.
  const imageFallback = prepareNonVisionImageFallback({
    scope: { spaceId, conversationId, workDir },
    credentials,
    images
  })

  // ── 2. Build memory scope ────────────────────────────
  const memoryScope: MemoryCallerScope = {
    type: 'app',
    spaceId,
    spacePath: environment.spacePath,
    appId: app.id,
    appDataPath: environment.memoryDir,
  }

  // This turn's membership, resolved before the identity layer: the team Entry
  // renders it below, and `selfIsDisposable` (see team-prompt.ts for the
  // contract) decides which surfaces the turn mounts — a disposable member gets
  // no memory and no digital-human management.
  const teamPromptCtx = teamContext
    ? getActiveTeamRuntime()?.buildPromptContext(teamContext.teamId, appId) ?? null
    : null
  const disposableMember = teamPromptCtx?.selfIsDisposable === true

  // ── 3. Build system prompt for interactive chat ──────
  const memoryInstructions = disposableMember ? '' : memory.getPromptInstructions('session')
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
  const personCaller: PersonContextCaller = {
    appId,
    capabilityMode: 'chat',
    environmentSpaceId: spaceId,
    authority: permCtx?.isOwner === false ? 'guest'
      : teamContext && (teamContext.kind !== undefined || !!imSession) ? 'team' : 'owner',
    ...(teamContext ? { teamId: teamContext.teamId, epochId: teamContext.epochId } : {}),
  }

  // Default OFF, unlike the other built-in capabilities: this one operates
  // Halo's own configuration and data, which is not a sensible default for a
  // digital human the user installed to do something else.
  //
  // Never for guests. `filterMcpServersByPolicy` already withholds the server
  // (it is in neither guest map, and unknown ids are not injected), so the
  // credentials and the usage guide have to be withheld here too — otherwise
  // an outside sender gets a prompt describing a tool the session does not have.
  const usesHaloApi =
    resolvePermission(app, HALO_API_TOOLSET_ID, false) && permCtx?.isOwner !== false

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
    usesHaloApi,
    workDir,
    modelInfo: resolvedCreds.displayModel,
    disabledCapabilities: buildDisabledCapabilitiesGuidance(app) ?? undefined,
    unconfiguredCapabilities: buildUnconfiguredCapabilitiesGuidance(app, {
      emailChannelConfigured: notifyAvail.emailChannelConfigured,
      imContactsAvailable: notifyAvail.imContactsAvailable,
    }) ?? undefined,
  })
  if (personCaller.authority !== 'guest') identity.push(personContextPrompt(personCaller))
  // Team turns take precedence over IM (trusted member, no guest restrictions).
  // When a team turn ALSO arrives over an IM channel (a team-backed IM instance),
  // the bound member keeps its team identity + tools and gains a front-desk
  // bridge so it replies to the person in-chat. It runs as a trusted team peer,
  // so IM guest hardening (buildImConstraints) is intentionally NOT applied.
  // Where the work this turn continues was asked for. Resolved once, here,
  // because the answer is needed in three places that cannot each re-derive it:
  // the team tools this turn sends with, what the turn is allowed to do, and
  // the owner's record of it. Not read from the trigger alone — a wake authored
  // by the runtime here (an answered question, a periodic check) carries no
  // origin of its own; see team/external-origin.ts.
  const externalOrigin = teamContext ? resolveTurnOrigin(conversationId, teamContext) : false

  if (teamContext) {
    // Every team turn (user/IM/teammate) stamps the epoch's activity, and wakes
    // it when hibernated so coordination resumes and member replies route back.
    const fromHuman = !teamContext.kind || teamContext.kind === 'human_message'
    if (getActiveTeamRuntime()?.noteEpochTurn(teamContext.teamId, teamContext.epochId, fromHuman) === false) throw new Error('This task is closed; a human must resume it.')
    // Auto-name a native "New session" from the person's first message (parity
    // with the space chat). A teammate-driven turn's input is a relayed
    // envelope, never the user's words.
    getActiveTeamRuntime()?.maybeAutoNameConversation(teamContext.teamId, teamContext.epochId, fromHuman, message)
  }
  let entry: string
  let constraints: string[]
  if (teamPromptCtx) {
    entry = imSession
      ? `${buildTeamEntry(teamPromptCtx)}\n\n${buildTeamImBridge(imSession, teamPromptCtx.selfIsLead)}`
      : buildTeamEntry(teamPromptCtx)
    constraints = buildTeamConstraints(teamPromptCtx)
  } else if (imSession) {
    entry = buildImEntry(imSession, permCtx?.ownerIds, {
      channelsConfigured: notifyAvail.channelsConfigured,
      notifyBotAvailable: notifyAvail.notifyBotAvailable,
    })
    constraints = buildImConstraints(imSession, permCtx?.ownerIds)
  } else {
    entry = NATIVE_CHAT_ENTRY
    constraints = []
  }
  const systemPrompt = assembleAppChatPrompt({ identity, entry, constraints })

  // ── 4. Build MCP servers ─────────────────────────────
  const memoryMcpServer = disposableMember ? null : createMemoryStatusMcpServer(memoryScope)

  validateEnvironmentConnections(environment, app, manager, 'chat')
  const disabledMcpIds = new Set(
    (app.spec.requires?.mcps ?? []).filter(dependency => dependency.enabled === false).map(dependency => dependency.id)
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
  const exportGate = new FileExportGate([environment.workDir, osTmpdir()])
  const notifyMcpServer = createNotifyToolServer({
    appId: app.id,
    appName: app.spec.name,
    runId: deriveRunId(conversationId, appId),
    imSessions,
    usesImPush,
    exportGate,
    // Relay provenance: pushes from this chat are recorded against their
    // target sessions with this run as the traceable origin. Native chat has
    // no permCtx and counts as owner (the desktop user).
    relay: {
      sessionKey: conversationId,
      contact: imSession?.sessionId,
      subject: relayOrigin?.subject ?? senderIdentity,
      isOwner: permCtx ? permCtx.isOwner : true,
      quote: relayOrigin?.quote ?? buildQuoteFromMessage(message, senderIdentity?.name),
    },
  })
  // report_to_user is injected ONLY for team turns (escalation routing to the
  // lead / user). It is deliberately NOT injected in plain chat/IM: it writes to
  // activity_entries whose run_id FKs automation_runs, which chat sessions lack,
  // so a call there fails the FK constraint and the model retries in a loop
  // (issue #200). Plain chat replies reach the user directly as text.
  const reportContext: ReportToolContext = {
    appId: app.id,
    appName: app.spec.name,
    runId: CHAT_RUN_ID,
    sessionKey: conversationId,
    notificationLevel: app.userOverrides?.notificationLevel,
    // Team turns route report() to the team runtime instead of the inbox. The
    // RESOLVED origin is what travels, not the trigger's own stamp: a runtime
    // wake carries none, and an escalation raised in this turn must persist the
    // origin the turn actually ran under (see resumeFromEscalation).
    ...(teamContext ? { teamContext: { ...teamContext, external: externalOrigin } } : {}),
  }

  // Built-in server ids below are mirrored in shared/apps/builtin-mcp.ts — keep in sync.
  // Documentation is unconditional: the digital-humans switch decides whether
  // apps can be managed here, not whether Halo can describe itself.
  const { server: docsMcpServer, guideConsulted } = createOfficialDocsSession()
  const mcpServers: Record<string, any> = {
    ...(dbMcpServers ?? {}),
    ...(memoryMcpServer ? { 'halo-memory': memoryMcpServer } : {}),
    'halo-notify': notifyMcpServer,
    'halo-docs': docsMcpServer,
    ...(personCaller.authority !== 'guest' ? { 'halo-person-context': createPersonContextMcpServer(personCaller) } : {}),
    ...(digitalHumansEnabled && !disposableMember
      ? { 'halo-apps': createHaloAppsMcpServer(spaceId, guideConsulted, { omitPersonContext: true }) }
      : {}),
    'web-search': createWebSearchMcpServer(),
    'ocr': createOcrMcpServer(),
    ...(usesAIBrowser ? { 'ai-browser': createAIBrowserMcpServer(scopedBrowserCtx, workDir) } : {}),
    ...(usesTerminal
      ? { 'ai-terminal': createTerminalMcpServer(getGlobalTerminalContext(workDir), { spaceId, workDir }) }
      : {}),
    ...(usesHaloApi ? { 'halo-api-ref': createApiRefMcpServer() } : {}),
    ...(usesEmail && config.notificationChannels?.email?.enabled
      ? { 'halo-email': createEmailMcpServer(config.notificationChannels.email) }
      : {}),
    // Inject file-send tool when the originating IM channel supports file delivery
    ...(imFileSend ? { 'im-file-send': createFileSendMcpServer(imFileSend) } : {}),
    // report_to_user for team turns only (escalation routing); see reportContext note.
    // A question to the user ends the turn that asked it — the sink is looked up
    // when the tool fires rather than captured here, because it is created later
    // in this same call and outlives the session underneath it.
    ...(teamContext && activityStore
      ? {
          'halo-report': createReportToolServer(activityStore, reportContext, () => {
            peekAppChatSink(conversationId)?.noteAskedUser()
          }),
        }
      : {}),
    // Team coordination tools (team-channel turns only).
    ...(teamContext && teamPromptCtx && getActiveTeamRuntime()
      ? {
          [TEAM_MCP_SERVER_NAME]: createTeamMcpServer({
            teamId: teamContext.teamId,
            epochId: teamContext.epochId,
            callerAppId: app.id,
            collabMode: teamPromptCtx.collabMode,
            selfIsLead: teamPromptCtx.selfIsLead,
            // The agent's own cwd: published refs are resolved against it, so it
            // must be the very directory this turn runs in.
            callerWorkDir: workDir,
            bus: getActiveTeamRuntime()!.bus,
            blackboard: getActiveTeamRuntime()!.blackboard,
            // Location-transparent artifact read (wired by bootstrap); absent →
            // the tool reports the capability is unavailable.
            ...(getActiveTeamRuntime()!.readArtifact
              ? { readArtifact: getActiveTeamRuntime()!.readArtifact }
              : {}),
            checks: getActiveTeamRuntime()!.checks,
            digest: getActiveTeamRuntime()!.digest,
            archive: getActiveTeamRuntime()!.archive,
            // Stamped onto the messages this turn sends, so the circuit
            // breaker's depth limit spans hops.
            forwardDepth: teamContext.forwardDepth,
            // Same reasoning, different property of the chain: where it started.
            ...(externalOrigin ? { external: true } : {}),
            // Lead-only team_complete → deferred seal after the lead's turn ends.
            requestComplete: (summary) =>
              getActiveTeamRuntime()!.requestSeal(teamContext.teamId, teamContext.epochId, summary),
          }),
        }
      : {}),
  }
  // `disposableMember` rides this line rather than one of its own: when a member
  // has no memory and no digital-human tools, this is the record that says the
  // absence was the rule and not a mount that failed.
  console.log(
    `[AppChat][${appId}] MCP servers: [${Object.keys(mcpServers).join(', ')}], ` +
    `aiBrowser=${usesAIBrowser}, email=${usesEmail}, fileSend=${imFileSend ? 'yes' : 'no'}, ` +
    `disposableMember=${disposableMember}`
  )

  // ── 5. Build SDK options ─────────────────────────────
  const sdkOptions = await buildBaseSdkOptions({
    selfApiAccess: usesHaloApi,
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

  const thinkingBudget = applyReasoningEffort(sdkOptions, thinkingEnabled, resolvedCreds.capabilities)

  // Override for app chat context
  sdkOptions.systemPrompt = systemPrompt

  // Non-native sessions (IM channels, etc.) are non-interactive — the user
  // cannot respond to interactive tool prompts, so deny them preemptively.
  //
  // The per-call gate is installed on every non-native session, not only the
  // ones currently restricted: it reads what the turn in flight registered, and
  // a session outlives the turn that created it. Without it a session built for
  // one caller would keep answering for the next, whoever that turns out to be.
  // It is inert while nothing is registered, so an unrestricted turn is
  // unaffected.
  const defaultConvId = getAppChatConversationId(appId)
  if (conversationId !== defaultConvId) {
    sdkOptions.canUseTool = createCanUseTool({
      spaceId,
      conversationId,
      nonInteractive: true,
      gate: (toolName, toolInput) => decideDelegatedTool(conversationId, toolName, toolInput),
    })
  }

  // ── What somebody OTHER than the owner may make this digital human do ──
  //
  // Two callers ask this question and get the same answer from the same place:
  // an IM guest (a stranger in a chat window — silence refuses) and a teammate
  // driving a team turn. The teammate's reading depends on where the request
  // came from: one that entered this machine from outside is held to what the
  // owner granted teammates, one that started here is not (see
  // `resolveDelegationMode`).
  //
  // permCtx was read earlier (before system prompt build) for ownerIds injection.
  const borrowedTeamTurn = !!teamContext && isBorrowedTeamTurn(teamContext.kind, !!imSession)
  let delegation: { policy: CapabilityPolicy | undefined; mode: CapabilityMode } | null = null
  if (permCtx && !permCtx.isOwner) {
    delegation = { policy: permCtx.guestPolicy, mode: 'strict' }
  } else if (borrowedTeamTurn && teamContext) {
    delegation = {
      policy: getActiveTeamRuntime()?.getDelegatedPolicy(teamContext.teamId, appId) ?? undefined,
      mode: resolveDelegationMode({ external: externalOrigin }),
    }
  }

  let applied: ReturnType<typeof applyCapabilityPolicy> | null = null
  if (delegation) {
    applied = applyCapabilityPolicy(sdkOptions, {
      policy: delegation.policy,
      mode: delegation.mode,
      mcpServers,
      dbMcpServers,
      // The team's own coordination tools are the channel this turn happens on,
      // not a capability: withholding them isolates the member instead of
      // restricting the caller. An IM guest's turn has no such channel.
      alwaysKeep: borrowedTeamTurn ? TEAM_CHANNEL_MCP : undefined,
    })
    if (applied.enforced) {
      // A restriction the engine would accept and ignore is worse than one the
      // owner is told they cannot have: it reads as protection while the
      // request runs with everything. An engine that cannot be asked is read
      // the same way as one that says no.
      const engine = getEngineCapabilities()
      if (!engine?.features.permissionRules) {
        throw new Error(
          `"${app.spec.name}" is running on ${engine?.displayName ?? 'an engine'}, which cannot hold ` +
          `someone else's request to what you allowed, so the request was not started. ` +
          `Switch Halo's agent engine to Claude Code to let teammates put your digital humans to work.`
        )
      }
      sdkOptions.hooks = createDelegationAuditHooks(conversationId)
    }
    console.log(
      `[AppChat][${appId}] Borrowed turn ` +
      `(${permCtx && !permCtx.isOwner ? `guest=${permCtx.senderId}` : `teammate=${teamContext?.fromAppId ?? 'person'}`}): ` +
      describeAppliedPolicy(applied, delegation.policy, delegation.mode)
    )
  }

  // ── Resolve space path and run ID early (needed for both session resume and JSONL) ──
  const spacePath = environment.spacePath
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

  // The sink outlives individual V2 sessions: it owns the transcript writer and
  // the queue of messages awaiting an answer, so a session rebuild underneath it
  // never orphans a caller.
  const sink = getAppChatSink({ appId, conversationId, runId: chatRunId, spacePath })

  // Put this turn's terms in force for the per-call gate and the owner's
  // record. Registered before the session is touched: a session build can
  // itself fail, and the terms must already be the ones a tool call would be
  // judged by if it somehow got that far.
  //
  // Registered for an unrestricted turn too, with nothing to withhold — that is
  // what replaces the terms a previous, restricted turn left on the same
  // conversation, so the owner does not inherit a teammate's limits.
  if (conversationId !== defaultConvId) {
    beginDelegatedTurn(conversationId, {
      policy: applied?.enforced ? delegation?.policy : undefined,
      mode: applied?.enforced ? delegation!.mode : 'permissive',
      ...(applied?.enforced && borrowedTeamTurn && teamContext
        ? {
            audit: {
              teamId: teamContext.teamId,
              epochId: teamContext.epochId,
              appId,
              actorAppId: teamContext.fromAppId,
              external: externalOrigin,
              sink: (entry) => getActiveTeamRuntime()?.recordToolAudit(entry),
            },
          }
        : {}),
    })
  }

  let round: AppChatRoundHandle | undefined
  // Carried to the finally below, which is where a team turn's ending is
  // reported: the block runs for every exit, but only the catch knows which one.
  let turnFailure: string | null = null
  let finalReply: string | undefined
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
    // two windows evolve independently. The captured new id is persisted by the
    // sink, which also clears the pending marker, so later messages take the
    // normal resume path. Only reachable when the engine advertises sessionFork
    // (the fork UI is gated on it), so no engine guard is needed here.
    let resumeSessionId = savedSessionId
    if (!resumeSessionId && forkResumeSessionId) {
      resumeSessionId = forkResumeSessionId
      sdkOptions.forkSession = true
      console.log(`[AppChat][${appId}] Forking new local session from source SDK session ${forkResumeSessionId}`)
    }

    const v2Session = await getOrCreateV2Session(
      spaceId,
      conversationId,
      sdkOptions,
      resumeSessionId,
      workDir,
      { displayModel: resolvedCreds.displayModel, sink },
      undefined,
      undefined,
      undefined,
      // A restricted turn must run on a session actually built with its
      // restrictions. Reuse normally defers a rebuild while the session is busy
      // and hands back the one that exists — here that would run this request
      // with whatever the previous caller was allowed.
      applied?.enforced ? { requireFreshInputs: true } : undefined
    )

    // A reused session keeps the consumer it was created with; refresh the model
    // label so thought parsing stays correct after a model switch that did not
    // force a rebuild.
    updateConsumerDisplayModel(conversationId, resolvedCreds.displayModel)

    // Member status is derived from the ledger registered above, so the pulse
    // must follow that write — an earlier one re-reads the member as idle.
    const startedTeamSession = parseTeamSessionKey(conversationId)
    if (startedTeamSession) {
      const runtime = getActiveTeamRuntime()
      runtime?.noteMemberStatusChanged(startedTeamSession.teamId)
      // Opens the window this turn's board writes and messages are counted in,
      // so the report at the other end can say the member filed nothing without
      // guessing (see apps/runtime/team/turn-report.ts).
      runtime?.noteMemberTurnStarted(startedTeamSession)
    }

    // Set thinking tokens dynamically
    if (typeof v2Session.setMaxThinkingTokens === 'function') {
      try {
        await v2Session.setMaxThinkingTokens(thinkingBudget)
      } catch (e) {
        console.error(`[AppChat][${appId}] Failed to set thinking tokens:`, e)
      }
    }

    console.log(`[AppChat][${appId}] V2 session ready: ${Date.now() - t0}ms`)

    // ── 7. Persist the user message for reload recovery ──
    // Original images are persisted regardless of the vision fallback — they
    // feed the chat bubble display, not the model.
    sink.writeUserMessage(message, images, teamContext ? { kind: teamContext.kind ?? 'human_message', correlationId: teamContext.correlationId } : undefined)

    // ── 8. Dispatch and wait for this message's turn ────
    // Every session opens with the digital human's memory, the same way an
    // automation run does — otherwise it works for days, in a team or with its
    // owner, never seeing what it recorded before. Only on the first turn: the
    // V2 session carries the conversation forward, so the block stays in context
    // without being resent. Kept out of the JSONL trigger — the transcript shows
    // what was actually said, not our preamble. A disposable member has no
    // memory to open with (see `disposableMember`) — reading one would also
    // teach it that it has a file to maintain.
    const memoryPreamble =
      resumeSessionId || disposableMember ? '' : await buildSessionMemoryPreamble(memoryScope, appId)

    // Who else is executing this same digital human right now. Unlike the memory
    // block this goes on EVERY turn: it is true only at the moment it is built,
    // and a session that ran for an hour on a first-turn snapshot would be
    // reading a roster from an hour ago. It rides the user message rather than
    // the system prompt precisely because it changes every turn — the system
    // prompt is fingerprinted for session reuse (sdk-config.ts), so per-turn
    // content there would rebuild the session on every message.
    const selfInstance = describeSelfInstance(appId, { conversationId })
    const livePreamble =
      buildLiveInstancesSection(selfInstance, listLiveInstances(appId, selfInstance.id)) + '\n\n'

    // With the non-vision fallback active, image blocks are replaced by the
    // injected attachment-paths block.
    const messageContent = buildMessageContent(
      memoryPreamble + livePreamble + (imageFallback?.contextBlock ?? '') + message,
      imageFallback ? undefined : images
    )

    // Claim the next turn for this message. Enqueued immediately before send so
    // the window in which an autonomous turn could start first — and therefore
    // claim this round — is as narrow as the SDK allows.
    round = sink.beginRound({
      onProgress, onMessageAccepted,
      onReply: content => { finalReply = content; onReply?.(content) },
    })

    // Mark the dispatch BEFORE send: from here until system:init the consumer
    // looks idle, and an unguarded rebuild in that window would destroy this
    // message.
    markTurnDispatched(conversationId)
    // Stamps this conversation's start time so a concurrent instance can say
    // when it began. The entry is an annotation on a derived list, so a path
    // that skips it loses the time, never the entry (live-instances.ts).
    noteInstanceTurnStarted(conversationId)
    try {
      if (typeof messageContent === 'string') {
        v2Session.send(messageContent)
      } else {
        v2Session.send({ type: 'user', message: { role: 'user', content: messageContent } } as any)
      }
    } catch (sendErr) {
      // Nothing reached CC, so no turn will arrive to settle this round.
      round.cancel()
      throw sendErr
    }

    await round.done

    console.log(`[AppChat][${appId}] Chat message processed successfully`)
  } catch (error: unknown) {
    const err = error as Error
    turnFailure = err.message || 'Unknown error during app chat'

    console.error(`[AppChat][${appId}] Error:`, error)
    emitAgentEvent('agent:error', spaceId, conversationId, {
      type: 'error',
      error: err.message || 'Unknown error during app chat'
    })

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

    // Let the caller close out its transport (IM stream, HTTP client).
    throw err
  } finally {
    // For IM sessions (not the native app-chat key), destroy scoped browser context
    // on successful completion. The native app-chat key reuses its context across messages,
    // but IM sessions can accumulate unboundedly — clean up to prevent memory leaks.
    const defaultConvId = getAppChatConversationId(appId)
    if (conversationId !== defaultConvId) {
      // Round is over — drop the streaming handle registered by dispatch-inbound
      // so stopImSession can no longer reach it. Stale handles left from a prior
      // round would let stop() finish/dispose a stream that's already complete.
      clearImStreamHandle(conversationId)

      const ctx = scopedContexts.get(conversationId)
      if (ctx) {
        ctx.destroy()
        scopedContexts.delete(conversationId)
        console.log(`[AppChat][${appId}] IM scoped browser context destroyed (completion)`)
      }
    }

    console.log(`[AppChat][${appId}] Active session cleaned up`)

    noteInstanceTurnEnded(conversationId)

    // A TEAM-session turn ended — bus-driven, human 1:1, or IM alike.
    const endedTeamSession = parseTeamSessionKey(conversationId)
    if (endedTeamSession) {
      // Whether this member still owes its own person an answer is recomputed
      // here, not pushed from wherever the escalation was routed: this is the one
      // point every team-turn path converges on, and most of them (a teammate's
      // wake landing from another machine, an IM-backed turn, a 1:1 chat) never
      // touch that routing at all.
      try {
        getActiveTeamRuntime()?.reconcileAwaitingDecision(endedTeamSession.appId)
      } catch (err) {
        console.error(`[AppChat][${appId}] awaiting-decision reconcile failed:`, err)
      }
      // Only bus-driven turns get orchestration's own pulse, and only a HOSTED
      // office is re-baselined periodically, so a 1:1 turn would otherwise leave
      // the member's own machine showing it as working forever.
      getActiveTeamRuntime()?.noteMemberStatusChanged(endedTeamSession.teamId)
      // Tell the lead the member stopped. Nothing else will: the member's own
      // words reach no teammate, so a turn that ends without a team_send — the
      // ordinary shape of a model that quit early, crashed, or was stopped by
      // hand — otherwise leaves the run frozen with nobody woken to notice.
      try {
        getActiveTeamRuntime()?.noteMemberTurnEnded({
          ...endedTeamSession,
          // A hard stop (team mode kills the CC subprocess outright — see
          // control.ts's stopGeneration) lands in the same unconditional-
          // reject path a genuine crash does; consumeIntentionalStop is the
          // only thing that tells them apart (see intentional-stop.ts).
          fate: turnFailure
            ? consumeIntentionalStop(conversationId)
              ? { kind: 'stopped' }
              : { kind: 'error', message: turnFailure }
            : { kind: 'ended' },
          ...(teamContext?.correlationId ? { correlationId: teamContext.correlationId } : {}),
          triggerKind: teamContext?.kind ?? 'human_message',
          ...(teamContext?.kind && teamContext.kind !== 'human_message' ? {
            requestSummary: message.replace(/^\[[^\]\n]+\]\s*/, ''),
            requestFromAppId: teamContext.fromAppId,
            finalReply,
          } : {}),
        })
      } catch (err) {
        console.error(`[AppChat][${appId}] turn-end report failed:`, err)
      }
      // Nudge the bus mailbox: only bus-driven turns pass through completeTurn's
      // drain, so without this a lead kept busy by human 1:1 chat on the same
      // session key strands its teammates' buffered completions forever.
      // Deferred so the busy probe reads idle when the drain runs.
      setImmediate(() => {
        try {
          getActiveTeamRuntime()?.bus.drainMailbox(conversationId)
        } catch (err) {
          console.error(`[AppChat][${appId}] team mailbox drain failed:`, err)
        }
      })
    }

    // A session grows memory.md just like a run does, so it gets the same size
    // ceiling — a file that only automation runs keep in check would still bloat
    // for a digital human that mostly works in chats and teams. Costs nothing
    // until the threshold is crossed. Detached: housekeeping, not part of the turn.
    // The delegated fields belong here for the same reason they do on a run: a
    // source carrying no key of its own is routed by header, and without them
    // compaction takes the raw-SDK path with an empty key, fails, and quietly
    // installs the heuristic summary as the digital human's memory.
    // Skipped for a disposable member: it has no memory to keep in check.
    if (!disposableMember) {
      void checkAndCompactMemory(memory, memoryScope, app.spec.name, chatRunId, async () => ({
        anthropicApiKey: resolvedCreds.anthropicApiKey,
        anthropicBaseUrl: resolvedCreds.anthropicBaseUrl,
        sdkModel: resolvedCreds.sdkModel,
        provider: credentials.provider,
        oauthProvider: credentials.oauthProvider,
        delegatedAuth: credentials.delegatedAuth,
        delegatedRoutingHeader: resolvedCreds.delegatedRoutingHeader,
        capabilities: resolvedCreds.capabilities,
      }))
    }

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
 * Abort one conversation's turn and release the resources that would otherwise
 * outlive it. The single stop path for every caller — every entry point below
 * delegates here so no route can forget a step.
 *
 * Three things must happen together, in this order:
 *   1. Drop buffered supplements. `sendAppChatMessage`'s finally block flushes
 *      them, so leaving them queued restarts a round right after the stop.
 *   2. Dispose (not finish) the IM stream. Stop means "send nothing"; finish()
 *      would push a final message into the chat.
 *   3. Abort the generation.
 *
 * Steps 1–2 run even when nothing is generating: a crashed round can leave a
 * buffer entry or stream handle behind, and the next inbound message would pick
 * it up. Both are no-ops for native conversations, which never register either.
 *
 * @returns whether a generation was actually running
 */
async function stopConversation(conversationId: string): Promise<boolean> {
  const wasActive = isAppChatConversationGenerating(conversationId)

  clearSupplementBuffer(conversationId)

  const streamHandle = getImStreamHandle(conversationId)
  if (streamHandle) {
    try {
      streamHandle.dispose?.()
    } catch (err) {
      console.error(`[AppChat] Stream dispose failed: ${conversationId}`, err)
    }
  }
  clearImStreamHandle(conversationId)

  if (wasActive) await stopGeneration(conversationId)
  return wasActive
}

/**
 * Stop an active app chat generation.
 *
 * Stops the native Halo chat session AND all IM channel sessions for this app.
 *
 * @param appId - App ID to stop chat for
 */
export async function stopAppChat(appId: string): Promise<void> {
  const toStop = collectAppConversationIds(appId).filter(isAppChatConversationGenerating)
  for (const convId of toStop) {
    await stopConversation(convId)
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
  const wasActive = await stopConversation(conversationId)
  console.log(`[AppChat] Generation stopped for conversation: ${conversationId} (active=${wasActive})`)
}

/**
 * Check if an app chat session is currently generating.
 *
 * Returns true if the native chat OR any IM session for this app is active.
 *
 * @param appId - App ID to check
 */
export function isAppChatGenerating(appId: string): boolean {
  return collectAppConversationIds(appId).some(isAppChatConversationGenerating)
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
function sessionStoragePath(appId: string, conversationId: string, fallback: string): string {
  const store = getActivityStore()
  return store?.getSessionEnvironment(conversationId)?.spacePath
    ?? store?.getSessionEnvironment(legacySessionEnvironmentKey(appId, deriveRunId(conversationId, appId)))?.spacePath
    ?? fallback
}

export function loadAppChatMessages(spacePath: string, appId: string): any[] {
  const path = sessionStoragePath(appId, getAppChatConversationId(appId), spacePath)
  return readSessionMessages(path, appId, CHAT_RUN_ID)
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
  const path = sessionStoragePath(appId, conversationId, spacePath)
  return readSessionMessages(path, appId, runId)
}

/**
 * Load a member's team-channel chat history for ONE run (epoch).
 *
 * The member's space is resolved from the installed app itself — the renderer
 * roster does not always carry a spaceId (the blackboard roster leaves it null),
 * so the app's installed spaceId is the authoritative source. Returns an empty
 * array when the space or its path cannot be resolved.
 *
 * Single source of truth for the team-channel read, shared by the
 * `team:chat-messages` IPC handler and the team read-only HTTP route.
 */
export function readTeamMemberMessages(appId: string, teamId: string, epochId: string): any[] {
  const spaceId = getAppManager()?.getApp(appId)?.spaceId ?? null
  if (!spaceId) return []
  const conversationId = buildTeamSessionKey(appId, teamId, epochId)
  const spacePath = sessionStoragePath(appId, conversationId, getSpace(spaceId)?.path ?? '')
  if (!spacePath) return []
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
  const path = sessionStoragePath(appId, conversationId, spacePath)
  return readSessionMessages(path, appId, deriveRunId(conversationId, appId))
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
  const state = getSessionState(convId)
  return {
    // A queued round has no turn state yet, but the client is already waiting
    // on it and must not be told the session went idle.
    isActive: state.isActive || hasActiveAppChatRound(convId),
    thoughts: state.thoughts,
    spaceId: state.spaceId,
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
 * 5. Drop the sink so the next message starts with a fresh transcript writer
 * 6. Zero the registry's message-activity summary, if any
 *
 * Idempotent: safe to call even if the session doesn't exist.
 */
async function clearSessionByConversationId(
  conversationId: string,
  appId: string,
  spaceId: string
): Promise<void> {
  // 1. Abort active generation (if any) before closing
  if (isAppChatConversationGenerating(conversationId)) {
    console.log(`[AppChat][${appId}] Session is generating, aborting first...`)
    await stopGeneration(conversationId)
  }

  // Drop the IM stream handle so subsequent stop() calls are idempotent;
  // the stream itself is finalized by clearImSession's tear-down below.
  clearImStreamHandle(conversationId)

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
  const spacePath = sessionStoragePath(appId, conversationId, getSpace(spaceId)?.path ?? '')
  if (spacePath) {
    const runId = deriveRunId(conversationId, appId)
    const filePath = join(spacePath, '.halo', 'apps', appId, 'runs', `${runId}.jsonl`)
    try {
      await writeFile(filePath, '', 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[AppChat][${appId}] Failed to clear transcript for ${conversationId}:`, error)
        throw error
      }
    }
    // Remove saved sessionId so next session starts truly fresh
    deleteChatSessionId(spacePath, appId, runId)
  }
  getActivityStore()?.deleteSessionEnvironment(conversationId)
  getActivityStore()?.deleteSessionEnvironment(legacySessionEnvironmentKey(appId, deriveRunId(conversationId, appId)))

  // 5. Drop the sink. Its rounds were already settled when closeV2Session
  //    stopped the consumer; the next message builds a fresh one.
  disposeAppChatSink(conversationId)
  // The terms and the origin the last turn left belong to a thread of work that
  // no longer exists.
  clearDelegation(conversationId)
  forgetTurnOrigin(conversationId)

  // 6. Zero the registry's activity summary so the conversation list preview
  //    matches the now-empty transcript (no-op if the session was never
  //    registered — e.g. a default session that never received a message).
  const target = resolveSessionRegistryTarget(conversationId, appId)
  if (target) {
    getImSessionRegistry()?.resetActivity(appId, target.channel, target.chatId)
    emitSessionUpdated(appId, target, {})
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

/**
 * Rename a session and notify listeners. Lives here rather than in the IPC/HTTP
 * handlers so both transports emit the update event — a rename that only the
 * calling client learns about leaves every other surface showing the old name
 * until its next poll.
 *
 * @returns false when the session isn't registered.
 */
export function renameChatSession(appId: string, channel: string, chatId: string, name: string): boolean {
  const registry = getImSessionRegistry()
  if (!registry) return false
  if (!registry.setCustomName(appId, channel, chatId, name)) return false

  const session = registry.findSession(appId, channel, chatId)
  emitSessionUpdated(appId, { channel, chatId, chatType: session?.chatType ?? 'direct' }, {})
  return true
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

  // Every cached CC subprocess of this app — including idle ones, which are the
  // whole point (they still hold the stale prompt). Generating sessions are a
  // subset: a turn cannot run without its session.
  const sessionIds: string[] = []
  for (const k of v2Sessions.keys()) {
    if (k === prefix || k.startsWith(prefix + ':')) sessionIds.push(k)
  }

  let closed = 0
  let deferred = 0
  for (const convId of sessionIds) {
    try {
      const isActive = isAppChatConversationGenerating(convId)

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
 * Stop an active IM session's generation without clearing history.
 *
 * Aborts the current agent turn for the given IM session and discards any
 * buffered supplement messages, but keeps the V2 session and JSONL transcript
 * intact so the next inbound message resumes the conversation context. This
 * contrasts with {@link clearImSession}, which tears down the V2 session and
 * wipes history.
 *
 * Idempotent: returns `stopped: false` when no generation is active.
 */
export async function stopImSession(
  appId: string,
  channel: string,
  chatType: 'direct' | 'group',
  chatId: string
): Promise<{ stopped: boolean }> {
  const conversationId = buildImSessionKey(appId, channel, chatType, chatId)
  const stopped = await stopConversation(conversationId)

  console.log(
    stopped
      ? `[AppChat][${appId}] IM session stopped: ${conversationId}`
      : `[AppChat][${appId}] IM session stop requested but not active: ${conversationId}`
  )
  return { stopped }
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

/**
 * Tear down a member's team-channel session (process, V2 session, browser ctx)
 * but PRESERVE the JSONL transcript + saved sessionId so the run stays a
 * retrievable history record. Contrast clearAppChat/clearImSession, which wipe.
 */
export async function closeTeamSession(
  appId: string,
  teamId: string,
  epochId: string
): Promise<void> {
  const conversationId = buildTeamSessionKey(appId, teamId, epochId)

  // Abort any in-flight generation before tearing down the underlying session.
  if (isAppChatConversationGenerating(conversationId)) {
    try { await stopGeneration(conversationId) } catch { /* best-effort */ }
  }
  // Close the V2 process; the saved sessionId on disk allows SDK resume later.
  closeV2Session(conversationId)
  // Drop the per-session browser context (rebuilt on demand if the run resumes).
  const ctx = scopedContexts.get(conversationId)
  if (ctx) {
    ctx.destroy()
    scopedContexts.delete(conversationId)
  }
  console.log(`[AppChat][${appId}] Team session closed (history preserved): ${conversationId}`)
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

  const manager = getAppManager()
  const app = manager?.getApp(appId)
  const store = getActivityStore()
  if (!app || !manager || !store) throw new Error('App services not initialized')
  const sessionUuid = randomUUID()
  const conversationId = buildLocalSessionKey(appId, sessionUuid)
  resolveChatEnvironment(app, manager, store, conversationId)
  const record = registry.createLocalSession(appId, sessionUuid)
  emitSessionUpdated(appId, { channel: LOCAL_SESSION_CHANNEL, chatId: sessionUuid, chatType: 'direct' }, {})
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
  _spaceId: string,
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

  const manager = getAppManager()
  const app = manager?.getApp(appId)
  const store = getActivityStore()
  if (!app || !manager || !store) throw new Error('App services not initialized')
  const sourceEnvironment = resolveChatEnvironment(app, manager, store, sourceConversationId, parseTeamSessionKey(sourceConversationId)?.teamId)
  const spacePath = sourceEnvironment.spacePath
  const sessionUuid = randomUUID()
  const conversationId = buildLocalSessionKey(appId, sessionUuid)

  const sourceRunId = deriveRunId(sourceConversationId, appId)
  const newRunId = deriveRunId(conversationId, appId)
  store.pinSessionEnvironment(conversationId, appId, sourceEnvironment)

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

  emitSessionUpdated(appId, { channel: LOCAL_SESSION_CHANNEL, chatId: sessionUuid, chatType: 'direct' }, {})
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
  emitSessionUpdated(appId, { channel: parsed.channel, chatId: parsed.chatId, chatType: parsed.chatType }, {})
  console.log(`[AppChat][${appId}] Native local session deleted: ${conversationId}`)
}
