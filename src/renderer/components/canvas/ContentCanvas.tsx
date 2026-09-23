/**
 * Content Canvas - Main content viewing area
 *
 * The Content Canvas transforms Halo from a simple chat interface
 * into a rich content browser. It displays code, markdown, images,
 * and embedded browser views.
 *
 * Layout:
 * - Tab bar at top for switching between open files
 * - Content viewer fills remaining space
 * - Appropriate viewer component selected based on content type
 *
 * Keyboard shortcuts:
 * - Cmd/Ctrl+T: New browser tab
 * - Cmd/Ctrl+W: Close current tab
 * - Cmd/Ctrl+Shift+W: Close all tabs
 * - Cmd/Ctrl+Tab: Switch to next tab
 * - Cmd/Ctrl+Shift+Tab: Switch to previous tab
 * - Cmd/Ctrl+1-9: Switch to tab by index
 * - Escape: Collapse canvas
 *
 * This component uses useCanvasLifecycle for state management.
 * BrowserView lifecycle is managed centrally by CanvasLifecycle.
 */

import { useCallback, useEffect, useState, lazy, Suspense } from 'react'
import { X, ChevronLeft, Maximize2, Minimize2 } from 'lucide-react'
import { useCanvasLifecycle, type TabState, type ContentType } from '../../hooks/useCanvasLifecycle'
import { CanvasTabBar } from './CanvasTabs'
import { CodeViewer } from './viewers/CodeViewer'
import { MarkdownViewer } from './viewers/MarkdownViewer'
import { ImageViewer } from './viewers/ImageViewer'
import { HtmlViewer } from './viewers/HtmlViewer'
import { JsonViewer } from './viewers/JsonViewer'
import { CsvViewer } from './viewers/CsvViewer'
import { TextViewer } from './viewers/TextViewer'
import { BrowserViewer, BrowserViewerFallback } from './viewers/BrowserViewer'
import { TerminalViewer } from './viewers/TerminalViewer'
import { TeamViewer } from './viewers/TeamViewer'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { getBrowserHomepage } from '../../utils/browser-homepage'
import { ErrorBoundary } from '../ErrorBoundary'

// Office viewers ship heavy parsers (SheetJS, docx-preview, pdfjs) — lazy
// chunks keep them out of the startup bundle.
const XlsxViewer = lazy(() => import('./viewers/XlsxViewer'))
const DocxViewer = lazy(() => import('./viewers/DocxViewer'))
const PdfViewer = lazy(() => import('./viewers/PdfViewer'))
const PptxViewer = lazy(() => import('./viewers/PptxViewer'))

interface ContentCanvasProps {
  className?: string
}

export function ContentCanvas({ className = '' }: ContentCanvasProps) {
  const { t } = useTranslation()
  const {
    activeTabId,
    activeTab,
    isOpen,
    closeTab,
    closeAllTabs,
    setOpen,
    saveScrollPosition,
    updateTabContent,
    markTabSaved,
    switchToNextTab,
    switchToPrevTab,
    switchToTabIndex,
    openUrl,
    setEditMode,
  } = useCanvasLifecycle()

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + T: New browser tab (works globally)
      if ((e.metaKey || e.ctrlKey) && e.key === 't') {
        e.preventDefault()
        getBrowserHomepage().then(url => openUrl(url, t('New Tab')))
        return
      }

      // Only handle remaining shortcuts if canvas is open
      if (!isOpen) return

      // Cmd/Ctrl + W: Close current tab
      if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
        e.preventDefault()
        if (activeTabId) {
          closeTab(activeTabId)
        }
      }

      // Cmd/Ctrl + Shift + W: Close all tabs
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'W') {
        e.preventDefault()
        closeAllTabs()
      }

      // Cmd/Ctrl + Tab: Next tab
      if ((e.metaKey || e.ctrlKey) && e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault()
        switchToNextTab()
      }

      // Cmd/Ctrl + Shift + Tab: Previous tab
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Tab') {
        e.preventDefault()
        switchToPrevTab()
      }

      // Cmd/Ctrl + 1-9: Switch to tab by index
      if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        switchToTabIndex(parseInt(e.key))
      }

      // Escape: Collapse canvas (minimize to chat)
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, activeTabId, closeTab, closeAllTabs, setOpen, switchToNextTab, switchToPrevTab, switchToTabIndex, openUrl])

  // Handle scroll position changes
  const handleScrollChange = useCallback((position: number) => {
    if (activeTabId) {
      saveScrollPosition(activeTabId, position)
    }
  }, [activeTabId, saveScrollPosition])

  // Handle content changes (from CodeViewer edit mode)
  const handleContentChange = useCallback((content: string) => {
    if (activeTabId) {
      updateTabContent(activeTabId, content)
    }
  }, [activeTabId, updateTabContent])

  // Handle save complete (from CodeViewer - clears dirty flag)
  const handleSaveComplete = useCallback((content: string) => {
    if (activeTabId) {
      markTabSaved(activeTabId, content)
    }
  }, [activeTabId, markTabSaved])

  // Handle edit mode request (from MarkdownViewer)
  const handleEditRequest = useCallback(() => {
    if (activeTabId) {
      setEditMode(activeTabId, true)
    }
  }, [activeTabId, setEditMode])

  // Don't render if not open
  if (!isOpen) return null

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Tab bar - VS Code style */}
      <CanvasTabBar />

      {/* Content area - bg-background matches the active tab (see canvas-tabs.css
          .canvas-tab.active) for visual continuity, and the prototype's own
          `.canvas{background:var(--bg)}`. */}
      <div className="flex-1 min-h-0 overflow-hidden bg-background">
        {activeTab ? (
          <TabContent
            tab={activeTab}
            onScrollChange={handleScrollChange}
            onContentChange={handleContentChange}
            onSaveComplete={handleSaveComplete}
            onEditRequest={handleEditRequest}
          />
        ) : (
          <EmptyState />
        )}
      </div>
    </div>
  )
}

/**
 * Tab Content - Renders appropriate viewer for content type
 */
interface TabContentProps {
  tab: TabState
  onScrollChange?: (position: number) => void
  onContentChange?: (content: string) => void
  onSaveComplete?: (content: string) => void
  onEditRequest?: () => void
}

function TabContent({ tab, onScrollChange, onContentChange, onSaveComplete, onEditRequest }: TabContentProps) {
  const { t } = useTranslation()
  // Browser tabs (and desktop PDF tabs) use BrowserView (handle their own
  // loading state). In remote mode PDFs open as content tabs rendered by the
  // pdfjs viewer below instead.
  if (tab.type === 'browser') {
    if (api.isRemoteMode()) {
      return <BrowserViewerFallback tab={tab} />
    }
    return <BrowserViewer tab={tab} />
  }
  if (tab.type === 'pdf' && !api.isRemoteMode()) {
    return <BrowserViewer tab={tab} />
  }

  // Handle loading state for non-browser tabs
  if (tab.isLoading) {
    return <LoadingState tabId={tab.id} />
  }

  // Office viewers render their own error fallback (with open-externally and
  // download escape hatches), so they bypass the generic error state below.
  const isOfficeType =
    tab.type === 'xlsx' || tab.type === 'docx' || tab.type === 'pptx' || tab.type === 'pdf'

  // Handle error state
  if (tab.error && !isOfficeType) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3 text-center max-w-md px-4">
          <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
            <X className="w-6 h-6 text-destructive" />
          </div>
          <p className="text-sm font-medium">{t('Failed to load')}</p>
          <p className="text-sm text-muted-foreground">{tab.error}</p>
        </div>
      </div>
    )
  }

  // Render appropriate viewer based on content type
  switch (tab.type) {
    case 'code':
      return (
        <CodeViewer
          tab={tab}
          onScrollChange={onScrollChange}
          onContentChange={onContentChange}
          onSaveComplete={onSaveComplete}
        />
      )

    case 'markdown':
      // Default to MarkdownViewer for preview, switch to CodeViewer when editing
      if (tab.isEditMode) {
        return (
          <CodeViewer
            tab={tab}
            onScrollChange={onScrollChange}
            onContentChange={onContentChange}
            onSaveComplete={onSaveComplete}
          />
        )
      }
      return (
        <MarkdownViewer
          tab={tab}
          onScrollChange={onScrollChange}
          onEditRequest={onEditRequest}
        />
      )

    case 'image':
      return <ImageViewer tab={tab} />

    case 'html':
      return <HtmlViewer tab={tab} />

    case 'json':
      // Use CodeViewer for JSON too - enables editing with syntax highlighting
      return (
        <CodeViewer
          tab={tab}
          onScrollChange={onScrollChange}
          onContentChange={onContentChange}
          onSaveComplete={onSaveComplete}
        />
      )

    case 'csv':
      return <CsvViewer tab={tab} onScrollChange={onScrollChange} />

    // Document viewers are keyed on the tab, and the key goes on the boundary so
    // it covers the whole subtree. This switch reuses one instance per type
    // across tabs, which otherwise leaks two ways: per-document state (page,
    // zoom, active sheet) bleeds into the next document — the trap CsvViewer
    // already documents — and a tripped ErrorBoundary would keep showing its
    // failure placeholder for every later tab of that type. Only these are
    // keyed; browser / terminal / team tabs intentionally survive a switch.
    case 'xlsx':
      return (
        <ViewerSuspense key={tab.id}>
          <XlsxViewer tab={tab} onScrollChange={onScrollChange} />
        </ViewerSuspense>
      )

    case 'docx':
      return (
        <ViewerSuspense key={tab.id}>
          <DocxViewer tab={tab} onScrollChange={onScrollChange} />
        </ViewerSuspense>
      )

    case 'pdf':
      // Remote mode only — desktop PDFs returned a BrowserView above
      return (
        <ViewerSuspense key={tab.id}>
          <PdfViewer tab={tab} />
        </ViewerSuspense>
      )

    case 'pptx':
      return (
        <ViewerSuspense key={tab.id}>
          <PptxViewer tab={tab} />
        </ViewerSuspense>
      )

    case 'text':
      // Use CodeViewer for text files too - enables editing even without syntax highlighting
      return (
        <CodeViewer
          tab={tab}
          onScrollChange={onScrollChange}
          onContentChange={onContentChange}
          onSaveComplete={onSaveComplete}
        />
      )

    case 'terminal':
      return <TerminalViewer tab={tab} />

    case 'team':
      return <TeamViewer tab={tab} />

    default:
      return <TextViewer tab={tab} onScrollChange={onScrollChange} />
  }
}

/**
 * Loading state for file tabs.
 *
 * A large document takes a visible moment to read and parse, so after a short
 * delay the label says so instead of spinning silently. The trigger is elapsed
 * time, not file size: the size is not known until the read returns, and only
 * file-tree clicks carry artifact metadata at all — a size threshold would stay
 * quiet exactly where it is needed most. Time also covers the other reasons a
 * read is slow (remote mode, a network volume), which size never would.
 */
function LoadingState({ tabId }: { tabId: string }) {
  const { t } = useTranslation()
  const [isSlow, setIsSlow] = useState(false)

  useEffect(() => {
    setIsSlow(false)
    const handle = window.setTimeout(() => setIsSlow(true), 600)
    return () => window.clearTimeout(handle)
  }, [tabId])

  return (
    <div className="flex items-center justify-center h-full">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        <p className="text-sm text-muted-foreground">
          {isSlow ? t('Large file, still loading...') : t('Loading...')}
        </p>
      </div>
    </div>
  )
}

/**
 * Boundary for lazy-loaded office viewer chunks.
 *
 * Suspense alone is not enough: it handles the pending import but not a
 * rejected one, so a chunk that fails to load throws past it to the root
 * boundary and blanks the whole window. That is a real scenario after an
 * incremental update leaves stale chunk hashes in a running window — losing one
 * pane is acceptable there, losing the app is not.
 */
function ViewerSuspense({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <ErrorBoundary
      fallback={
        <div className="flex items-center justify-center h-full">
          <p className="text-sm text-muted-foreground px-4 text-center">
            {t('Could not load the viewer. Reopen the file to try again.')}
          </p>
        </div>
      }
    >
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full">
            <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          </div>
        }
      >
        {children}
      </Suspense>
    </ErrorBoundary>
  )
}

/**
 * Empty State - Shown when no tabs are open
 */
function EmptyState() {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center max-w-md px-4">
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-muted/50 flex items-center justify-center">
          <ChevronLeft className="w-8 h-8 text-muted-foreground" />
        </div>
        <p className="text-lg font-medium mb-2">{t('No files open')}</p>
        <p className="text-sm text-muted-foreground">
          {t('Select a file from the left list or wait for AI to generate content')}
        </p>
      </div>
    </div>
  )
}

/**
 * Collapsible Canvas Wrapper - Handles layout transitions
 */
interface CollapsibleCanvasProps {
  children?: React.ReactNode
}

export function CollapsibleCanvas({ children }: CollapsibleCanvasProps) {
  const { isOpen, isTransitioning, tabs } = useCanvasLifecycle()

  // Compute width based on state
  const canvasWidth = isOpen ? 'flex-1' : 'w-0'

  return (
    <div
      className={`
        ${canvasWidth}
        overflow-hidden
        transition-all duration-300 ease-in-out
        ${isTransitioning ? 'pointer-events-none' : ''}
      `}
      style={{
        minWidth: isOpen ? '400px' : '0',
        maxWidth: isOpen ? 'none' : '0',
      }}
    >
      {isOpen && <ContentCanvas />}
    </div>
  )
}

/**
 * Canvas Toggle Button - Used to show/hide canvas
 */
export function CanvasToggleButton() {
  const { t } = useTranslation()
  const { isOpen, tabs, toggleOpen } = useCanvasLifecycle()

  // Don't show if no tabs
  if (tabs.length === 0) return null

  return (
    <button
      onClick={toggleOpen}
      className="p-1.5 rounded hover:bg-secondary transition-colors"
      title={isOpen ? t('Collapse canvas') : t('Expand canvas')}
    >
      {isOpen ? (
        <Minimize2 className="w-4 h-4 text-muted-foreground" />
      ) : (
        <Maximize2 className="w-4 h-4 text-muted-foreground" />
      )}
    </button>
  )
}
