/**
 * platform/memory -- Public API
 *
 * Persistent memory for agents: `memory.md` (`# now` + `# History`), a topic
 * wiki under `memory/topics/`, and the archives beside them. Plain markdown on
 * disk, edited by the agent with its own file tools.
 *
 * This module owns everything about a memory that needs no LLM: where it lives,
 * how it is read and rendered for a turn, the lock its writers share, the guard
 * that holds the agent's file tools to it, and the file side of consolidation.
 * The consolidation agent itself lives in services/memory-consolidation.
 *
 * Does NOT: import services or apps, call a model, or know what a run, chat,
 * space or digital human is beyond the owner kind its prompt is phrased for.
 */

import { join } from 'path'
import { writeFile } from 'fs/promises'
import type {
  MemoryService,
  MemoryCallerScope,
  MemoryScopeType,
  MemoryTurnMode,
  SessionSummaryParams
} from './types'
import { resolveMemoryLayout } from './paths'
import { assertWritePermission } from './permissions'
import { ensureDir, formatTimestamp } from './file-ops'
import { generatePromptInstructions, type MemoryPromptOptions } from './prompt'

export type { MemoryService, MemoryCallerScope, MemoryScopeType, MemoryTurnMode, SessionSummaryParams }

export {
  resolveMemoryLayout,
  getMemoryFilePath,
  type MemoryLayout,
} from './paths'
export { insertHistoryHeading, formatTimestamp, ensureMemoryFile, memoryHasContent } from './file-ops'
export {
  generatePromptInstructions,
  TOPIC_FILE_FORMAT,
  TOPIC_GUIDE,
  type MemoryPromptOptions,
  type MemoryOwnerKind,
  type MemoryTrackedItem,
} from './prompt'
export { buildMemorySnapshot, createMemoryStatusMcpServer, type MemorySnapshot } from './snapshot'
export { scanTopics, type TopicsTree } from './topics'
export { renderMemorySection, formatMemoryUsage, MEMORY_SECTION_LIMITS, type MemorySectionOptions } from './section'
export {
  createMemoryWriteHooks,
  memoryContentPaths,
  type MemoryWriteGuardConfig,
} from './guard'
export {
  CADENCE_THRESHOLDS,
  historyKeepFor,
  assessConsolidation,
  isConsolidationDue,
  readMemoryStatus,
  recordFailedAttempt,
  recordCommit,
  recordArchive,
  isArchiveDue,
  prepareConsolidation,
  validateConsolidation,
  commitConsolidation,
  rebaseWorkspace,
  mergeTargets,
  fingerprintMergeTargets,
  discardConsolidation,
  trimHistoryFallback,
  moveWithinWorkspace,
  type ConsolidationWorkspace,
  type ConsolidationMove,
  type ConsolidationCommitResult,
  type ConcurrentChanges,
  type ConsolidationAssessment,
  type AssessOptions,
  type TopicConflict,
} from './consolidation'

// ============================================================================
// MemoryService Implementation
// ============================================================================

function createMemoryService(): MemoryService {
  return {
    async saveSessionSummary(
      caller: MemoryCallerScope,
      scope: MemoryScopeType,
      params: SessionSummaryParams
    ): Promise<void> {
      assertWritePermission(caller, scope)

      const { runDir } = resolveMemoryLayout(caller, scope)
      await ensureDir(runDir)

      const now = new Date()
      const timestamp = formatTimestamp(now)
      const filename = params.slug
        ? `${timestamp}-${sanitizeSlug(params.slug)}.md`
        : `${timestamp}.md`
      const filePath = join(runDir, filename)

      const content = `# Session Summary - ${now.toISOString()}\n\n` + params.content.trimEnd() + '\n'
      await writeFile(filePath, content, 'utf-8')

      console.log(`[Memory] Session summary saved to ${filePath}`)
    },

    getPromptInstructions(mode: MemoryTurnMode, opts?: MemoryPromptOptions): string {
      return generatePromptInstructions(mode, opts)
    },
  }
}

/** Lowercase alphanumerics and hyphens only, for use in a file name. */
function sanitizeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

// ============================================================================
// Module Initialization
// ============================================================================

export async function initMemory(): Promise<MemoryService> {
  const start = performance.now()
  const service = createMemoryService()
  console.log(`[Memory] Memory service initialized in ${(performance.now() - start).toFixed(1)}ms`)
  return service
}
