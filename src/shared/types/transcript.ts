/**
 * Transcript — the one message shape every conversation reader produces and
 * every conversation view consumes.
 *
 * Space conversations (JSON + thoughts file) and digital-human sessions (JSONL
 * event log) store messages differently; both readers emit `TranscriptMessage`
 * so the chat page, cross-conversation reads, search and team-lead reads stay
 * storage-agnostic.
 *
 * Pure types (renderer-safe, no Electron/Node).
 */

import type { FileChangesSummary } from '../file-changes'
import type { ContentReference } from './content-reference'
import type { GoalInput } from './goal'
import type { ImageAttachment } from './image-attachment'
import type { MessageTask } from './message-task'
import type { KBSource } from './tlon'

// ============================================
// Thought process
// ============================================

export type ThoughtType = 'thinking' | 'text' | 'tool_use' | 'tool_result' | 'system' | 'result' | 'error'

/** Progress tracking for a Task/Agent tool_use thought. */
export interface TaskProgress {
  taskId: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  lastToolName?: string
  toolCount: number
  durationMs: number
  summary?: string
  totalTokens?: number
}

export interface Thought {
  id: string
  type: ThoughtType
  content: string
  timestamp: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: string
  isError?: boolean
  /** Original SDK error code (rate_limit, authentication_failed, ...) */
  errorCode?: string
  duration?: number
  /** True while content is being streamed (live state only) */
  isStreaming?: boolean
  /** True when tool params are complete (live state only) */
  isReady?: boolean
  /** The tool_use thought carries its own result once it arrives */
  toolResult?: {
    output: string
    isError: boolean
    timestamp: string
  }
  /** Sub-agent support: links this thought to a parent Task tool_use */
  parentToolUseId?: string
  taskProgress?: TaskProgress
}

/** Lightweight digest of a message's thoughts, shown while they are not loaded. */
export interface ThoughtsSummary {
  count: number
  types: Partial<Record<ThoughtType, number>>
  /** Wall-clock seconds between the first and last thought; absent for a single thought. */
  duration?: number
}

// ============================================
// Message
// ============================================

export type TranscriptRole = 'user' | 'assistant' | 'system'

/**
 * How a message entered the conversation. Absent = an ordinary turn.
 * - `injection`: user text folded into an in-flight turn
 * - `cross-conversation`: delivered by another conversation; stored as
 *   `role: 'system'` so it can never read as the owner speaking
 * - `cross-conversation-notice`: system notice written into the sending
 *   conversation (e.g. delivery cooldown)
 * - `team-message`: a team member's message or a collaboration status notice
 *   delivered to the coordinating conversation
 */
export type TranscriptSource =
  | 'injection'
  | 'cross-conversation'
  | 'cross-conversation-notice'
  | 'team-message'

export interface ToolCall {
  id: string
  name: string
  status: 'pending' | 'running' | 'success' | 'error' | 'waiting_approval'
  input: Record<string, unknown>
  output?: string
  error?: string
  progress?: number
  requiresApproval?: boolean
  description?: string
}

/** Token usage statistics from the engine's result message. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCostUsd: number
  contextWindow: number
}

/**
 * Provenance a writer may attach to a stored message. Flat on purpose: it is
 * the shape space conversations already persist, and digital-human transcripts
 * store it verbatim beside `_source`.
 */
export interface TranscriptProvenanceMetadata {
  /**
   * Cross-conversation delivery. The title is a snapshot taken at delivery
   * time — the source may since be renamed or deleted.
   */
  fromConversationId?: string
  fromConversationTitle?: string
  summary?: string
  /** Audit trail only: the `waitForReply` correlation and forward-chain depth. */
  correlationId?: string
  forwardDepth?: number
  /** Team delivery. `fromMemberName` is null for system-authored notices. */
  teamId?: string
  epochId?: string
  teamName?: string
  fromMemberName?: string | null
  teamTriggerKind?: string
}

/** Where a stored message came from, as a writer states it. */
export interface TranscriptProvenance {
  source: TranscriptSource
  metadata?: TranscriptProvenanceMetadata
}

export interface TranscriptMessageMetadata extends TranscriptProvenanceMetadata {
  /** Lightweight file changes for immediate display without loading thoughts */
  fileChanges?: FileChangesSummary
  /** The goal the user set with this message (user messages only). */
  goal?: GoalInput
  /** Places the user pointed at, in the order they added them (user messages only). */
  references?: ContentReference[]
  /** Built-in task this message starts (user messages only). */
  task?: MessageTask
}

export interface TranscriptMessage {
  /**
   * Stable for the life of the message: the same message has the same id on
   * every read, including reads made while its turn is still in flight.
   */
  id: string
  role: TranscriptRole
  content: string
  timestamp: string
  source?: TranscriptSource
  metadata?: TranscriptMessageMetadata
  images?: ImageAttachment[]
  tokenUsage?: TokenUsage
  /** Set when the assistant response failed (e.g. 429 rate limit). */
  error?: string
  /**
   * `null` = the thought process exists but is not loaded (see
   * `thoughtsSummary`); `undefined` = the message has none; array = loaded.
   */
  thoughts?: Thought[] | null
  thoughtsSummary?: ThoughtsSummary
  toolCalls?: ToolCall[]
  /** Knowledge-base documents the agent read this turn (clickable citations) */
  sources?: KBSource[]
}

// ============================================
// Paging
// ============================================

/** One page of a transcript, read from the newest message backwards. */
export interface TranscriptPage {
  /** Oldest → newest within the page */
  messages: TranscriptMessage[]
  /** True when messages older than this page exist */
  hasMoreBefore: boolean
  /** Id of the oldest message in the page (pass as `before` for the next older page); null for an empty page */
  cursor: string | null
  /** Message count of the whole transcript at read time */
  total: number
}

export interface TranscriptPageRequest {
  /** Return messages older than the message with this id; absent = the newest page */
  before?: string
  /** Page size in messages */
  limit?: number
  /**
   * Newest page, extended backwards so it also holds the message with this id
   * (with a little context above it) — for jumping to a message that is not in
   * the newest page. Ignored with `before`, and when the id is unknown. Bounded
   * (`MAX_TRANSCRIPT_THROUGH`): a message further back than that is not reached.
   */
  through?: string
}
