/**
 * Content Canvas Components
 *
 * Export all canvas-related components for easy import
 */

// Main canvas component
export { ContentCanvas, CollapsibleCanvas } from './ContentCanvas'

// Collapses the canvas, or brings a collapsed one back (shows the tab count)
export { CanvasToggleButton } from './CanvasToggleButton'

// Terminal pty close policy (mounted once at the space level, always active)
export { TerminalCloseGuard } from './TerminalCloseGuard'

// Opens chat tables in the canvas (wraps pages that host one)
export { CanvasTableOpener } from './CanvasTableOpener'

// For the page layout: whether a tab's viewer shows a file list of its own
export { viewerBringsFileList } from './viewer-registry'

// Tab bar
export { CanvasTabs, CanvasTabBar } from './CanvasTabs'

// Viewers
export { CodeViewer } from './viewers/CodeViewer'
export { MarkdownViewer } from './viewers/MarkdownViewer'
export { ImageViewer } from './viewers/ImageViewer'
export { HtmlViewer } from './viewers/HtmlViewer'
