/**
 * Chat store — shared internals for the per-concern slices.
 *
 * Holds the store's type contract (SpaceState / SessionState / ChatState),
 * the empty-state factories, constants, and re-exported dependencies so each
 * slice in this folder has a single import source. The store itself is
 * composed in ../chat.store.ts.
 */
import { create } from 'zustand'
import { api } from '../../api'
import type { Conversation, ConversationMeta, Message, ToolCall, Artifact, Thought, AgentEventBase, ImageAttachment, CompactInfo, CanvasContext, AgentErrorType, PendingQuestion, Question, TaskStatus, PulseItem, PulseReadInfo, TaskProgress } from '../../types'
import type { SessionInitInfo } from '../../types/slash-command'
import { PULSE_READ_GRACE_PERIOD_MS } from '../../types'
import { canvasLifecycle } from '../../services/canvas-lifecycle'
import type { StoreApi } from 'zustand'

// LRU cache size limit
export const CONVERSATION_CACHE_SIZE = 10

// Store-level timer for pulseReadAt cleanup (independent of UI components)

// Per-space state (conversations metadata belong to a space)
export interface SpaceState {
  conversations: ConversationMeta[]  // Lightweight metadata, no messages
  currentConversationId: string | null
  /**
   * The digital-human conversation currently active in this space's input,
   * if any. Independent of `currentConversationId` — selecting a digital
   * human does not change it,
   * so the last regular conversation is preserved and is exactly where
   * `clearAppChatSelection` lands when the user switches back to Halo.
   * Optional (not just null) so every pre-existing SpaceState object
   * literal across this store doesn't need to be touched; absent reads the
   * same as null.
   */
  selectedAppChat?: { appId: string; conversationId: string } | null
}

// Per-session runtime state (isolated per conversation, persists across space switches)
export interface SessionState {
  isGenerating: boolean
  streamingContent: string
  isStreaming: boolean  // True during token-level text streaming
  thoughts: Thought[]
  isThinking: boolean
  pendingToolApproval: ToolCall | null
  error: string | null
  errorType: AgentErrorType | null  // Special error type for custom UI handling
  // Compact notification
  compactInfo: CompactInfo | null
  // Text block version - increments on each new text block (for StreamingBubble reset)
  textBlockVersion: number
  // Pending question from AskUserQuestion tool
  pendingQuestion: PendingQuestion | null
  // Messages queued for mid-turn injection (shown below StreamingBubble during generation)
  queuedMessages: string[]
  // Monotonically increasing turn counter — used to detect stale handleAgentComplete callbacks.
  // Incremented by sendMessage() and handleAgentTurnStart(); checked by handleAgentComplete().
  turnId: number
  // Wall-clock start of the current turn, set by sendMessage()/handleAgentTurnStart().
  // Task panel elapsed-time display reads this instead of approximating from
  // conversation metadata (which only updates once the turn completes).
  turnStartedAt?: number
}

// Create empty session state
export function createEmptySessionState(): SessionState {
  return {
    isGenerating: false,
    streamingContent: '',
    isStreaming: false,
    thoughts: [],
    isThinking: false,
    pendingToolApproval: null,
    error: null,
    errorType: null,
    compactInfo: null,
    textBlockVersion: 0,
    pendingQuestion: null,
    queuedMessages: [],
    turnId: 0,
  }
}


// Create empty space state
export function createEmptySpaceState(): SpaceState {
  return {
    conversations: [],
    currentConversationId: null
  }
}

export interface ChatState {
  // Per-space state: Map<spaceId, SpaceState>
  spaceStates: Map<string, SpaceState>

  // Conversation cache: Map<conversationId, Conversation>
  // Full conversations loaded on-demand, with LRU eviction
  conversationCache: Map<string, Conversation>

  // Per-session runtime state: Map<conversationId, SessionState>
  // This persists across space switches - background tasks keep running
  sessions: Map<string, SessionState>

  // Session init info from SDK system:init — slash_commands, skills, agents per conversation
  sessionInitInfo: Map<string, SessionInitInfo>

  // Pulse: tracks conversations that completed while user was not viewing them
  // Map<conversationId, { spaceId: string; title: string }>
  unseenCompletions: Map<string, { spaceId: string; title: string }>

  // Pulse: tracks read timestamps for grace period display (60s before removal)
  pulseReadAt: Map<string, PulseReadInfo>

  // Current space pointer
  currentSpaceId: string | null

  // Pulse: pending cross-space navigation target (set by navigateToConversation, consumed by SpacePage init)
  pendingPulseNavigation: string | null

  // Digital-human equivalent of pendingPulseNavigation (set by navigateToAppChat,
  // consumed by SpacePage init) — R8's detail-page "Chat" button and the
  // resource rail's hover action both cross spaces via this flag.
  pendingAppChatNavigation: { appId: string; conversationId: string } | null

  // Text to pre-fill into a space's composer on arrival (e.g. a skill's slash
  // command from the store's "Use" action). Consumed once by InputArea.
  //
  // `slashPreview`, when set, is shown in the slash-command menu instead of
  // whatever the *session's* live command list happens to contain. That list
  // (SessionInitInfo.skills) only exists once a conversation session has
  // actually started, and only lists whatever skills the SDK loaded for that
  // particular session — neither of which the composer-fill sources (a skill
  // row click, the store's "Use" button) depend on: they already know the
  // skill is real from their own data (disk-discovery / the app spec), so
  // there's nothing to validate against the session for. Without this, a
  // skill filled into a brand-new empty conversation (no session yet) would
  // never show the confirmation menu at all.
  pendingComposerInput: {
    spaceId: string
    text: string
    slashPreview?: { command: string; label: string; description?: string }
  } | null

  // Artifacts (per space)
  artifacts: Artifact[]

  // Loading
  isLoading: boolean
  isLoadingConversation: boolean  // Loading full conversation

  // In-memory (non-persisted) composer draft per conversationId — switching
  // the input's digital-human selector stashes/restores each link's unsent
  // text. Keyed by conversationId so it works uniformly for space and
  // app-chat conversations; intentionally not persisted (session-scoped only).
  composerDrafts: Map<string, string>
  getComposerDraft: (conversationId: string) => string
  setComposerDraft: (conversationId: string, text: string) => void
  clearComposerDraft: (conversationId: string) => void

  // Digital-human selection for the main conversation board's input.
  // See SpaceState.selectedAppChat for the field this manages.
  selectAppChatConversation: (spaceId: string, appId: string, conversationId: string) => void
  /**
   * Switch back to the normal (Halo) link. Lands on the space's last active
   * regular conversation (`currentConversationId`, untouched by selection —
   * see SpaceState.selectedAppChat); creates a fresh one if there wasn't one.
   */
  clearAppChatSelection: (spaceId: string) => Promise<void>

  // Computed getters
  getCurrentSpaceState: () => SpaceState
  getSpaceState: (spaceId: string) => SpaceState
  getCurrentConversation: () => Conversation | null
  getCurrentConversationMeta: () => ConversationMeta | null
  getCurrentSession: () => SessionState
  getSession: (conversationId: string) => SessionState
  getConversations: () => ConversationMeta[]
  getCurrentConversationId: () => string | null
  getCachedConversation: (conversationId: string) => Conversation | null

  // Space actions
  setCurrentSpace: (spaceId: string) => void

  // Conversation actions
  loadConversations: (spaceId: string) => Promise<void>
  preloadAllSpaceConversations: (spaceIds: string[]) => void
  createConversation: (spaceId: string) => Promise<Conversation | null>
  selectConversation: (conversationId: string) => void
  deleteConversation: (spaceId: string, conversationId: string) => Promise<boolean>
  renameConversation: (spaceId: string, conversationId: string, newTitle: string) => Promise<boolean>
  toggleStarConversation: (spaceId: string, conversationId: string, starred: boolean) => Promise<boolean>
  setConversationModel: (spaceId: string, conversationId: string, modelSourceId: string, modelId: string) => Promise<boolean>
  attachKnowledgeBase: (spaceId: string, conversationId: string, kbId: string) => Promise<void>
  detachKnowledgeBase: (spaceId: string, conversationId: string, kbId: string) => Promise<void>

  // Messaging
  sendMessage: (content: string, images?: ImageAttachment[], thinkingEnabled?: boolean) => Promise<void>
  stopGeneration: (conversationId?: string) => Promise<void>
  injectMessage: (conversationId: string, message: string) => Promise<void>

  // Tool approval
  approveTool: (conversationId: string) => Promise<void>
  rejectTool: (conversationId: string) => Promise<void>

  // Error handling
  continueAfterInterrupt: (conversationId: string) => void

  // Event handlers (called from App component) - with session IDs
  handleAgentMessage: (data: AgentEventBase & { content: string; isComplete: boolean }) => void
  handleAgentToolCall: (data: AgentEventBase & ToolCall) => void
  handleAgentToolResult: (data: AgentEventBase & { toolId: string; result: string; isError: boolean }) => void
  handleAgentError: (data: AgentEventBase & { error: string; errorType?: AgentErrorType }) => void
  handleAgentComplete: (data: AgentEventBase) => void
  handleAgentThought: (data: AgentEventBase & { thought: Thought }) => void
  handleAgentThoughtDelta: (data: AgentEventBase & {
    thoughtId: string
    delta?: string
    content?: string
    toolInput?: Record<string, unknown>
    isComplete?: boolean
    isReady?: boolean
    isToolInput?: boolean
    toolResult?: { output: string; isError: boolean; timestamp: string }
    isToolResult?: boolean
    taskProgress?: TaskProgress
  }) => void
  handleAgentCompact: (data: AgentEventBase & { trigger: 'manual' | 'auto'; preTokens: number }) => void
  handleAgentSessionInfo: (data: AgentEventBase & SessionInitInfo) => void
  handleAgentTurnStart: (data: AgentEventBase & { autonomous?: boolean }) => void

  // AskUserQuestion handlers
  handleAskQuestion: (data: AgentEventBase & { id: string; questions: Question[] }) => void
  answerQuestion: (conversationId: string, answers: Record<string, string>) => Promise<void>

  // Thoughts lazy loading
  loadMessageThoughts: (spaceId: string, conversationId: string, messageId: string) => Promise<Thought[]>

  // Pulse cleanup + grace-period item actions (Keep / Remove — see PulseList)
  cleanupPulseReadAt: () => void
  keepPulseItem: (conversationId: string) => void
  removePulseItem: (conversationId: string) => void

  // Cold-start hydration from the main-process task-state table (survives
  // restart — see platform/task-state). Merge-only: never overwrites an
  // entry the renderer has already written locally since launch.
  loadPersistedTaskState: () => Promise<void>

  // Full resync in response to a `task:state_changed` push (another client
  // kept/removed/read an item, or the server's expiry sweep ran). Unlike
  // loadPersistedTaskState this replaces the maps outright, since the whole
  // point here is to reflect a change this client didn't make itself.
  syncPersistedTaskState: () => Promise<void>

  // Derived pulse state (cached, recalculated only when pulse-relevant fields change)
  _pulseItems: PulseItem[]
  _pulseCount: number

  // Session management
  resetSession: (conversationId: string) => void
  setSessionError: (conversationId: string, error: string) => void
  markSessionStopped: (conversationId: string) => void

  // Cleanup
  reset: () => void
  resetSpace: (spaceId: string) => void
}

// Default empty states
export const EMPTY_SESSION: SessionState = createEmptySessionState()
export const EMPTY_SPACE_STATE: SpaceState = createEmptySpaceState()

// ---- re-exports for slices ----
export { api, canvasLifecycle, PULSE_READ_GRACE_PERIOD_MS }
export type { SessionInitInfo }
export type { Conversation, ConversationMeta, Message, ToolCall, Artifact, Thought, AgentEventBase, ImageAttachment, CompactInfo, CanvasContext, AgentErrorType, PendingQuestion, Question, TaskStatus, PulseItem, PulseReadInfo, TaskProgress }

// ---- slice creator types: each slice receives the store's set/get and
// returns its subset of ChatState; get() sees the full store for cross-slice calls.
export type ChatSet = StoreApi<ChatState>['setState']
export type ChatGet = StoreApi<ChatState>['getState']
export type ChatSlice<K extends keyof ChatState> = (set: ChatSet, get: ChatGet) => Pick<ChatState, K>
