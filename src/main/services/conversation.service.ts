/**
 * Conversation Service - Manages chat conversations
 *
 * Performance optimization:
 * - Uses index.json for fast listing (ConversationMeta only)
 * - getConversation loads conversation on-demand, with lazy migration
 * - Thoughts are stored separately in {id}.thoughts.json (v2 format)
 *   to reduce main file size from ~3.5MB to ~90KB
 * - Atomic writes (write .tmp then rename) for crash safety
 * - Active conversation cache: reads are served from memory after first load,
 *   writes update cache + disk (write-through). LRU eviction keeps memory bounded.
 * - Index writes are debounced: multiple mutations within a short window
 *   coalesce into a single disk write.
 */

import { join } from 'path'
import { existsSync, statSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync } from 'fs'
import { isReasoningEffortLevel, type ReasoningEffortLevel } from '../../shared/constants/reasoning-effort'
import { getSpace, touchSpaceActivity } from './space.service'
import { getSeedKBIds } from './tlon'
import { getConfig } from '../foundation/config.service'
import { v4 as uuidv4 } from 'uuid'
import { previewFromMessages, titleFromFirstMessage } from '../../shared/conversation-title'
import { DEFAULT_TOOLSETS } from '../../shared/constants/toolsets'
import { isSpaceConversationId } from '../../shared/apps/im-keys'
import type { Thought, TranscriptMessage } from '../../shared/types/transcript'
import { summarizeThoughts } from '../../shared/transcript'

// Re-export for existing consumers
export type { FileChangesSummary } from '../../shared/file-changes'

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * The message shape is shared with the renderer and every transcript reader
 * (shared/types/transcript.ts); `Message` stays as this module's name for it.
 */
export type Message = TranscriptMessage

export interface ConversationMeta {
  id: string
  spaceId: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  preview?: string
  starred?: boolean
  /**
   * Agent engine that owns this conversation. Mirrored from the full
   * Conversation object by `toMeta()` so the conversation list can render
   * the engine badge without loading the full conversation.
   */
  engineId?: 'anthropic' | 'halo' | 'codex' | 'dsh' | null
  /**
   * Set when the title was chosen rather than derived: the user renamed the
   * conversation, or it was created with a title that must stay (a review).
   * Suppresses the first-message auto-title, so the title survives even if it
   * was set before the first user message. Absent on legacy data = auto-title
   * still applies. Carried in the meta so the renderer can apply the same rule
   * optimistically.
   */
  titleCustomized?: boolean
}

export interface Conversation extends ConversationMeta {
  messages: Message[]
  sessionId?: string
  version?: number  // 2 = thoughts stored separately
  /**
   * Open toolsets (on-demand MCP servers) for this conversation.
   * Written by services/agent/toolsets; restored into the session on resume.
   */
  toolsets?: string[]
  /**
   * Knowledge bases (Tlon) loaded into THIS conversation. Their index.md is
   * injected into the system prompt for every turn (in addition to any KBs
   * bound at the space level). Optional + read with a `?? []` fallback, so
   * legacy conversations work without migration (same pattern as engineId).
   */
  knowledgeBaseIds?: string[]
  /**
   * Agent engine that owns this conversation.
   *
   * Recorded on `createConversation` from the active `config.agent.sdkEngine`.
   * Read with `?? 'anthropic'` fallback so legacy conversations (created
   * before this field existed) keep working without migration. Used purely
   * for UI display (EngineBadge) — engine selection at runtime is still
   * process-bound (see resolved-sdk.ts), changing it requires a restart.
   */
  engineId?: 'anthropic' | 'halo' | 'codex' | 'dsh' | null
  /**
   * Per-conversation model pin (Cursor-style). Pins this conversation to a
   * specific AI source + model independent of the global "current" selection,
   * so switching a model in one conversation never affects the others.
   *
   * Stamped on `createConversation` from the active global selection
   * (`aiSources.currentId` + that source's `model`) so a new conversation
   * inherits the last-used model. Resolved at send time by
   * `getApiCredentialsForConversation` with a fallback to the global selection,
   * so legacy conversations (created before these fields existed) and pins
   * whose source/model became unavailable keep working without migration.
   *
   * `modelSourceId` is the `AISource.id`; `modelId` is the wire model id within
   * that source. Always written together (both set or both absent).
   */
  modelSourceId?: string
  modelId?: string
  /**
   * How hard this conversation's model thinks, picked on the composer's model
   * card. Wins over the level a send carries; absent until the user picks one.
   */
  reasoningEffort?: ReasoningEffortLevel
}

// Thoughts file structure
interface ThoughtsFile {
  version: 1
  conversationId: string
  messages: Record<string, Thought[]>  // messageId -> thoughts[]
}

interface ConversationIndex {
  version: number
  updatedAt: string
  conversations: ConversationMeta[]
}

const INDEX_VERSION = 1
const CONVERSATION_FORMAT_VERSION = 2

// ============================================================================
// Active Conversation Cache (write-through, LRU eviction)
// ============================================================================

const CACHE_MAX_SIZE = 3  // Keep at most 3 conversations in memory (~1-6MB)

/**
 * LRU cache for active conversations.
 * - Key: conversationId
 * - Value: { conversation, filePath, conversationsDir, spaceId }
 *
 * On read: cache hit → 0 IO. Cache miss → disk read + cache store.
 * On write: update cache + write-through to disk.
 * On delete: evict from cache.
 */
const conversationCache = new Map<string, {
  conversation: Conversation
  filePath: string
  conversationsDir: string
  spaceId: string
}>()

function cachePut(
  conversationId: string,
  conversation: Conversation,
  filePath: string,
  conversationsDir: string,
  spaceId: string
): void {
  // Evict oldest if at capacity
  if (conversationCache.size >= CACHE_MAX_SIZE && !conversationCache.has(conversationId)) {
    const oldestKey = conversationCache.keys().next().value
    if (oldestKey) {
      conversationCache.delete(oldestKey)
    }
  }
  conversationCache.set(conversationId, { conversation, filePath, conversationsDir, spaceId })
}

function cacheEvict(conversationId: string): void {
  conversationCache.delete(conversationId)
}

/**
 * Get conversation from cache or disk. Returns null if not found.
 * On cache miss, reads from disk and populates cache.
 */
function cachedRead(spaceId: string, conversationId: string): { conversation: Conversation; filePath: string; conversationsDir: string } | null {
  // Reject path traversal — conversationId is used as a filename segment below.
  if (conversationId.includes('..')) return null

  // Cache hit
  const cached = conversationCache.get(conversationId)
  if (cached) {
    // LRU touch
    conversationCache.delete(conversationId)
    conversationCache.set(conversationId, cached)
    return cached
  }

  // Cache miss — read from disk
  const conversationsDir = getConversationsDir(spaceId)
  const filePath = join(conversationsDir, `${conversationId}.json`)

  if (!existsSync(filePath)) {
    return null
  }

  let conversation: Conversation
  try {
    conversation = JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch (error) {
    console.error(`[Conversation] Failed to read conversation ${conversationId}:`, error)
    return null
  }

  // Lazy migration
  if (conversation.version !== CONVERSATION_FORMAT_VERSION) {
    console.log(`[Conversation] Detected v1 format for ${conversationId}, migrating...`)
    try {
      migrateConversationV1toV2(conversationsDir, conversation)
    } catch (error) {
      console.error(`[Conversation] Migration failed for ${conversationId}, falling back to original:`, error)
      try {
        conversation = JSON.parse(readFileSync(filePath, 'utf-8'))
      } catch (readError) {
        console.error(`[Conversation] Failed to re-read original for ${conversationId}:`, readError)
        return null
      }
    }
  }

  // Populate cache
  cachePut(conversationId, conversation, filePath, conversationsDir, spaceId)
  return { conversation, filePath, conversationsDir }
}

/**
 * Write conversation to cache + disk (write-through).
 */
function cachedWrite(
  conversationId: string,
  conversation: Conversation,
  filePath: string,
  conversationsDir: string,
  spaceId: string
): void {
  cachePut(conversationId, conversation, filePath, conversationsDir, spaceId)
  atomicWriteFileSync(filePath, JSON.stringify(conversation, null, 2))
}

// ============================================================================
// Index Write Debouncing
// ============================================================================

const INDEX_DEBOUNCE_MS = 500

/**
 * Per-directory pending index writes.
 * Key: conversationsDir, Value: { timer, entries (map of convId → meta|null) }
 */
const pendingIndexWrites = new Map<string, {
  timer: ReturnType<typeof setTimeout>
  spaceId: string
  entries: Map<string, ConversationMeta | null>
}>()

/**
 * Schedule a debounced index update. Multiple calls within INDEX_DEBOUNCE_MS
 * are coalesced into a single disk write.
 */
function debouncedUpdateIndexEntry(
  conversationsDir: string,
  spaceId: string,
  conversationId: string,
  meta: ConversationMeta | null
): void {
  let pending = pendingIndexWrites.get(conversationsDir)
  if (pending) {
    // Merge into existing batch
    pending.entries.set(conversationId, meta)
    // Reset timer
    clearTimeout(pending.timer)
  } else {
    pending = {
      timer: null as unknown as ReturnType<typeof setTimeout>,
      spaceId,
      entries: new Map([[conversationId, meta]])
    }
    pendingIndexWrites.set(conversationsDir, pending)
  }

  pending.timer = setTimeout(() => {
    flushIndexWrites(conversationsDir)
  }, INDEX_DEBOUNCE_MS)
}

/**
 * Flush pending index writes for a directory immediately.
 */
function flushIndexWrites(conversationsDir: string): void {
  const pending = pendingIndexWrites.get(conversationsDir)
  if (!pending) return

  clearTimeout(pending.timer)
  pendingIndexWrites.delete(conversationsDir)

  // Read current index once
  const index = readIndex(conversationsDir)
  if (!index) {
    rebuildIndexAsync(conversationsDir, pending.spaceId)
    return
  }

  // Apply all pending entries
  for (const [conversationId, meta] of pending.entries) {
    const existingIndex = index.conversations.findIndex(c => c.id === conversationId)

    if (meta === null) {
      if (existingIndex !== -1) {
        index.conversations.splice(existingIndex, 1)
      }
    } else if (existingIndex !== -1) {
      index.conversations[existingIndex] = meta
    } else {
      index.conversations.unshift(meta)
    }
  }

  index.conversations.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  writeIndex(conversationsDir, index.conversations)
}

/**
 * Flush all pending index writes across all directories. Call on app quit.
 */
export function flushAllPendingIndexWrites(): void {
  for (const conversationsDir of pendingIndexWrites.keys()) {
    flushIndexWrites(conversationsDir)
  }
}

// ============================================================================
// Atomic File Operations
// ============================================================================

/**
 * Write file atomically: write to .tmp first, then rename.
 * rename() on the same filesystem is atomic on POSIX and near-atomic on Windows.
 */
function atomicWriteFileSync(filePath: string, data: string): void {
  const tmpPath = filePath + '.tmp'
  writeFileSync(tmpPath, data)
  renameSync(tmpPath, filePath)
}

// ============================================================================
// Migration: v1 (inline thoughts) -> v2 (separated thoughts)
// ============================================================================

/**
 * Migrate a single conversation from v1 to v2 format.
 * - Extracts thoughts from messages into a separate .thoughts.json file
 * - Replaces inline thoughts with null and adds thoughtsSummary
 * - Sets version to 2
 *
 * Safety:
 * - Idempotent: safe to run multiple times
 * - Writes thoughts file FIRST, then updates main file
 * - If crash between the two writes, next read detects v1 and re-migrates
 */
function migrateConversationV1toV2(conversationsDir: string, conversation: Conversation): void {
  const mainPath = join(conversationsDir, `${conversation.id}.json`)
  const thoughtsPath = join(conversationsDir, `${conversation.id}.thoughts.json`)

  // Step 1: Extract thoughts from all messages
  const thoughtsData: Record<string, Thought[]> = {}
  let hasAnyThoughts = false

  for (const message of conversation.messages) {
    if (Array.isArray(message.thoughts) && message.thoughts.length > 0) {
      thoughtsData[message.id] = message.thoughts
      message.thoughtsSummary = summarizeThoughts(message.thoughts)
      message.thoughts = null
      hasAnyThoughts = true
    }
  }

  // Step 2: Write thoughts file first (if there are thoughts)
  if (hasAnyThoughts) {
    const thoughtsFile: ThoughtsFile = {
      version: 1,
      conversationId: conversation.id,
      messages: thoughtsData
    }
    atomicWriteFileSync(thoughtsPath, JSON.stringify(thoughtsFile))
    console.log(`[Conversation] Migration: wrote thoughts file for ${conversation.id} (${Object.keys(thoughtsData).length} messages)`)
  }

  // Step 3: Update main file with version marker
  conversation.version = CONVERSATION_FORMAT_VERSION
  atomicWriteFileSync(mainPath, JSON.stringify(conversation, null, 2))
  console.log(`[Conversation] Migration: updated main file for ${conversation.id} to v2`)
}

// ============================================================================
// Index Management Functions
// ============================================================================

function getIndexPath(conversationsDir: string): string {
  return join(conversationsDir, 'index.json')
}

function readIndex(conversationsDir: string): ConversationIndex | null {
  const indexPath = getIndexPath(conversationsDir)

  if (!existsSync(indexPath)) {
    return null
  }

  try {
    const content = readFileSync(indexPath, 'utf-8')
    const index: ConversationIndex = JSON.parse(content)

    if (index.version !== INDEX_VERSION) {
      console.log(`[Conversation] Index version mismatch (${index.version} vs ${INDEX_VERSION}), will rebuild`)
      return null
    }

    return index
  } catch (error) {
    console.error('[Conversation] Failed to read index:', error)
    return null
  }
}

function writeIndex(conversationsDir: string, conversations: ConversationMeta[]): void {
  const indexPath = getIndexPath(conversationsDir)

  const index: ConversationIndex = {
    version: INDEX_VERSION,
    updatedAt: new Date().toISOString(),
    conversations
  }

  try {
    atomicWriteFileSync(indexPath, JSON.stringify(index, null, 2))
    console.log(`[Conversation] Index written with ${conversations.length} conversations`)
  } catch (error) {
    console.error('[Conversation] Failed to write index:', error)
  }
}

function toMeta(conversation: Conversation): ConversationMeta {
  const preview = previewFromMessages(conversation.messages)

  const meta: ConversationMeta = {
    id: conversation.id,
    spaceId: conversation.spaceId,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
    preview
  }

  if (conversation.starred) {
    meta.starred = true
  }

  if (conversation.engineId) {
    meta.engineId = conversation.engineId
  }

  if (conversation.titleCustomized) {
    meta.titleCustomized = true
  }

  return meta
}

/**
 * Toggle starred status on a conversation.
 * Updates both the conversation file and the index.
 */
export function toggleStarConversation(
  spaceId: string,
  conversationId: string,
  starred: boolean
): ConversationMeta | null {
  const result = cachedRead(spaceId, conversationId)
  if (!result) return null

  const { conversation, filePath, conversationsDir } = result

  conversation.starred = starred || undefined  // Don't persist false, just remove the key
  conversation.updatedAt = new Date().toISOString()

  cachedWrite(conversationId, conversation, filePath, conversationsDir, spaceId)

  const meta = toMeta(conversation)
  // Star toggle should be reflected immediately in the list.
  // Clear any pending debounced entry for this conversation to prevent stale meta
  // from overwriting the star state when the debounce timer fires.
  const pending = pendingIndexWrites.get(conversationsDir)
  if (pending) pending.entries.delete(conversationId)
  updateIndexEntry(conversationsDir, spaceId, conversationId, meta)

  return meta
}

/**
 * Check if a filename is a conversation main file (not thoughts, not index, not tmp).
 */
function isConversationFile(filename: string): boolean {
  return filename.endsWith('.json')
    && filename !== 'index.json'
    && !filename.endsWith('.thoughts.json')
    && !filename.endsWith('.tmp')
}

function fullScanConversations(conversationsDir: string, spaceId: string): ConversationMeta[] {
  console.log(`[Conversation] Full scan started for ${conversationsDir}`)
  const metas: ConversationMeta[] = []

  if (!existsSync(conversationsDir)) {
    return metas
  }

  const files = readdirSync(conversationsDir).filter(isConversationFile)

  for (const file of files) {
    try {
      const content = readFileSync(join(conversationsDir, file), 'utf-8')
      const conversation: Conversation = JSON.parse(content)
      metas.push(toMeta(conversation))
    } catch (error) {
      console.error(`[Conversation] Failed to read conversation ${file}:`, error)
    }
  }

  metas.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

  console.log(`[Conversation] Full scan completed: ${metas.length} conversations`)
  return metas
}

function rebuildIndexAsync(conversationsDir: string, spaceId: string): void {
  setImmediate(() => {
    try {
      const metas = fullScanConversations(conversationsDir, spaceId)
      writeIndex(conversationsDir, metas)
      console.log(`[Conversation] Index rebuilt asynchronously`)
    } catch (error) {
      console.error('[Conversation] Failed to rebuild index:', error)
    }
  })
}

function updateIndexEntry(
  conversationsDir: string,
  spaceId: string,
  conversationId: string,
  meta: ConversationMeta | null
): void {
  const index = readIndex(conversationsDir)

  if (!index) {
    rebuildIndexAsync(conversationsDir, spaceId)
    return
  }

  const existingIndex = index.conversations.findIndex(c => c.id === conversationId)

  if (meta === null) {
    if (existingIndex !== -1) {
      index.conversations.splice(existingIndex, 1)
    }
  } else if (existingIndex !== -1) {
    index.conversations[existingIndex] = meta
  } else {
    index.conversations.unshift(meta)
  }

  index.conversations.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

  writeIndex(conversationsDir, index.conversations)
}

// ============================================================================
// Core Functions
// ============================================================================

function getConversationsDir(spaceId: string): string {
  const space = getSpace(spaceId)

  if (!space) {
    const error = `Space not found: ${spaceId}`
    console.error(`[Conversation] ERROR: ${error}`)
    throw new Error(error)
  }

  return conversationsDirOf(space)
}

function conversationsDirOf(space: { path: string; isTemp?: boolean }): string {
  return space.isTemp
    ? join(space.path, 'conversations')
    : join(space.path, '.halo', 'conversations')
}

// List all conversations for a space (returns lightweight metadata)
export function listConversations(spaceId: string): ConversationMeta[] {
  const conversationsDir = getConversationsDir(spaceId)

  const index = readIndex(conversationsDir)
  if (index) {
    return index.conversations
  }

  const metas = fullScanConversations(conversationsDir, spaceId)

  if (metas.length > 0) {
    writeIndex(conversationsDir, metas)
  }

  return metas
}

/**
 * Create a new conversation (always v2 format).
 *
 * @param reasoningEffort Level it starts at (the composer passes its last-used
 *        pick). Taken at creation so the warm-up that follows spawns the
 *        session at this level; anything that is not a ladder level is dropped.
 * @param options.keepTitle The given title stays: the first message does not
 *        replace it.
 */
export function createConversation(
  spaceId: string,
  title?: string,
  reasoningEffort?: unknown,
  options?: { keepTitle?: boolean }
): Conversation {
  const id = uuidv4()
  const now = new Date().toISOString()

  // Stamp the conversation with the engine that created it. Cheap to read
  // (single config field) and avoids needing a separate IPC call from
  // the renderer when displaying the engine badge.
  let engineId: 'anthropic' | 'halo' | 'codex' | 'dsh' = 'anthropic'
  // Stamp the active global model selection so a new conversation inherits the
  // last-used source + model (Cursor-style). Left undefined when no source is
  // configured — the credential resolver falls back to the global selection.
  let modelSourceId: string | undefined
  let modelId: string | undefined
  // Stamp the global last-used toolset selection so a new conversation inherits
  // the previous window's enabled toolsets (mirrors the model pin above). Unknown
  // or unavailable ids are ignored at use time (toolsets/registry availability
  // gate), so no filtering here. Until the user toggles anything the shared
  // defaults apply; after that config.lastToolsets is authoritative — including
  // an empty set (all off).
  let toolsets: string[] = [...DEFAULT_TOOLSETS]
  // KB ids to preload: the space's bound KBs plus the global default, snapshotted
  // once at creation so the conversation owns its knowledge set (space rebinds
  // affect only later conversations; the user can add/remove per conversation).
  let knowledgeBaseIds: string[] = []
  try {
    const cfg = getConfig()
    const cfgEngine = cfg?.agent?.sdkEngine
    if (cfgEngine === 'halo' || cfgEngine === 'codex' || cfgEngine === 'dsh') engineId = cfgEngine

    const aiSources = cfg?.aiSources
    if (aiSources?.version === 2 && aiSources.currentId) {
      const currentSource = aiSources.sources.find(s => s.id === aiSources.currentId)
      if (currentSource) {
        modelSourceId = currentSource.id
        modelId = currentSource.model
      }
    }

    if (Array.isArray(cfg?.lastToolsets)) {
      toolsets = cfg.lastToolsets
    }
  } catch {
    // getConfig() may throw if config service hasn't initialized — fall
    // back to the documented defaults.
  }
  try {
    knowledgeBaseIds = getSeedKBIds(spaceId)
  } catch (e) {
    console.error(`[Conversation] Failed to resolve seed knowledge bases for ${spaceId}:`, e)
  }

  const conversation: Conversation = {
    id,
    spaceId,
    title: title || generateTitle(),
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    messages: [],
    version: CONVERSATION_FORMAT_VERSION,
    engineId,
    // Only persist the pin when a source is configured; conditional spread keeps
    // undefined keys out of the JSON so legacy detection stays clean.
    ...(modelSourceId ? { modelSourceId, modelId } : {}),
    // Only persist toolsets when the last-used set is non-empty, so an empty
    // seed leaves the field unset (hydrates to an empty open-set).
    ...(toolsets.length > 0 ? { toolsets: [...toolsets] } : {}),
    // Only persist knowledge bases when the space/default seed is non-empty.
    ...(knowledgeBaseIds.length > 0 ? { knowledgeBaseIds: [...knowledgeBaseIds] } : {}),
    ...(isReasoningEffortLevel(reasoningEffort) ? { reasoningEffort } : {}),
    ...(title && options?.keepTitle ? { titleCustomized: true } : {}),
  }

  const conversationsDir = getConversationsDir(spaceId)

  if (!existsSync(conversationsDir)) {
    mkdirSync(conversationsDir, { recursive: true })
  }

  const filePath = join(conversationsDir, `${id}.json`)
  cachedWrite(id, conversation, filePath, conversationsDir, spaceId)

  updateIndexEntry(conversationsDir, spaceId, id, toMeta(conversation))

  // Update space activity timestamp for home page sorting
  touchSpaceActivity(spaceId)

  return conversation
}

/**
 * Get a specific conversation.
 * - Served from cache if available, otherwise reads from disk and caches.
 * - Detects format version and triggers lazy migration if needed.
 * - v2 format: thoughts are NOT included (they're in the separate file).
 *   Messages with thoughts have thoughts=null and thoughtsSummary set.
 */
export function getConversation(spaceId: string, conversationId: string): Conversation | null {
  const result = cachedRead(spaceId, conversationId)
  return result ? result.conversation : null
}

/**
 * Whether a conversation is known to no longer exist: its space is gone, or
 * the space's conversation folder is there without its file. A folder that
 * cannot be seen (a space on an unmounted drive) proves nothing, so false.
 */
export function isConversationGone(spaceId: string, conversationId: string): boolean {
  if (!isSpaceConversationId(conversationId)) return false
  if (conversationId.includes('..')) return true
  const space = getSpace(spaceId)
  if (!space) return true
  const conversationsDir = conversationsDirOf(space)
  if (!existsSync(conversationsDir)) return false
  try {
    statSync(join(conversationsDir, `${conversationId}.json`))
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return existsSync(conversationsDir)
    console.warn(`[Conversation] Cannot check deletion: space=${spaceId}, conversation=${conversationId}; task state retained`, error)
    return false
  }
}

/**
 * A conversation whose messages start at `fromMessageId` (inclusive), for a
 * reader that already holds the earlier ones — a finished turn then transfers
 * its own messages, not the whole history. `messagesFrom` marks a cut list;
 * when the id is unknown the whole conversation is returned without it.
 */
export function getConversationFrom(
  spaceId: string,
  conversationId: string,
  fromMessageId: string
): (Conversation & { messagesFrom?: string }) | null {
  const conversation = getConversation(spaceId, conversationId)
  if (!conversation) return null
  const index = conversation.messages.findIndex(m => m.id === fromMessageId)
  if (index < 0) return conversation
  return { ...conversation, messages: conversation.messages.slice(index), messagesFrom: fromMessageId }
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

function imageFilesDir(conversationsDir: string, conversationId: string): string {
  return join(conversationsDir, `${conversationId}.images`)
}

/** A `halo-file://` URL for a local path (the protocol decodes it back). */
function toHaloFileUrl(filePath: string): string {
  return `halo-file://${filePath.replace(/%/g, '%25').replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}

/**
 * The conversation as the desktop renderer receives it: each inline base64
 * image is written once beside the conversation (`<id>.images/`) and sent as a
 * `halo-file://` URL with empty `data`, so the renderer holds a URL instead of
 * megabytes of base64. The stored JSON keeps the data — remote clients (no
 * `halo-file:`) and older builds read it. An image that cannot be written is
 * sent inline as before.
 */
export function withImageFiles<T extends Conversation>(spaceId: string, conversation: T): T {
  if (!conversation.messages.some(m => m.images?.some(image => image.data))) return conversation
  const dir = imageFilesDir(getConversationsDir(spaceId), conversation.id)
  let failed = false
  const messages = conversation.messages.map((message, messageIndex) => {
    if (!message.images?.some(image => image.data)) return message
    const images = message.images.map((image, imageIndex) => {
      if (!image.data || failed) return image
      const stem = `${message.id || messageIndex}-${image.id || imageIndex}`.replace(/[^\w-]/g, '_')
      const name = `${stem}.${IMAGE_EXTENSIONS[image.mediaType] ?? 'bin'}`
      const filePath = join(dir, name)
      try {
        if (!existsSync(filePath)) {
          mkdirSync(dir, { recursive: true })
          writeFileSync(filePath, Buffer.from(image.data, 'base64'))
        }
        return { ...image, data: '', url: toHaloFileUrl(filePath) }
      } catch (error) {
        failed = true
        console.error(`[Conversation] Could not write image file for ${conversation.id}; sending images inline:`, error)
        return image
      }
    })
    return { ...message, images }
  })
  return { ...conversation, messages }
}

// Update a conversation
export function updateConversation(
  spaceId: string,
  conversationId: string,
  updates: Partial<Conversation>
): Conversation | null {
  const result = cachedRead(spaceId, conversationId)
  if (!result) return null

  const { conversation, filePath, conversationsDir } = result

  // A thinking level must be a ladder level; anything else is dropped here so
  // it can never be stored.
  if ('reasoningEffort' in updates && updates.reasoningEffort !== undefined && !isReasoningEffortLevel(updates.reasoningEffort)) {
    const { reasoningEffort: _invalid, ...rest } = updates
    updates = rest
  }
  // Adjusting how hard a conversation thinks isn't activity on it, so it
  // doesn't move the conversation up the list.
  const levelOnly = Object.keys(updates).length === 1 && 'reasoningEffort' in updates

  // A title arriving through an update is a user rename — mark it so the
  // first-message auto-title in addMessage never clobbers it afterwards.
  const titleCustomized = 'title' in updates ? true : conversation.titleCustomized

  const updated: Conversation = {
    ...conversation,
    ...updates,
    ...(titleCustomized ? { titleCustomized } : {}),
    updatedAt: levelOnly ? conversation.updatedAt : new Date().toISOString()
  }

  cachedWrite(conversationId, updated, filePath, conversationsDir, spaceId)
  debouncedUpdateIndexEntry(conversationsDir, spaceId, conversationId, toMeta(updated))

  return updated
}

/**
 * Add a message to a conversation.
 * User messages never have thoughts, so only the main file is written.
 */
export function addMessage(spaceId: string, conversationId: string, message: Omit<Message, 'id' | 'timestamp'>): Message {
  const result = cachedRead(spaceId, conversationId)
  if (!result) {
    throw new Error('Conversation not found')
  }

  const { conversation, filePath, conversationsDir } = result

  const newMessage: Message = {
    ...message,
    id: uuidv4(),
    timestamp: new Date().toISOString()
  }

  conversation.messages.push(newMessage)
  conversation.updatedAt = new Date().toISOString()
  conversation.messageCount = conversation.messages.length

  // Auto-update title from first user message, unless the user already named
  // this conversation — their name wins even if it predates the first message.
  if (
    conversation.messages.length === 1 &&
    message.role === 'user' &&
    !conversation.titleCustomized
  ) {
    conversation.title = titleFromFirstMessage(message.content, message.metadata?.references) ?? conversation.title
  }

  // Ensure version is set for new writes
  if (!conversation.version) {
    conversation.version = CONVERSATION_FORMAT_VERSION
  }

  cachedWrite(conversationId, conversation, filePath, conversationsDir, spaceId)
  debouncedUpdateIndexEntry(conversationsDir, spaceId, conversationId, toMeta(conversation))

  // Update space activity timestamp (throttled — safe to call per message)
  touchSpaceActivity(spaceId)

  return newMessage
}

/**
 * Patch one message by id — re-reads the current cached/on-disk state before
 * touching it, and mutates only that one entry rather than replacing the
 * whole `messages` array.
 *
 * This is NOT interchangeable with "read the conversation, splice a new
 * array, write it back": that shape takes a SNAPSHOT of `messages`, and if
 * another writer (e.g. the session consumer appending its own assistant
 * placeholder via `addMessage` while a turn is running) writes in between the
 * snapshot and the write-back, the snapshot's write silently reverts that
 * other writer's entry — a real data loss, not a cosmetic race. Keying on the
 * id and mutating the array `cachedRead` hands back (the same object every
 * writer shares in-cache, per `cachedRead`'s cache-hit path) means this only
 * ever touches its own entry, however many other entries were added around it.
 */
export function updateMessageById(
  spaceId: string,
  conversationId: string,
  messageId: string,
  patch: Partial<Omit<Message, 'id'>>
): Message | null {
  const result = cachedRead(spaceId, conversationId)
  if (!result) return null

  const { conversation, filePath, conversationsDir } = result
  const index = conversation.messages.findIndex((m) => m.id === messageId)
  if (index === -1) return null

  conversation.messages[index] = { ...conversation.messages[index], ...patch }
  conversation.updatedAt = new Date().toISOString()

  cachedWrite(conversationId, conversation, filePath, conversationsDir, spaceId)
  debouncedUpdateIndexEntry(conversationsDir, spaceId, conversationId, toMeta(conversation))

  return conversation.messages[index]
}

/**
 * Update the last message (for streaming completion and saving thoughts).
 *
 * If updates include thoughts:
 * 1. Compute thoughtsSummary and store in main file
 * 2. Write thoughts to separate .thoughts.json file
 * 3. Set thoughts=null in main file
 *
 * This keeps the main file small (~90KB) while thoughts (~3.5MB) are separate.
 */
export function updateLastMessage(
  spaceId: string,
  conversationId: string,
  updates: Partial<Message>
): Message | null {
  const result = cachedRead(spaceId, conversationId)
  if (!result) return null

  const { conversation, filePath, conversationsDir } = result

  if (conversation.messages.length === 0) {
    return null
  }

  // Find the last assistant message (may not be the absolute last message
  // when mid-turn injection added a user message after it)
  let lastMessage: Message | null = null
  for (let i = conversation.messages.length - 1; i >= 0; i--) {
    if (conversation.messages[i].role === 'assistant') {
      lastMessage = conversation.messages[i]
      break
    }
  }

  if (!lastMessage) {
    return null
  }

  // Extract thoughts from updates for separate storage
  const thoughtsToStore = Array.isArray(updates.thoughts) && updates.thoughts.length > 0
    ? updates.thoughts
    : null

  // Apply updates to the message (except thoughts, handled separately)
  const { thoughts: _thoughts, ...otherUpdates } = updates
  Object.assign(lastMessage, otherUpdates)

  // Handle thoughts separation
  if (thoughtsToStore) {
    // Compute summary for the main file
    lastMessage.thoughtsSummary = summarizeThoughts(thoughtsToStore)
    lastMessage.thoughts = null  // Marker: thoughts exist but stored separately

    // Write thoughts file first (crash safety: if this succeeds but main fails,
    // next migration will re-extract from the still-inline thoughts)
    const thoughtsPath = join(conversationsDir, `${conversationId}.thoughts.json`)

    // Read existing thoughts file to merge (may have thoughts from previous messages)
    let thoughtsFile: ThoughtsFile
    try {
      if (existsSync(thoughtsPath)) {
        thoughtsFile = JSON.parse(readFileSync(thoughtsPath, 'utf-8'))
      } else {
        thoughtsFile = { version: 1, conversationId, messages: {} }
      }
    } catch {
      thoughtsFile = { version: 1, conversationId, messages: {} }
    }

    thoughtsFile.messages[lastMessage.id] = thoughtsToStore
    atomicWriteFileSync(thoughtsPath, JSON.stringify(thoughtsFile))
  }

  // Ensure version is set
  if (!conversation.version) {
    conversation.version = CONVERSATION_FORMAT_VERSION
  }

  conversation.updatedAt = new Date().toISOString()

  cachedWrite(conversationId, conversation, filePath, conversationsDir, spaceId)
  debouncedUpdateIndexEntry(conversationsDir, spaceId, conversationId, toMeta(conversation))

  return lastMessage
}

/** What `removeEmptyReplyPlaceholder` did: removed the placeholder, or why it stayed. */
export type ReplyPlaceholderOutcome =
  | 'removed'
  | 'conversation-gone'
  /** Messages came after it — typically ones injected while the turn ran, which are shown on the reply before them. */
  | 'followed-by-messages'
  | 'not-empty'

/**
 * Remove the reply placeholder of a turn that produced nothing: the
 * conversation's last message, only while it is still an empty assistant
 * message.
 */
export function removeEmptyReplyPlaceholder(spaceId: string, conversationId: string): ReplyPlaceholderOutcome {
  const result = cachedRead(spaceId, conversationId)
  if (!result) return 'conversation-gone'

  const { conversation, filePath, conversationsDir } = result
  const last = conversation.messages[conversation.messages.length - 1]
  if (!last) return 'not-empty'
  if (last.role !== 'assistant') return 'followed-by-messages'
  if (last.content || last.error || last.thoughtsSummary || last.thoughts?.length || last.images?.length) return 'not-empty'

  conversation.messages.pop()
  conversation.messageCount = conversation.messages.length

  cachedWrite(conversationId, conversation, filePath, conversationsDir, spaceId)
  debouncedUpdateIndexEntry(conversationsDir, spaceId, conversationId, toMeta(conversation))
  return 'removed'
}

/**
 * Get thoughts for a specific message (lazy loading from .thoughts.json).
 * Returns the thoughts array, or empty array if not found.
 */
export function getMessageThoughts(
  spaceId: string,
  conversationId: string,
  messageId: string
): Thought[] {
  const conversationsDir = getConversationsDir(spaceId)
  const thoughtsPath = join(conversationsDir, `${conversationId}.thoughts.json`)

  if (!existsSync(thoughtsPath)) {
    console.log(`[Conversation] No thoughts file for ${conversationId}, returning empty`)
    return []
  }

  try {
    const thoughtsFile: ThoughtsFile = JSON.parse(readFileSync(thoughtsPath, 'utf-8'))
    const thoughts = thoughtsFile.messages[messageId] || []
    console.log(`[Conversation] Loaded ${thoughts.length} thoughts for ${conversationId}/${messageId}`)
    return thoughts
  } catch (error) {
    console.error(`[Conversation] Failed to read thoughts for ${conversationId}/${messageId}:`, error)
    return []
  }
}

/**
 * Observers of conversation deletion. Registered from bootstrap (dependency
 * inversion — upper tiers own resources keyed by a conversation, e.g. the
 * team collaboration a space conversation coordinates, and must release them
 * when it goes). Notified after the files are gone; failures are logged and
 * never break the deletion.
 */
type ConversationDeletedListener = (spaceId: string, conversationId: string) => void
const conversationDeletedListeners = new Set<ConversationDeletedListener>()

export function onConversationDeleted(listener: ConversationDeletedListener): () => void {
  conversationDeletedListeners.add(listener)
  return () => conversationDeletedListeners.delete(listener)
}

/**
 * Delete a conversation and its associated thoughts file.
 */
export function deleteConversation(spaceId: string, conversationId: string): boolean {
  // Reject path traversal — conversationId is used as a filename segment below.
  if (conversationId.includes('..')) return false

  const conversationsDir = getConversationsDir(spaceId)
  const filePath = join(conversationsDir, `${conversationId}.json`)

  if (existsSync(filePath)) {
    // Evict from cache before deleting
    cacheEvict(conversationId)

    rmSync(filePath)

    // Also delete thoughts file if it exists
    const thoughtsPath = join(conversationsDir, `${conversationId}.thoughts.json`)
    if (existsSync(thoughtsPath)) {
      try {
        rmSync(thoughtsPath)
      } catch (error) {
        console.error(`[Conversation] Failed to delete thoughts file for ${conversationId}:`, error)
      }
    }

    // Clean up any leftover tmp files
    const tmpMain = filePath + '.tmp'
    const tmpThoughts = thoughtsPath + '.tmp'
    if (existsSync(tmpMain)) try { rmSync(tmpMain) } catch { /* ignore */ }
    if (existsSync(tmpThoughts)) try { rmSync(tmpThoughts) } catch { /* ignore */ }

    const imagesDir = imageFilesDir(conversationsDir, conversationId)
    if (existsSync(imagesDir)) {
      try {
        rmSync(imagesDir, { recursive: true, force: true })
      } catch (error) {
        console.error(`[Conversation] Failed to delete image files for ${conversationId}:`, error)
      }
    }

    // Use immediate index update for deletes (user expects instant feedback).
    // Clear any pending debounced entry to prevent the deleted conversation
    // from being written back into the index when the debounce timer fires.
    const pending = pendingIndexWrites.get(conversationsDir)
    if (pending) pending.entries.delete(conversationId)
    updateIndexEntry(conversationsDir, spaceId, conversationId, null)

    for (const listener of conversationDeletedListeners) {
      try {
        listener(spaceId, conversationId)
      } catch (error) {
        console.error(`[Conversation] deletion listener failed for ${conversationId}:`, error)
      }
    }

    return true
  }

  return false
}

// Save session ID for a conversation
export function saveSessionId(spaceId: string, conversationId: string, sessionId: string): void {
  const result = cachedRead(spaceId, conversationId)
  if (!result) return

  const { conversation, filePath, conversationsDir } = result
  conversation.sessionId = sessionId
  cachedWrite(conversationId, conversation, filePath, conversationsDir, spaceId)
}

// Generate a default title
function generateTitle(): string {
  const now = new Date()
  const month = now.getMonth() + 1
  const day = now.getDate()
  const hour = now.getHours()
  const minute = now.getMinutes()

  return `Chat ${month}-${day} ${hour}:${minute.toString().padStart(2, '0')}`
}
