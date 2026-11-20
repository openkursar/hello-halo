/**
 * Tool Result Viewer Components
 *
 * Smart rendering for tool results with content-aware visualization:
 * - Code: Syntax highlighting + line numbers
 * - Search: File paths + match highlighting
 * - FileList: File/folder icons + stats
 * - Markdown: Rich text rendering
 * - JSON: Formatted + highlighted
 * - PlainText: Simple fallback
 */

export { ToolResultViewer } from './ToolResultViewer'
export { CodeResultViewer } from './CodeResultViewer'
export { SearchResultViewer } from './SearchResultViewer'
export { FileListViewer } from './FileListViewer'
export { MarkdownResultViewer } from './MarkdownResultViewer'
export { JsonResultViewer } from './JsonResultViewer'
export { PlainTextViewer } from './PlainTextViewer'
export { ToolResultImages } from './ToolResultImages'

// Types
export type { ToolResultViewerProps, ViewerBaseProps, ToolResultContentType } from './types'

// Utilities
export { detectContentType, getLanguageForTool, getLanguageFromPath } from './detection'
