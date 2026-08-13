/**
 * platform/memory -- Public API
 *
 * Persistent memory foundation for the Halo platform layer.
 * Enables AI agents to maintain knowledge across sessions through
 * markdown-based memory files with scope-based isolation.
 *
 * Usage in bootstrap/extended.ts:
 *
 *   import { initMemory } from '../platform/memory'
 *
 *   const memory = await initMemory()
 *   const promptFragment = memory.getPromptInstructions()
 *
 * V1 Implementation:
 * - Pure file operations (no SQLite, no embeddings)
 * - Markdown-based storage with append metadata
 * - Permission matrix enforced at both tool-schema and runtime levels
 * - 100KB compaction threshold (file-size based)
 */

import type {
  MemoryService,
  MemoryCallerScope,
  MemoryReadParams,
  MemoryWriteParams,
  MemoryListParams,
  MemoryScopeType,
  MemoryTurnMode,
  SessionSummaryParams
} from './types'
import { COMPACTION_THRESHOLD_BYTES } from './types'
import {
  getMemoryFilePath,
  getMemoryArchiveDir,
  resolveArchivePath
} from './paths'
import {
  assertReadPermission,
  assertWritePermission,
  assertListPermission
} from './permissions'
import {
  readMemoryFile,
  readMemoryHeadings,
  readMemorySection,
  readMemoryTail,
  appendToMemoryFile,
  replaceMemoryFile,
  listMemoryFiles,
  archiveMemoryFile,
  getFileSize
} from './file-ops'
import { generatePromptInstructions } from './prompt'
import { join } from 'path'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'

// Re-export types for consumers
export type { MemoryService, MemoryCallerScope, MemoryScopeType, MemoryTurnMode }
export { COMPACTION_THRESHOLD_BYTES }

// ============================================================================
// MemoryService Implementation
// ============================================================================

/**
 * Create the MemoryService implementation.
 *
 * V1: All operations are stateless file I/O. No caching, no buffering.
 * Each call resolves paths, checks permissions, and performs I/O directly.
 */
function createMemoryService(): MemoryService {
  const service: MemoryService = {
    // ── read ───────────────────────────────────────────────────────────────
    async read(caller: MemoryCallerScope, params: MemoryReadParams): Promise<string | null> {
      assertReadPermission(caller, params.scope)

      if (params.path) {
        // Read a specific file from the archive directory (mode is ignored for archive reads)
        const archivePath = resolveArchivePath(caller, params.scope, params.path)
        return readMemoryFile(archivePath)
      }

      // Read the main memory file with the specified mode
      const filePath = getMemoryFilePath(caller, params.scope)
      const mode = params.mode ?? 'full'

      switch (mode) {
        case 'headers':
          return readMemoryHeadings(filePath)

        case 'section': {
          if (!params.section) {
            return readMemoryFile(filePath) // Fallback to full if no section specified
          }
          return readMemorySection(filePath, params.section)
        }

        case 'tail':
          return readMemoryTail(filePath, params.limit ?? 50)

        case 'full':
        default:
          return readMemoryFile(filePath)
      }
    },

    // ── write ──────────────────────────────────────────────────────────────
    async write(caller: MemoryCallerScope, params: MemoryWriteParams): Promise<void> {
      assertWritePermission(caller, params.scope, params.mode)

      const filePath = getMemoryFilePath(caller, params.scope)
      const source = caller.type === 'app' ? `app:${caller.appId}` : 'user'

      if (params.mode === 'append') {
        await appendToMemoryFile(filePath, params.content, source)
      } else {
        await replaceMemoryFile(filePath, params.content)
      }

      console.log(
        `[Memory] ${params.mode} to ${params.scope} memory ` +
        `(${params.content.length} bytes, by ${source})`
      )
    },

    // ── list ───────────────────────────────────────────────────────────────
    async list(caller: MemoryCallerScope, params: MemoryListParams): Promise<string[]> {
      assertListPermission(caller, params.scope)

      const archiveDir = getMemoryArchiveDir(caller, params.scope)
      return listMemoryFiles(archiveDir)
    },

    // ── flushBeforeCompaction ──────────────────────────────────────────────
    async flushBeforeCompaction(_caller: MemoryCallerScope): Promise<void> {
      // V1: No in-memory buffer to flush. This is a lifecycle hook placeholder.
      // In V2, this would flush any pending writes from a write-behind cache.
      console.log('[Memory] flushBeforeCompaction: no-op in V1')
    },

    // ── compact ────────────────────────────────────────────────────────────
    async compact(
      caller: MemoryCallerScope,
      scope: MemoryScopeType
    ): Promise<{ archived: string; needsSummary: boolean }> {
      assertWritePermission(caller, scope, 'replace')

      const filePath = getMemoryFilePath(caller, scope)
      const archiveDir = getMemoryArchiveDir(caller, scope)

      // Check if file exists and needs compaction
      const size = await getFileSize(filePath)
      if (size === 0) {
        return { archived: '', needsSummary: false }
      }

      // Archive the current memory file
      const archivedPath = await archiveMemoryFile(filePath, archiveDir)

      console.log(
        `[Memory] Compacted ${scope} memory: ` +
        `${(size / 1024).toFixed(1)}KB archived to ${archivedPath}`
      )

      return {
        archived: archivedPath,
        needsSummary: true
      }
    },

    // ── saveSessionSummary ─────────────────────────────────────────────────
    async saveSessionSummary(
      caller: MemoryCallerScope,
      scope: MemoryScopeType,
      params: SessionSummaryParams
    ): Promise<void> {
      assertWritePermission(caller, scope, 'replace')

      const archiveDir = getMemoryArchiveDir(caller, scope)
      const runDir = join(archiveDir, 'run')

      // Ensure run/ directory exists
      if (!existsSync(runDir)) {
        await mkdir(runDir, { recursive: true })
      }

      // Generate filename
      const now = new Date()
      const timestamp = formatTimestamp(now)
      const slug = params.slug
        ? sanitizeSlug(params.slug)
        : timestamp
      const filename = params.slug
        ? `${timestamp}-${slug}.md`
        : `${timestamp}.md`

      const filePath = join(runDir, filename)

      // Write the summary with a header
      const header = `# Session Summary - ${now.toISOString()}\n\n`
      const content = header + params.content.trimEnd() + '\n'

      const { writeFile } = await import('fs/promises')
      await writeFile(filePath, content, 'utf-8')

      console.log(`[Memory] Session summary saved to ${filePath}`)
    },

    // ── getPromptInstructions ──────────────────────────────────────────────
    getPromptInstructions(mode: MemoryTurnMode): string {
      return generatePromptInstructions(mode)
    },

    // ── needsCompaction ────────────────────────────────────────────────────
    async needsCompaction(
      caller: MemoryCallerScope,
      scope: MemoryScopeType
    ): Promise<boolean> {
      const filePath = getMemoryFilePath(caller, scope)
      const size = await getFileSize(filePath)
      return size > COMPACTION_THRESHOLD_BYTES
    }
  }

  return service
}

// ============================================================================
// Helpers
// ============================================================================

function formatTimestamp(date: Date): string {
  const y = date.getFullYear()
  const m = (date.getMonth() + 1).toString().padStart(2, '0')
  const d = date.getDate().toString().padStart(2, '0')
  const h = date.getHours().toString().padStart(2, '0')
  const min = date.getMinutes().toString().padStart(2, '0')
  return `${y}-${m}-${d}-${h}${min}`
}

/**
 * Sanitize a slug for use in filenames.
 * Keeps lowercase alphanumeric and hyphens, replaces everything else.
 */
function sanitizeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) // Max slug length
}

// ============================================================================
// Module Initialization
// ============================================================================

/**
 * Initialize the memory module.
 *
 * V1: No initialization work needed (no database, no cache).
 * Returns a MemoryService instance ready for use.
 *
 * @returns A configured MemoryService instance
 */
export async function initMemory(): Promise<MemoryService> {
  const start = performance.now()

  const service = createMemoryService()

  const duration = performance.now() - start
  console.log(`[Memory] Memory service initialized in ${duration.toFixed(1)}ms`)

  return service
}
