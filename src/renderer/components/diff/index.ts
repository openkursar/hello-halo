/**
 * File changes of an AI reply: the footer under the reply, and reading the
 * changes out of the reply's Write / Edit tool calls. The diffs themselves are
 * shown by the canvas changes view.
 */

export { FileChangesFooter } from './FileChangesFooter'

// Types
export type { FileChange, FileChanges, FileChangeType, EditChunk } from './types'

// Utils
export { extractFileChanges, hasFileChanges, summaryToFileChanges } from './utils'
