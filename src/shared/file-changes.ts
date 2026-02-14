/**
 * File Changes - Shared diff statistics and file change extraction
 *
 * Pure utility functions for computing diff statistics from tool_use thoughts.
 * Used by both main process (send-message) and renderer (diff/utils).
 *
 * Zero platform dependencies - only operates on plain data.
 */

// ============================================
// Types
// ============================================

/** Lightweight file changes summary for storage and immediate display */
export interface FileChangesSummary {
  edited: Array<{
    file: string
    added: number
    removed: number
  }>
  created: Array<{
    file: string
    lines: number
  }>
  totalFiles: number
  totalAdded: number
  totalRemoved: number
}

/** Minimal thought interface - avoids coupling to full Thought type */
export interface ThoughtLike {
  id: string
  type: string
  toolName?: string
  toolInput?: Record<string, unknown>
}

// ============================================
// Diff Statistics
// ============================================

/**
 * Count lines in newStr that don't exist in oldStr (trimmed, non-empty).
 */
export function countChangedLines(oldStr: string, newStr: string): number {
  if (!oldStr || !newStr) return 0
  const oldLines = new Set(oldStr.split('\n').map(l => l.trim()).filter(Boolean))
  const newLines = new Set(newStr.split('\n').map(l => l.trim()).filter(Boolean))
  let changes = 0
  for (const line of newLines) {
    if (!oldLines.has(line)) changes++
  }
  return changes
}

/**
 * Calculate line diff statistics.
 */
export function calculateDiffStats(oldStr: string, newStr: string): { added: number; removed: number } {
  const oldLines = oldStr ? oldStr.split('\n') : []
  const newLines = newStr ? newStr.split('\n') : []
  const changed = countChangedLines(oldStr, newStr)
  const added = Math.max(0, newLines.length - oldLines.length + changed)
  const removed = Math.max(0, oldLines.length - newLines.length + changed)
  return {
    added: Math.max(1, Math.ceil(added / 2)),
    removed: Math.max(oldStr ? 1 : 0, Math.ceil(removed / 2))
  }
}

// ============================================
// File Changes Extraction
// ============================================

/**
 * Extract lightweight file changes summary from thoughts.
 * Processes Write and Edit tool calls to produce compact statistics.
 */
export function extractFileChangesSummaryFromThoughts(thoughts: ThoughtLike[]): FileChangesSummary | undefined {
  const edited: FileChangesSummary['edited'] = []
  const created: FileChangesSummary['created'] = []
  let totalAdded = 0
  let totalRemoved = 0
  const processedIds = new Set<string>()

  for (const thought of thoughts) {
    if (thought.type !== 'tool_use') continue
    if (processedIds.has(thought.id)) continue
    processedIds.add(thought.id)

    const input = thought.toolInput as Record<string, unknown> | undefined
    if (!input) continue

    if (thought.toolName === 'Write') {
      const filePath = input.file_path as string
      const content = input.content as string | undefined
      if (!filePath) continue

      const existingIndex = created.findIndex(w => w.file === filePath)
      if (existingIndex >= 0) {
        totalAdded -= created[existingIndex].lines
        created.splice(existingIndex, 1)
      }

      const lineCount = content ? content.split('\n').length : 0
      created.push({ file: filePath, lines: lineCount })
      totalAdded += lineCount
    } else if (thought.toolName === 'Edit') {
      const filePath = input.file_path as string
      const oldString = input.old_string as string | undefined
      const newString = input.new_string as string | undefined
      if (!filePath || (oldString === undefined && newString === undefined)) continue

      const stats = calculateDiffStats(oldString || '', newString || '')

      const existingIndex = edited.findIndex(e => e.file === filePath)
      if (existingIndex >= 0) {
        edited[existingIndex].added += stats.added
        edited[existingIndex].removed += stats.removed
      } else {
        edited.push({ file: filePath, added: stats.added, removed: stats.removed })
      }
      totalAdded += stats.added
      totalRemoved += stats.removed
    }
  }

  const totalFiles = edited.length + created.length
  if (totalFiles === 0) return undefined

  return { edited, created, totalFiles, totalAdded, totalRemoved }
}
