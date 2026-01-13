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

import { useCallback, useEffect } from 'react'
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
import { api } from '../../api'
import { useTranslation } from '../../i18n'

// Default URL for new browser tabs
const DEFAULT_NEW_TAB_URL = 'https://www.bing.com'

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
    switchToNextTab,
    switchToPrevTab,
    switchToTabIndex,
    openUrl,
  } = useCanvasLifecycle()

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + T: New browser tab (works globally)
      if ((e.metaKey || e.ctrlKey) && e.key === 't') {
        e.preventDefault()
        openUrl(DEFAULT_NEW_TAB_URL, t('New Tab'))
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

  // Don't render if not open
  if (!isOpen) return null

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Tab bar - VS Code style */}
      <CanvasTabBar />

      {/* Content area - bg-card matches active tab for visual continuity */}
      <div className="flex-1 min-h-0 overflow-hidden bg-card">
        {activeTab ? (
          <TabContent
            tab={activeTab}
            onScrollChange={handleScrollChange}
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
}

function TabContent({ tab, onScrollChange }: TabContentProps) {
  const { t } = useTranslation()
  // Browser and PDF tabs use BrowserView (handle their own loading state)
  if (tab.type === 'browser' || tab.type === 'pdf') {
    if (api.isRemoteMode()) {
      return <BrowserViewerFallback tab={tab} />
    }
    return <BrowserViewer tab={tab} />
  }

  // Handle loading state for non-browser tabs
  if (tab.isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          <p className="text-sm text-muted-foreground">{t('Loading...')}</p>
        </div>
      </div>
    )
  }

  // Handle error state
  if (tab.error) {
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
      return <CodeViewer tab={tab} onScrollChange={onScrollChange} />

    case 'markdown':
      return <MarkdownViewer tab={tab} onScrollChange={onScrollChange} />

    case 'image':
      return <ImageViewer tab={tab} />

    case 'html':
      return <HtmlViewer tab={tab} />

    case 'json':
      return <JsonViewer tab={tab} onScrollChange={onScrollChange} />

    case 'csv':
      return <CsvViewer tab={tab} onScrollChange={onScrollChange} />

    case 'text':
      return <TextViewer tab={tab} onScrollChange={onScrollChange} />

    case 'terminal':
      // Terminal view placeholder (future feature)
      return (
        <div className="flex items-center justify-center h-full">
          <div className="text-center">
            <p className="text-lg font-medium mb-2">{t('Terminal output')}</p>
            <p className="text-sm text-muted-foreground">{t('This feature is coming soon')}</p>
          </div>
        </div>
      )

    default:
      return <TextViewer tab={tab} onScrollChange={onScrollChange} />
  }
}

/**
 * Empty State - Shown when no tabs are open
 */
function EmptyState() {
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
