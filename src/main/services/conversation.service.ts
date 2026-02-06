/**
 * Conversation Service - Manages chat conversations
 *
 * Performance optimization: Uses index.json for fast listing
 * - listConversations returns lightweight metadata (ConversationMeta)
 * - getConversation loads full conversation on-demand
 * - Index is auto-rebuilt on first access if missing
 */

import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'fs'
import { getTempSpacePath } from './config.service'
import { getSpace } from './space.service'
import { v4 as uuidv4 } from 'uuid'

// Thought types for agent reasoning
interface Thought {
  id: string
  type: 'thinking' | 'text' | 'tool_use' | 'tool_result' | 'system' | 'result' | 'error'
  content: string
  timestamp: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: string
  isError?: boolean
  duration?: number
}

// Image attachment types for multi-modal messages
type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

interface ImageAttachment {
  id: string
  type: 'image'
  mediaType: ImageMediaType
  data: string  // Base64 encoded
  name?: string
  size?: number
}

// Token usage statistics stored with assistant messages (matches renderer TokenUsage shape)
interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCostUsd: number
  contextWindow: number
}

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  toolCalls?: ToolCall[]
  thoughts?: Thought[]  // Agent reasoning process for this message
  images?: ImageAttachment[]  // Attached images for multi-modal messages
  tokenUsage?: TokenUsage  // Optional token usage stats for assistant messages
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

// Lightweight metadata for conversation list (no messages)
export interface ConversationMeta {
  id: string
  spaceId: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  preview?: string  // Last message preview (truncated)
}

// Full conversation with messages
interface Conversation extends ConversationMeta {
  messages: Message[]
  sessionId?: string
}

// Index file structure
interface ConversationIndex {
  version: number
  updatedAt: string
  conversations: ConversationMeta[]
}

const INDEX_VERSION = 1
const PREVIEW_LENGTH = 50

// ============================================================================
// Index Management Functions
// ============================================================================

// Get index file path for a space
function getIndexPath(conversationsDir: string): string {
  return join(conversationsDir, 'index.json')
}

// Read index file, returns null if not exists or invalid
function readIndex(conversationsDir: string): ConversationIndex | null {
  const indexPath = getIndexPath(conversationsDir)

  if (!existsSync(indexPath)) {
    return null
  }

  try {
    const content = readFileSync(indexPath, 'utf-8')
    const index: ConversationIndex = JSON.parse(content)

    // Version check - rebuild if version mismatch
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

// Write index file
function writeIndex(conversationsDir: string, conversations: ConversationMeta[]): void {
  const indexPath = getIndexPath(conversationsDir)

  const index: ConversationIndex = {
    version: INDEX_VERSION,
    updatedAt: new Date().toISOString(),
    conversations
  }

  try {
    writeFileSync(indexPath, JSON.stringify(index, null, 2))
    console.log(`[Conversation] Index written with ${conversations.length} conversations`)
  } catch (error) {
    console.error('[Conversation] Failed to write index:', error)
  }
}

// Extract metadata from a full conversation
function toMeta(conversation: Conversation): ConversationMeta {
  const lastMessage = conversation.messages[conversation.messages.length - 1]
  let preview: string | undefined

  if (lastMessage) {
    preview = lastMessage.content.slice(0, PREVIEW_LENGTH)
    if (lastMessage.content.length > PREVIEW_LENGTH) {
      preview += '...'
    }
  }

  return {
    id: conversation.id,
    spaceId: conversation.spaceId,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
    preview
  }
}

// Full scan: read all conversation files and build metadata list
function fullScanConversations(conversationsDir: string, spaceId: string): ConversationMeta[] {
  console.log(`[Conversation] Full scan started for ${conversationsDir}`)
  const metas: ConversationMeta[] = []

  if (!existsSync(conversationsDir)) {
    return metas
  }

  const files = readdirSync(conversationsDir).filter(f => f.endsWith('.json') && f !== 'index.json')

  for (const file of files) {
    try {
      const content = readFileSync(join(conversationsDir, file), 'utf-8')
      const conversation: Conversation = JSON.parse(content)
      metas.push(toMeta(conversation))
    } catch (error) {
      console.error(`[Conversation] Failed to read conversation ${file}:`, error)
    }
  }

  // Sort by updatedAt (most recent first)
  metas.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

  console.log(`[Conversation] Full scan completed: ${metas.length} conversations`)
  return metas
}

// Rebuild index from scratch (async, non-blocking)
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

// Update a single entry in the index
function updateIndexEntry(
  conversationsDir: string,
  spaceId: string,
  conversationId: string,
  meta: ConversationMeta | null  // null means delete
): void {
  const index = readIndex(conversationsDir)

  if (!index) {
    // No index, trigger full rebuild
    rebuildIndexAsync(conversationsDir, spaceId)
    return
  }

  const existingIndex = index.conversations.findIndex(c => c.id === conversationId)

  if (meta === null) {
    // Delete entry
    if (existingIndex !== -1) {
      index.conversations.splice(existingIndex, 1)
    }
  } else if (existingIndex !== -1) {
    // Update existing entry
    index.conversations[existingIndex] = meta
  } else {
    // Add new entry
    index.conversations.unshift(meta)
  }

  // Re-sort by updatedAt
  index.conversations.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

  writeIndex(conversationsDir, index.conversations)
}

// ============================================================================
// Core Functions
// ============================================================================

// Get conversations directory for a space
function getConversationsDir(spaceId: string): string {
  console.log(`[Conversation] getConversationsDir called with spaceId: ${spaceId}`)

  // Use getSpace to find the space (supports both default and custom paths)
  const space = getSpace(spaceId)

  if (!space) {
    const error = `Space not found: ${spaceId}`
    console.error(`[Conversation] ERROR: ${error}`)
    throw new Error(error)
  }

  const convDir = space.isTemp
    ? join(space.path, 'conversations')
    : join(space.path, '.halo', 'conversations')
  console.log(`[Conversation] Found space "${space.name}", conversations dir: ${convDir}`)
  return convDir
}

// List all conversations for a space (returns lightweight metadata)
export function listConversations(spaceId: string): ConversationMeta[] {
  const conversationsDir = getConversationsDir(spaceId)

  // Strategy 1: Try to read from index
  const index = readIndex(conversationsDir)
  if (index) {
    console.log(`[Conversation] Using index: ${index.conversations.length} conversations`)
    return index.conversations
  }

  // Strategy 2: Fallback to full scan + async index rebuild
  console.log(`[Conversation] No index found, performing full scan`)
  const metas = fullScanConversations(conversationsDir, spaceId)

  // Trigger async index rebuild for next time
  if (metas.length > 0) {
    writeIndex(conversationsDir, metas)
  }

  return metas
}

// Create a new conversation
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
    messages: []
  }

  const conversationsDir = getConversationsDir(spaceId)

  if (!existsSync(conversationsDir)) {
    mkdirSync(conversationsDir, { recursive: true })
  }

  writeFileSync(join(conversationsDir, `${id}.json`), JSON.stringify(conversation, null, 2))

  // Update index
  updateIndexEntry(conversationsDir, spaceId, id, toMeta(conversation))

  return conversation
}

// Get a specific conversation
export function getConversation(spaceId: string, conversationId: string): Conversation | null {
  console.log(`[Conversation] getConversation called - spaceId: ${spaceId}, conversationId: ${conversationId}`)
  
  const conversationsDir = getConversationsDir(spaceId)
  const filePath = join(conversationsDir, `${conversationId}.json`)
  
  console.log(`[Conversation] Looking for file: ${filePath}`)
  console.log(`[Conversation] File exists: ${existsSync(filePath)}`)

  if (existsSync(filePath)) {
    try {
      const conversation = JSON.parse(readFileSync(filePath, 'utf-8'))
      console.log(`[Conversation] Found conversation: ${conversation.title}`)
      return conversation
    } catch (error) {
      console.error('Failed to read conversation:', error)
    }
  }

  console.log(`[Conversation] Conversation not found`)
  return null
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

  writeFileSync(filePath, JSON.stringify(updated, null, 2))

  // Update index (title or other metadata may have changed)
  updateIndexEntry(conversationsDir, spaceId, conversationId, toMeta(updated))

  return updated
}

// Add a message to a conversation
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

  writeFileSync(filePath, JSON.stringify(conversation, null, 2))

  // Update index with new messageCount and preview
  updateIndexEntry(conversationsDir, spaceId, conversationId, toMeta(conversation))

  return newMessage
}

// Update the last message (for streaming and saving thoughts)
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
  if (lastMessage.role === 'assistant') {
    Object.assign(lastMessage, updates)
    conversation.updatedAt = new Date().toISOString()

    writeFileSync(filePath, JSON.stringify(conversation, null, 2))

    // Update index (preview may have changed)
    updateIndexEntry(conversationsDir, spaceId, conversationId, toMeta(conversation))
  }

  return lastMessage
}

// Delete a conversation
export function deleteConversation(spaceId: string, conversationId: string): boolean {
  const conversationsDir = getConversationsDir(spaceId)
  const filePath = join(conversationsDir, `${conversationId}.json`)

  if (existsSync(filePath)) {
    rmSync(filePath)

    // Update index (remove entry)
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
    writeFileSync(filePath, JSON.stringify(conversation, null, 2))
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
