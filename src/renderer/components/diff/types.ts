/**
 * Diff Component Types
 * Data structures for file changes display
 */

// File change type
export type FileChangeType = 'write' | 'edit'

// Single edit chunk (for multiple edits to same file)
export interface EditChunk {
  id: string
  oldString: string
  newString: string
  stats: {
    added: number
    removed: number
  }
}

// Single file change
export interface FileChange {
  id: string
  file: string            // File path (relative or absolute)
  fileName: string        // File name only (for display)
  type: FileChangeType    // 'write' = new file, 'edit' = modification

  // For 'edit' type only
  oldString?: string
  newString?: string

  // Multiple edit chunks (when same file edited multiple times)
  editChunks?: EditChunk[]

  // Line statistics
  stats: {
    added: number         // Lines added
    removed: number       // Lines removed
  }

  // For 'write' type - file content preview
  content?: string
}

// Aggregated file changes for a message
export interface FileChanges {
  edits: FileChange[]     // Modified files
  writes: FileChange[]    // New files
  totalFiles: number      // Total file count
  totalAdded: number      // Total lines added
  totalRemoved: number    // Total lines removed
}

// Diff modal state
export interface DiffModalState {
  isOpen: boolean
  currentFile: FileChange | null
  allFiles: FileChange[]  // For navigation between files
  currentIndex: number    // Current file index
}
