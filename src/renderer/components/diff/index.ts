/**
 * Diff Components - File changes visualization
 *
 * Three-layer progressive disclosure:
 * 1. FileChangesFooter - Stats bar at message bubble bottom
 * 2. FileChangesList - Scrollable file list when expanded
 * 3. DiffModal - Full diff view when file is clicked
 */

export { FileChangesFooter } from './FileChangesFooter'
export { FileChangesList } from './FileChangesList'
export { DiffModal } from './DiffModal'
export { DiffContent } from './DiffContent'

// Types
export type { FileChange, FileChanges, FileChangeType, DiffModalState, EditChunk } from './types'

// Utils
export { extractFileChanges, hasFileChanges, getAllFileChanges, formatStats } from './utils'
