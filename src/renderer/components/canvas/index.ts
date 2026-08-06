/**
 * Content Canvas Components
 *
 * Export all canvas-related components for easy import
 */

// Main canvas component
export { ContentCanvas, CollapsibleCanvas, CanvasToggleButton } from './ContentCanvas'

// Terminal pty close policy (mounted once at the space level, always active)
export { TerminalCloseGuard } from './TerminalCloseGuard'

// Tab bar
export { CanvasTabs, CanvasTabBar } from './CanvasTabs'

// Viewers
export { CodeViewer } from './viewers/CodeViewer'
export { MarkdownViewer } from './viewers/MarkdownViewer'
export { ImageViewer } from './viewers/ImageViewer'
export { HtmlViewer } from './viewers/HtmlViewer'
export { JsonViewer } from './viewers/JsonViewer'
export { TextViewer } from './viewers/TextViewer'
