/**
 * Search Service - Implements conversation search across scopes
 *
 * Supports three search scopes:
 * - conversation: Search within a single conversation
 * - space: Search within all conversations in a space
 * - global: Search across all conversations in all spaces
 *
 * Two kinds of conversation are searched, both as clean transcripts (message
 * content only — never a thought process or tool output):
 * - space conversations, read straight from their `{id}.json` files. A file scan
 *   rather than `getConversation`, so a global search does not push the
 *   conversation being used out of that service's small cache;
 * - digital-human sessions (default + local), reached through the registered
 *   conversation sources — the same directory cross-conversation reads use, so
 *   IM, HTTP and team sessions are not searched.
 *
 * Units are searched one at a time, yielding to the event loop between them, so
 * a large search neither blocks the main process nor outlives a cancel.
 */

import { join } from 'path'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { getTempSpacePath, getHaloDir } from '../foundation/config.service'
import { getSpace, listSpaces } from './space.service'
import { CHAT_SOURCE_KIND, getReadableSources, type ConversationSource } from './conversation-interop'
import { nativeChatAppId } from '../../shared/apps/im-keys'
import type { TranscriptRole } from '../../shared/types/transcript'
import type { SearchResult } from '../../shared/types/search'

export type { SearchResult }

/**
 * Conversation file structure for searching
 */
interface ConversationFile {
  id: string
  spaceId: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  /** Backs the knowledge base chat; never a search result (see conversation.service). */
  ephemeral?: boolean
  messages: Array<{
    id: string
    role: TranscriptRole
    content: string
    timestamp: string
  }>
}

/** One searchable transcript: a conversation file, or a session of a registered source. */
type SearchUnit =
  | { kind: 'file'; path: string }
  | { kind: 'source'; source: ConversationSource; spaceId: string; conversationId: string; title: string }

/** A message to test against the query, whichever storage it came from. */
interface Searchable {
  id: string
  role: TranscriptRole
  content: string
  timestamp: string
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

/** The query as a literal, case-insensitive pattern: what is typed is what is found. */
function compileQuery(query: string): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
}

function describeUnit(unit: SearchUnit): string {
  return unit.kind === 'file' ? unit.path : `${unit.source.kind} session ${unit.conversationId}`
}


/**
 * Search service for managing conversation searches
 */
export class SearchService {
  /**
   * Bumped by every new search and every cancel. A search whose generation is
   * no longer current has been superseded: it stops at its next unit and
   * reports neither progress nor results.
   */
  private generation = 0

  /**
   * Execute search across specified scope
   * @param query - Search query string, matched literally and case-insensitively
   * @param scope - Search scope: 'conversation', 'space', or 'global'
   * @param currentConversationId - Current conversation ID (required for 'conversation' scope)
   * @param currentSpaceId - Current space ID (required for 'space' scope)
   * @param onProgress - Callback for progress updates
   * @returns Array of search results sorted by timestamp (newest first)
   */
  async search(
    query: string,
    scope: 'conversation' | 'space' | 'global',
    currentConversationId?: string,
    currentSpaceId?: string,
    onProgress?: (current: number, total: number) => void
  ): Promise<SearchResult[]> {
    if (!query.trim()) {
      return []
    }

    const generation = ++this.generation
    const superseded = () => generation !== this.generation

    try {
      const units = this.getUnitsToSearch(scope, currentConversationId, currentSpaceId)
      if (units.length === 0) {
        return []
      }

      const pattern = compileQuery(query)
      const spaceNames = new Map<string, string>()
      const results: SearchResult[] = []

      for (let i = 0; i < units.length; i++) {
        if (superseded()) return []
        try {
          results.push(...this.searchUnit(units[i], pattern, query.length, spaceNames))
        } catch (err) {
          console.error(`[Search] Failed to search ${describeUnit(units[i])}:`, err)
        }
        if (!superseded()) onProgress?.(i + 1, units.length)
        await yieldToEventLoop()
      }

      if (superseded()) {
        return []
      }

      return results.sort((a, b) =>
        new Date(b.messageTimestamp).getTime() - new Date(a.messageTimestamp).getTime()
      )
    } catch (error) {
      console.error('Search error:', error)
      return []
    }
  }

  /**
   * Cancel ongoing search operation
   */
  cancel(): void {
    this.generation++
  }

  private searchUnit(
    unit: SearchUnit,
    pattern: RegExp,
    queryLength: number,
    spaceNames: Map<string, string>
  ): SearchResult[] {
    if (unit.kind === 'file') {
      const data: ConversationFile = JSON.parse(readFileSync(unit.path, 'utf-8'))
      // `messages` is an array in a conversation and an object in its thoughts file.
      if (!Array.isArray(data.messages) || data.ephemeral) return []
      return this.matchMessages(data.messages, pattern, queryLength, {
        kind: 'chat',
        conversationId: data.id,
        conversationTitle: data.title,
        spaceId: data.spaceId,
        spaceName: this.spaceNameOf(data.spaceId, spaceNames),
      })
    }

    const lines = unit.source.readTranscript(unit.spaceId, unit.conversationId)
    if (!lines) return []
    const appId = nativeChatAppId(unit.conversationId) ?? undefined
    return this.matchMessages(
      lines.flatMap((l) => (l.id ? [{ id: l.id, role: l.role, content: l.content, timestamp: l.timestamp }] : [])),
      pattern,
      queryLength,
      {
        kind: 'digital-human',
        ...(appId ? { appId } : {}),
        conversationId: unit.conversationId,
        conversationTitle: unit.title,
        spaceId: unit.spaceId,
        spaceName: this.spaceNameOf(unit.spaceId, spaceNames),
      }
    )
  }

  private matchMessages(
    messages: readonly Searchable[],
    pattern: RegExp,
    queryLength: number,
    origin: Pick<SearchResult, 'kind' | 'appId' | 'conversationId' | 'conversationTitle' | 'spaceId' | 'spaceName'>
  ): SearchResult[] {
    const results: SearchResult[] = []
    for (const message of messages) {
      const content = message.content || ''
      const matches = content.match(pattern)
      if (!matches) continue

      // Context around the first match
      const firstMatch = content.search(pattern)
      const contextStart = Math.max(0, firstMatch - 50)
      const contextEnd = Math.min(content.length, firstMatch + 100)

      results.push({
        ...origin,
        messageId: message.id,
        messageRole: message.role,
        messageContent: content.substring(0, 150), // Truncate for display
        messageTimestamp: message.timestamp,
        matchCount: matches.length,
        contextBefore: content.substring(contextStart, firstMatch).trim(),
        contextAfter: content.substring(firstMatch + queryLength, contextEnd).trim(),
      })
    }
    return results
  }

  private spaceNameOf(spaceId: string, cache: Map<string, string>): string {
    const cached = cache.get(spaceId)
    if (cached !== undefined) return cached
    let name = spaceId === 'halo-temp' ? 'Halo' : spaceId
    if (spaceId !== 'halo-temp') {
      try {
        name = getSpace(spaceId)?.name ?? name
      } catch {
        // Space may have been deleted, use spaceId as fallback
      }
    }
    cache.set(spaceId, name)
    return name
  }

  /**
   * Transcripts to search for a scope
   */
  private getUnitsToSearch(
    scope: 'conversation' | 'space' | 'global',
    conversationId?: string,
    spaceId?: string
  ): SearchUnit[] {
    if (scope === 'conversation' && conversationId) {
      const session = this.findSession(conversationId, spaceId)
      if (session) return [session]
      const file = this.findConversationFile(conversationId, spaceId)
      return file ? [{ kind: 'file', path: file }] : []
    }

    if (scope === 'space' && spaceId) {
      return [...this.fileUnitsOfSpace(spaceId), ...this.sessionUnitsOfSpace(spaceId)]
    }

    if (scope === 'global') {
      const units: SearchUnit[] = []

      // Space conversations: every space directory on disk, the temp space included
      const tempConvDir = join(getTempSpacePath(), 'conversations')
      units.push(...this.scanConversationFiles(tempConvDir).map((path) => ({ kind: 'file' as const, path })))
      const spacesDir = join(getHaloDir(), 'spaces')
      if (existsSync(spacesDir)) {
        for (const spaceName of readdirSync(spacesDir)) {
          try {
            const convDir = join(spacesDir, spaceName, '.halo', 'conversations')
            units.push(...this.scanConversationFiles(convDir).map((path) => ({ kind: 'file' as const, path })))
          } catch (e) {
            console.error(`Error scanning space ${spaceName}:`, e)
          }
        }
      }

      // Digital-human sessions: per registered space (they are listed by space)
      for (const id of ['halo-temp', ...listSpaces().map((sp) => sp.id)]) {
        units.push(...this.sessionUnitsOfSpace(id))
      }
      return units
    }

    return []
  }

  private fileUnitsOfSpace(spaceId: string): SearchUnit[] {
    let dir: string | null = null
    if (spaceId === 'halo-temp') {
      dir = join(getTempSpacePath(), 'conversations')
    } else {
      try {
        const space = getSpace(spaceId)
        if (space) dir = join(space.path, '.halo', 'conversations')
      } catch (e) {
        console.error(`Failed to get space ${spaceId}:`, e)
      }
    }
    return dir ? this.scanConversationFiles(dir).map((path) => ({ kind: 'file' as const, path })) : []
  }

  /** The sessions of every readable source other than the space's own conversations. */
  private sessionUnitsOfSpace(spaceId: string): SearchUnit[] {
    const units: SearchUnit[] = []
    for (const source of getReadableSources()) {
      if (source.kind === CHAT_SOURCE_KIND) continue
      try {
        for (const meta of source.list(spaceId)) {
          units.push({ kind: 'source', source, spaceId, conversationId: meta.id, title: meta.title })
        }
      } catch (err) {
        console.error(`[Search] Failed to list ${source.kind} sessions in ${spaceId}:`, err)
      }
    }
    return units
  }

  /** The session unit for an id one of the registered sources owns (null for a space conversation). */
  private findSession(conversationId: string, spaceId?: string): SearchUnit | null {
    const source = getReadableSources().find((s) => s.kind !== CHAT_SOURCE_KIND && s.owns(conversationId))
    if (!source) return null
    // The caller's space first; without one (or when the session is not there) any space holding it.
    const candidates = [...(spaceId ? [spaceId] : []), 'halo-temp', ...listSpaces().map((sp) => sp.id)]
    for (const id of new Set(candidates)) {
      const meta = source.getMeta(id, conversationId)
      if (meta) return { kind: 'source', source, spaceId: id, conversationId, title: meta.title }
    }
    return null
  }

  /**
   * Scan directory for conversation JSON files. A conversation's thoughts live
   * beside it as `{id}.thoughts.json`; that file is not a conversation.
   */
  private scanConversationFiles(dirPath: string): string[] {
    const files: string[] = []

    if (!existsSync(dirPath)) {
      return files
    }

    try {
      for (const entry of readdirSync(dirPath)) {
        if (entry.endsWith('.json') && !entry.endsWith('.thoughts.json') && entry !== 'index.json') {
          files.push(join(dirPath, entry))
        }
      }
    } catch (err) {
      console.error(`Failed to scan directory ${dirPath}:`, err)
    }

    return files
  }

  /**
   * Find conversation file in filesystem
   */
  private findConversationFile(conversationId: string, spaceId?: string): string | null {
    const haloDir = getHaloDir()

    // If spaceId is provided, search in that space first
    if (spaceId) {
      if (spaceId === 'halo-temp') {
        const tempPath = getTempSpacePath()
        const filePath = join(tempPath, 'conversations', `${conversationId}.json`)
        if (existsSync(filePath)) {
          return filePath
        }
      } else {
        try {
          const space = getSpace(spaceId)
          if (space) {
            const filePath = join(space.path, '.halo', 'conversations', `${conversationId}.json`)
            if (existsSync(filePath)) {
              return filePath
            }
          }
        } catch (e) {
          console.error(`Failed to find conversation in space ${spaceId}:`, e)
        }
      }
    }

    // Fallback: search in all spaces
    // Search temp space
    const tempPath = getTempSpacePath()
    let filePath = join(tempPath, 'conversations', `${conversationId}.json`)
    if (existsSync(filePath)) {
      return filePath
    }

    // Search custom spaces
    const spacesDir = join(haloDir, 'spaces')
    if (existsSync(spacesDir)) {
      const spaceNames = readdirSync(spacesDir)
      for (const spaceName of spaceNames) {
        try {
          filePath = join(spacesDir, spaceName, '.halo', 'conversations', `${conversationId}.json`)
          if (existsSync(filePath)) {
            return filePath
          }
        } catch (e) {
          // Continue searching
        }
      }
    }

    return null
  }
}

// Export singleton instance
export const searchService = new SearchService()
