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

import { useCallback, useEffect, useState, Suspense } from 'react'
import { X, ChevronLeft, Maximize2, Minimize2 } from 'lucide-react'
import {
  useActiveTab,
  useCanvasActions,
  useCanvasIsOpen,
  useTabCount,
} from '../../hooks/useCanvasLifecycle'
import { canvasLifecycle } from '../../services/canvas-lifecycle'
import { CanvasTabBar } from './CanvasTabs'
import { viewerFor, type ViewerProps } from './viewer-registry'
import { useTranslation } from '../../i18n'
import { getBrowserHomepage } from '../../utils/browser-homepage'
import { trackToolOpen } from '../../services/tool-session-telemetry'
import { ErrorBoundary } from '../ErrorBoundary'

interface ContentCanvasProps {
  className?: string
}

export function ContentCanvas({ className = '' }: ContentCanvasProps) {
  const { t } = useTranslation()
  const activeTab = useActiveTab()
  const activeTabId = activeTab?.id ?? null
  const isOpen = useCanvasIsOpen()
  const {
    closeTab,
    closeAllTabs,
    setOpen,
    saveScrollPosition,
    updateTabContent,
    markTabSaved,
    revertTabContent,
    resolveDiskConflict,
    switchToNextTab,
    switchToPrevTab,
    switchToTabIndex,
    openUrl,
    setEditMode,
  } = useCanvasActions()

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + T: New browser tab (works globally)
      if ((e.metaKey || e.ctrlKey) && e.key === 't') {
        e.preventDefault()
        trackToolOpen('browser', 'shortcut', getBrowserHomepage().then(url => openUrl(url, t('New Tab'))))
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

      // Escape: Collapse canvas (minimize to chat), unless something inside it
      // (a menu, a popover, a viewer's own layer) already used the key.
      if (e.key === 'Escape' && !e.defaultPrevented) {
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

  const handleRevert = useCallback(() => {
    if (activeTabId) revertTabContent(activeTabId)
  }, [activeTabId, revertTabContent])

  const handleResolveDiskConflict = useCallback((keep: 'disk' | 'mine') => {
    if (activeTabId) resolveDiskConflict(activeTabId, keep)
  }, [activeTabId, resolveDiskConflict])

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
          // One viewer instance per tab: switching tabs remounts, so no
          // editor history, edit mode or per-document UI state carries over.
          <TabContent
            key={activeTab.id}
            tab={activeTab}
            onScrollChange={handleScrollChange}
            onContentChange={handleContentChange}
            onSaveComplete={handleSaveComplete}
            onRevert={handleRevert}
            onResolveDiskConflict={handleResolveDiskConflict}
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
type TabContentProps = ViewerProps

function TabContent({ tab, ...handlers }: TabContentProps) {
  const { t } = useTranslation()
  const { Component, ownsLoading, ownsError } = viewerFor(tab.type)

  if (!ownsLoading && tab.isLoading) {
    return <LoadingState tabId={tab.id} />
  }

  if (!ownsLoading && !ownsError && tab.error) {
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

  return (
    <ViewerHost>
      <Component tab={tab} {...handlers} />
    </ViewerHost>
  )
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
 * Boundary around every viewer, remounted per tab with it.
 *
 * A viewer that throws — or a lazy chunk that fails to load, e.g. after an
 * incremental update leaves stale chunk hashes in a running window — loses
 * its own pane instead of throwing past to the root boundary and blanking the
 * whole window. Suspense covers lazy viewers' pending import.
 */
function ViewerHost({ children }: { children: React.ReactNode }) {
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
  const isOpen = useCanvasIsOpen()
  const isTransitioning = canvasLifecycle.getIsTransitioning()

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
  const isOpen = useCanvasIsOpen()
  const tabCount = useTabCount()
  const { toggleOpen } = useCanvasActions()

  // Don't show if no tabs
  if (tabCount === 0) return null

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
