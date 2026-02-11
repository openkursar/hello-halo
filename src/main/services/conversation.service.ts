/**
 * Conversation Service - Manages chat conversations
 *
 * Performance optimization:
 * - Uses index.json for fast listing (ConversationMeta only)
 * - getConversation loads conversation on-demand, with lazy migration
 * - Thoughts are stored separately in {id}.thoughts.json (v2 format)
 *   to reduce main file size from ~3.5MB to ~90KB
 * - Atomic writes (write .tmp then rename) for crash safety
 */

import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync } from 'fs'
import { getSpace } from './space.service'
import { v4 as uuidv4 } from 'uuid'

// ============================================================================
// Type Definitions
// ============================================================================

type ThoughtType = 'thinking' | 'text' | 'tool_use' | 'tool_result' | 'system' | 'result' | 'error'

interface Thought {
  id: string
  type: ThoughtType
  content: string
  timestamp: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: string
  isError?: boolean
  duration?: number
  isStreaming?: boolean
  isReady?: boolean
  toolResult?: {
    output: string
    isError: boolean
    timestamp: string
  }
}

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

interface ImageAttachment {
  id: string
  type: 'image'
  mediaType: ImageMediaType
  data: string
  name?: string
  size?: number
}

interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCostUsd: number
  contextWindow: number
}

interface ThoughtsSummary {
  count: number
  types: Partial<Record<ThoughtType, number>>
}

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  toolCalls?: ToolCall[]
  thoughts?: Thought[] | null  // null = stored separately, undefined = none, Array = loaded/inline
  thoughtsSummary?: ThoughtsSummary
  images?: ImageAttachment[]
  tokenUsage?: TokenUsage
}

interface ToolCall {
  id: string
  name: string
  status: 'pending' | 'running' | 'success' | 'error' | 'waiting_approval'
  input: Record<string, unknown>
  output?: string
  error?: string
  progress?: number
}

export interface ConversationMeta {
  id: string
  spaceId: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  preview?: string
  starred?: boolean
}

interface Conversation extends ConversationMeta {
  messages: Message[]
  sessionId?: string
  version?: number  // 2 = thoughts stored separately
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
const PREVIEW_LENGTH = 50
const CONVERSATION_FORMAT_VERSION = 2

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
// Thoughts Summary Computation
// ============================================================================

function computeThoughtsSummary(thoughts: Thought[]): ThoughtsSummary {
  const types: Partial<Record<ThoughtType, number>> = {}
  for (const t of thoughts) {
    types[t.type] = (types[t.type] || 0) + 1
  }
  let duration: number | undefined
  if (thoughts.length >= 2) {
    const first = new Date(thoughts[0].timestamp).getTime()
    const last = new Date(thoughts[thoughts.length - 1].timestamp).getTime()
    duration = (last - first) / 1000
  }
  return { count: thoughts.length, types, duration }
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
      message.thoughtsSummary = computeThoughtsSummary(message.thoughts)
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
  const lastMessage = conversation.messages[conversation.messages.length - 1]
  let preview: string | undefined

  if (lastMessage) {
    preview = lastMessage.content.slice(0, PREVIEW_LENGTH)
    if (lastMessage.content.length > PREVIEW_LENGTH) {
      preview += '...'
    }
  }

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

  conversation.starred = starred || undefined  // Don't persist false, just remove the key
  conversation.updatedAt = new Date().toISOString()

  atomicWriteFileSync(filePath, JSON.stringify(conversation, null, 2))

  const meta = toMeta(conversation)
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

  const convDir = space.isTemp
    ? join(space.path, 'conversations')
    : join(space.path, '.halo', 'conversations')
  return convDir
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

// Create a new conversation (always v2 format)
export function createConversation(spaceId: string, title?: string): Conversation {
  const id = uuidv4()
  const now = new Date().toISOString()

  const conversation: Conversation = {
    id,
    spaceId,
    title: title || generateTitle(),
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    messages: [],
    version: CONVERSATION_FORMAT_VERSION
  }

  const conversationsDir = getConversationsDir(spaceId)

  if (!existsSync(conversationsDir)) {
    mkdirSync(conversationsDir, { recursive: true })
  }

  atomicWriteFileSync(join(conversationsDir, `${id}.json`), JSON.stringify(conversation, null, 2))

  updateIndexEntry(conversationsDir, spaceId, id, toMeta(conversation))

  return conversation
}

/**
 * Get a specific conversation.
 * - Detects format version and triggers lazy migration if needed.
 * - v2 format: thoughts are NOT included (they're in the separate file).
 *   Messages with thoughts have thoughts=null and thoughtsSummary set.
 */
export function getConversation(spaceId: string, conversationId: string): Conversation | null {
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

  // Format detection and lazy migration
  if (conversation.version !== CONVERSATION_FORMAT_VERSION) {
    console.log(`[Conversation] Detected v1 format for ${conversationId}, migrating...`)
    try {
      migrateConversationV1toV2(conversationsDir, conversation)
    } catch (error) {
      console.error(`[Conversation] Migration failed for ${conversationId}, falling back to original:`, error)
      // Migration mutates the object in-place before writing files.
      // If file write fails, the in-memory object is in a half-mutated state (thoughts=null but no file).
      // Re-read the original v1 data from disk so the user still sees their inline thoughts.
      try {
        conversation = JSON.parse(readFileSync(filePath, 'utf-8'))
      } catch (readError) {
        console.error(`[Conversation] Failed to re-read original for ${conversationId}:`, readError)
        return null
      }
    }
  }

  return conversation
}

// Update a conversation
export function updateConversation(
  spaceId: string,
  conversationId: string,
  updates: Partial<Conversation>
): Conversation | null {
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

  const updated: Conversation = {
    ...conversation,
    ...updates,
    updatedAt: new Date().toISOString()
  }

  atomicWriteFileSync(filePath, JSON.stringify(updated, null, 2))

  updateIndexEntry(conversationsDir, spaceId, conversationId, toMeta(updated))

  return updated
}

/**
 * Add a message to a conversation.
 * User messages never have thoughts, so only the main file is written.
 */
export function addMessage(spaceId: string, conversationId: string, message: Omit<Message, 'id' | 'timestamp'>): Message {
  const conversationsDir = getConversationsDir(spaceId)
  const filePath = join(conversationsDir, `${conversationId}.json`)

  if (!existsSync(filePath)) {
    throw new Error('Conversation not found')
  }

  let conversation: Conversation
  try {
    conversation = JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch (error) {
    throw new Error(`Failed to read conversation: ${error}`)
  }

  const newMessage: Message = {
    ...message,
    id: uuidv4(),
    timestamp: new Date().toISOString()
  }

  conversation.messages.push(newMessage)
  conversation.updatedAt = new Date().toISOString()
  conversation.messageCount = conversation.messages.length

  // Auto-update title from first user message
  if (conversation.messages.length === 1 && message.role === 'user') {
    conversation.title = message.content.slice(0, 50) + (message.content.length > 50 ? '...' : '')
  }

  // Ensure version is set for new writes
  if (!conversation.version) {
    conversation.version = CONVERSATION_FORMAT_VERSION
  }

  atomicWriteFileSync(filePath, JSON.stringify(conversation, null, 2))

  updateIndexEntry(conversationsDir, spaceId, conversationId, toMeta(conversation))

  return newMessage
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

  if (conversation.messages.length === 0) {
    return null
  }

  const lastMessage = conversation.messages[conversation.messages.length - 1]

  // Only update assistant messages
  if (lastMessage.role !== 'assistant') {
    return lastMessage
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
    lastMessage.thoughtsSummary = computeThoughtsSummary(thoughtsToStore)
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

  atomicWriteFileSync(filePath, JSON.stringify(conversation, null, 2))

  updateIndexEntry(conversationsDir, spaceId, conversationId, toMeta(conversation))

  return lastMessage
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
 * Delete a conversation and its associated thoughts file.
 */
export function deleteConversation(spaceId: string, conversationId: string): boolean {
  const conversationsDir = getConversationsDir(spaceId)
  const filePath = join(conversationsDir, `${conversationId}.json`)

  if (existsSync(filePath)) {
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

    updateIndexEntry(conversationsDir, spaceId, conversationId, null)

    return true
  }

  return false
}

// Save session ID for a conversation
export function saveSessionId(spaceId: string, conversationId: string, sessionId: string): void {
  const conversationsDir = getConversationsDir(spaceId)
  const filePath = join(conversationsDir, `${conversationId}.json`)

  if (!existsSync(filePath)) return

  try {
    const conversation: Conversation = JSON.parse(readFileSync(filePath, 'utf-8'))
    conversation.sessionId = sessionId
    atomicWriteFileSync(filePath, JSON.stringify(conversation, null, 2))
  } catch (error) {
    console.error(`[Conversation] Failed to save session ID for ${conversationId}:`, error)
  }
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
