/**
 * Search Service - Implements conversation search across scopes
 *
 * Supports three search scopes:
 * - conversation: Search within a single conversation
 * - space: Search within all conversations in a space
 * - global: Search across all conversations in all spaces
 *
 * Performance: Uses Promise.all for concurrent file reads, with progress callbacks
 */

import { join } from 'path'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { getTempSpacePath, getHaloDir } from './config.service'
import { getSpace } from './space.service'

/**
 * Search result for a single message match
 */
export interface SearchResult {
  conversationId: string
  conversationTitle: string
  messageId: string
  spaceId: string
  spaceName: string
  messageRole: 'user' | 'assistant'
  messageContent: string
  messageTimestamp: string
  matchCount: number
  contextBefore?: string
  contextAfter?: string
}

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
  messages: Array<{
    id: string
    role: 'user' | 'assistant' | 'system'
    content: string
    timestamp: string
  }>
}

/**
 * Search service for managing conversation searches
 */
export class SearchService {
  private cancelToken: boolean = false

  /**
   * Execute search across specified scope
   * @param query - Search query string
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

    this.cancelToken = false

    try {
      // Step 1: Get files to search based on scope
      const files = this.getFilesToSearch(scope, currentConversationId, currentSpaceId)

      if (files.length === 0) {
        return []
      }

      // Step 2: Concurrent file reading with progress tracking
      const promises = files.map((file, index) =>
        this.searchFile(file, query)
          .then(results => {
            if (!this.cancelToken) {
              onProgress?.(index + 1, files.length)
            }
            return results
          })
          .catch(err => {
            console.error(`Error searching ${file}:`, err)
            return []
          })
      )

      // Step 3: Wait for all searches to complete
      const allResults = await Promise.all(promises)

      if (this.cancelToken) {
        return []
      }

      // Step 4: Merge and sort results by timestamp (newest first)
      const mergedResults = allResults.flat()

      return mergedResults.sort((a, b) =>
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
    this.cancelToken = true
  }

  /**
   * Search single conversation file
   */
  private async searchFile(filePath: string, query: string): Promise<SearchResult[]> {
    if (this.cancelToken) {
      return []
    }

    try {
      const content = readFileSync(filePath, 'utf-8')
      const data: ConversationFile = JSON.parse(content)

      const results: SearchResult[] = []
      const searchRegex = new RegExp(query, 'gi')

      // Get space name
      let spaceName = data.spaceId === 'halo-temp' ? 'Halo' : data.spaceId

      try {
        if (data.spaceId !== 'halo-temp') {
          const space = getSpace(data.spaceId)
          if (space) {
            spaceName = space.name
          }
        }
      } catch (e) {
        // Space may have been deleted, use spaceId as fallback
      }

      // Search through messages
      data.messages?.forEach((message) => {
        if (this.cancelToken) {
          return
        }

        const messageContent = message.content || ''
        const matches = messageContent.match(searchRegex)
        const matchCount = matches?.length || 0

        if (matchCount > 0) {
          // Extract context (before and after search term)
          const firstMatch = messageContent.search(searchRegex)
          const contextStart = Math.max(0, firstMatch - 50)
          const contextEnd = Math.min(messageContent.length, firstMatch + 100)

          const contextBefore = messageContent.substring(contextStart, firstMatch)
          const contextAfter = messageContent.substring(
            firstMatch + query.length,
            contextEnd
          )

          results.push({
            conversationId: data.id,
            conversationTitle: data.title,
            messageId: message.id,
            spaceId: data.spaceId,
            spaceName,
            messageRole: message.role as 'user' | 'assistant',
            messageContent: messageContent.substring(0, 150), // Truncate for display
            messageTimestamp: message.timestamp,
            matchCount,
            contextBefore: contextBefore.trim(),
            contextAfter: contextAfter.trim()
          })
        }
      })

      return results
    } catch (err) {
      console.error(`Failed to search file ${filePath}:`, err)
      return []
    }
  }

  /**
   * Get files to search based on scope
   */
  private getFilesToSearch(
    scope: 'conversation' | 'space' | 'global',
    conversationId?: string,
    spaceId?: string
  ): string[] {
    const haloDir = getHaloDir()
    const files: string[] = []

    if (scope === 'conversation' && conversationId) {
      // Search single conversation
      const file = this.findConversationFile(conversationId, spaceId)
      return file ? [file] : []
    }

    if (scope === 'space' && spaceId) {
      // Search all conversations in a space
      if (spaceId === 'halo-temp') {
        const tempPath = getTempSpacePath()
        return this.scanConversationFiles(join(tempPath, 'conversations'))
      } else {
        try {
          const space = getSpace(spaceId)
          if (space) {
            return this.scanConversationFiles(join(space.path, '.halo', 'conversations'))
          }
        } catch (e) {
          console.error(`Failed to get space ${spaceId}:`, e)
        }
      }
      return []
    }

    if (scope === 'global') {
      // Search all conversations across all spaces
      // Scan temp space
      const tempPath = getTempSpacePath()
      const tempConvDir = join(tempPath, 'conversations')
      if (existsSync(tempConvDir)) {
        files.push(...this.scanConversationFiles(tempConvDir))
      }

      // Scan all custom spaces
      const spacesDir = join(haloDir, 'spaces')
      if (existsSync(spacesDir)) {
        const spaceNames = readdirSync(spacesDir)
        spaceNames.forEach(spaceName => {
          try {
            const convDir = join(spacesDir, spaceName, '.halo', 'conversations')
            if (existsSync(convDir)) {
              files.push(...this.scanConversationFiles(convDir))
            }
          } catch (e) {
            console.error(`Error scanning space ${spaceName}:`, e)
          }
        })
      }

      return files
    }

    return files
  }

  /**
   * Scan directory for conversation JSON files
   */
  private scanConversationFiles(dirPath: string): string[] {
    const files: string[] = []

    if (!existsSync(dirPath)) {
      return files
    }

    try {
      const entries = readdirSync(dirPath)
      entries.forEach(entry => {
        if (entry.endsWith('.json') && entry !== 'index.json') {
          files.push(join(dirPath, entry))
        }
      })
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
