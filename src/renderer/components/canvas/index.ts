/**
 * Content Canvas Components
 *
 * Export all canvas-related components for easy import
 */

// Main canvas component
export { ContentCanvas, CollapsibleCanvas } from './ContentCanvas'

// Collapses the canvas, or brings a collapsed one back (shows the tab count)
export { CanvasToggleButton } from './CanvasToggleButton'

// What closing tabs ends, and the question before ending the AI's work (mounted where the canvas lives)
export { CanvasCloseGuard } from './CanvasCloseGuard'

// Opens chat tables in the canvas (wraps pages that host one)
export { CanvasTableOpener } from './CanvasTableOpener'

// For the page layout: whether a tab's viewer shows a file list of its own
export { viewerBringsFileList } from './viewer-registry'

// Tab bar
export { CanvasTabs, CanvasTabBar } from './CanvasTabs'

// Icon and hue of the tabs that menus open, so a menu entry matches its tab
export { BROWSER_META, TERMINAL_META, CHANGES_META } from './content-type-meta'

// Viewers
export { CodeViewer } from './viewers/CodeViewer'
export { MarkdownViewer } from './viewers/MarkdownViewer'
export { ImageViewer } from './viewers/ImageViewer'
export { HtmlViewer } from './viewers/HtmlViewer'
