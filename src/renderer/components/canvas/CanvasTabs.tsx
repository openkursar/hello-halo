/**
 * Canvas Tabs - VS Code Style Tab Bar for Content Canvas
 *
 * Design Philosophy:
 * - Follows VS Code's proven tab UX patterns
 * - Active tab "punches through" to content area
 * - Clear visual hierarchy with top highlight bar
 * - Subtle separators between inactive tabs
 * - Fixed icon sizes that never shrink
 *
 * Features:
 * - Multiple open files displayed as tabs
 * - Active tab highlighting with top accent bar
 * - Close button on hover/active
 * - Tab overflow with horizontal scroll
 * - Drag and drop reordering
 * - Native Electron context menu
 * - Middle-click to close
 *
 * Keyboard shortcuts:
 * - Cmd/Ctrl+W: Close current tab
 * - Cmd/Ctrl+T: New browser tab
 * - Middle-click: Close tab
 */

import { useState, useRef, useCallback, useEffect, forwardRef } from 'react'
import { X, Loader2, AlertCircle, Plus, XCircle, Maximize2, Minimize2 } from 'lucide-react'
import { type TabState } from '../../services/canvas-lifecycle'
import { useCanvasLifecycle } from '../../hooks/useCanvasLifecycle'
import { useCanvasStore } from '../../stores/canvas.store'
import { useWindowMaximize } from './viewers/useWindowMaximize'
import { FileIcon } from '../icons/ToolIcons'
import { api } from '../../api'
import { useTranslation } from '../../i18n'

// Default URL for new browser tabs
const DEFAULT_NEW_TAB_URL = 'https://www.bing.com'

interface CanvasTabsProps {
  tabs: TabState[]
  activeTabId: string | null
  onTabClick: (tabId: string) => void
  onTabClose: (tabId: string) => void
  onRefresh?: (tabId: string) => void
  onNewTab?: () => void
  onCloseAll?: () => void
  isMaximized?: boolean
  onToggleMaximize?: () => void
}

export function CanvasTabs({
  tabs,
  activeTabId,
  onTabClick,
  onTabClose,
  onRefresh,
  onNewTab,
  onCloseAll,
  isMaximized = false,
  onToggleMaximize
}: CanvasTabsProps) {
  const { t } = useTranslation()
  const { reorderTabs } = useCanvasLifecycle()
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null)
  const [closingTabIds, setClosingTabIds] = useState<Set<string>>(new Set())
  const [newTabIds, setNewTabIds] = useState<Set<string>>(new Set())
  const prevTabIdsRef = useRef<Set<string>>(new Set())
  const tabListRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  // Ref to store latest tabs for stable callbacks (avoids event listener recreation)
  const tabsRef = useRef<TabState[]>(tabs)
  tabsRef.current = tabs

  // Track new tabs for appear animation and auto-scroll
  useEffect(() => {
    const currentTabIds = new Set(tabs.map(t => t.id))
    const prevTabIds = prevTabIdsRef.current

    // Find newly added tabs
    const addedTabs = new Set<string>()
    currentTabIds.forEach(id => {
      if (!prevTabIds.has(id)) {
        addedTabs.add(id)
      }
    })

    if (addedTabs.size > 0) {
      setNewTabIds(addedTabs)
      // Clear the new tab animation after it completes
      setTimeout(() => {
        setNewTabIds(new Set())
      }, 220)
    }

    prevTabIdsRef.current = currentTabIds
  }, [tabs])

  // Auto-scroll to active tab when it changes
  useEffect(() => {
    if (activeTabId && tabListRef.current) {
      const tabElement = tabRefs.current.get(activeTabId)
      if (tabElement) {
        // Use smooth scrolling to bring tab into view
        setTimeout(() => {
          tabElement.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
            inline: 'nearest'
          })
        }, 50) // Small delay to allow animation to start
      }
    }
  }, [activeTabId])

  // Store tab ref
  const setTabRef = useCallback((tabId: string, element: HTMLDivElement | null) => {
    if (element) {
      tabRefs.current.set(tabId, element)
    } else {
      tabRefs.current.delete(tabId)
    }
  }, [])

  // Handle tab close with animation
  const handleTabClose = useCallback((tabId: string) => {
    // Start closing animation
    setClosingTabIds(prev => new Set(prev).add(tabId))

    // After animation completes, actually close the tab
    setTimeout(() => {
      setClosingTabIds(prev => {
        const next = new Set(prev)
        next.delete(tabId)
        return next
      })
      onTabClose(tabId)
    }, 150) // Match animation duration
  }, [onTabClose])

  // Close others handler - with staggered animation
  // Uses tabsRef to avoid recreating this callback when tabs change
  const handleCloseOthers = useCallback((keepTabId: string) => {
    const tabsToClose = tabsRef.current.filter(t => t.id !== keepTabId)

    // Stagger the close animations for a smoother effect
    tabsToClose.forEach((t, i) => {
      setTimeout(() => {
        handleTabClose(t.id)
      }, i * 50)
    })
  }, [handleTabClose])

  // Close to right handler - with staggered animation
  // Uses tabsRef to avoid recreating this callback when tabs change
  const handleCloseToRight = useCallback((fromIndex: number) => {
    const tabsToClose = tabsRef.current.slice(fromIndex + 1)

    // Stagger the close animations for a smoother effect
    tabsToClose.forEach((t, i) => {
      setTimeout(() => {
        handleTabClose(t.id)
      }, i * 50)
    })
  }, [handleTabClose])

  // Copy path handler
  const handleCopyPath = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(path)
    } catch (err) {
      console.error('Failed to copy path:', err)
    }
  }, [])

  // Listen for native menu actions from main process
  useEffect(() => {
    const unsubscribe = api.onCanvasTabAction((data) => {
      console.log('[CanvasTabs] Received tab action:', data)
      switch (data.action) {
        case 'close':
          if (data.tabId) handleTabClose(data.tabId)
          break
        case 'closeOthers':
          if (data.tabId) handleCloseOthers(data.tabId)
          break
        case 'closeToRight':
          if (data.tabId && data.tabIndex !== undefined) handleCloseToRight(data.tabIndex)
          break
        case 'copyPath':
          if (data.tabPath) handleCopyPath(data.tabPath)
          break
        case 'refresh':
          if (data.tabId && onRefresh) onRefresh(data.tabId)
          break
      }
    })

    return unsubscribe
  }, [handleTabClose, handleCloseOthers, handleCloseToRight, handleCopyPath, onRefresh])

  // Handle drag start
  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDraggedIndex(index)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))

    // Create a custom drag image
    const dragElement = e.currentTarget as HTMLElement
    if (dragElement) {
      e.dataTransfer.setDragImage(dragElement, dragElement.offsetWidth / 2, dragElement.offsetHeight / 2)
    }
  }, [])

  // Handle drag over another tab
  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'

    if (draggedIndex !== null && draggedIndex !== index) {
      setDropTargetIndex(index)
    }
  }, [draggedIndex])

  // Handle drag leave
  const handleDragLeave = useCallback(() => {
    setDropTargetIndex(null)
  }, [])

  // Handle drop
  const handleDrop = useCallback((e: React.DragEvent, toIndex: number) => {
    e.preventDefault()

    if (draggedIndex !== null && draggedIndex !== toIndex) {
      reorderTabs(draggedIndex, toIndex)
    }

    setDraggedIndex(null)
    setDropTargetIndex(null)
  }, [draggedIndex, reorderTabs])

  // Handle drag end (cleanup)
  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null)
    setDropTargetIndex(null)
  }, [])

  // Handle right-click - show native Electron menu
  const handleContextMenu = useCallback((e: React.MouseEvent, tab: TabState, index: number) => {
    e.preventDefault()

    // Show native Electron context menu
    api.showCanvasTabContextMenu({
      tabId: tab.id,
      tabIndex: index,
      tabTitle: tab.title,
      tabPath: tab.path,
      tabCount: tabs.length,
      hasTabsToRight: index < tabs.length - 1
    })
  }, [tabs.length])

  if (tabs.length === 0 && !onNewTab) return null

  return (
    <div className="canvas-tab-bar">
      {/* Tab list - scrollable, includes new tab button */}
      <div ref={tabListRef} className="canvas-tab-list">
        {tabs.map((tab, index) => (
          <TabItem
            key={tab.id}
            ref={(el) => setTabRef(tab.id, el)}
            tab={tab}
            index={index}
            isActive={tab.id === activeTabId}
            isDragging={draggedIndex === index}
            isDropTarget={dropTargetIndex === index}
            isClosing={closingTabIds.has(tab.id)}
            isNew={newTabIds.has(tab.id)}
            onClick={() => onTabClick(tab.id)}
            onClose={() => handleTabClose(tab.id)}
            onContextMenu={(e) => handleContextMenu(e, tab, index)}
            onDragStart={(e) => handleDragStart(e, index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, index)}
            onDragEnd={handleDragEnd}
          />
        ))}
        {/* New tab button - inside tab list, follows tabs */}
        {onNewTab && (
          <button
            onClick={onNewTab}
            className="canvas-tab-new"
            title={t('New Tab (⌘T)')}
          >
            <Plus className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Right-side action buttons */}
      <div className="canvas-tab-bar-actions">
        {/* Close all tabs button */}
        {onCloseAll && tabs.length > 0 && (
          <button
            onClick={onCloseAll}
            className="canvas-tab-bar-action danger"
            title={t('Close all tabs')}
          >
            <XCircle className="w-4 h-4" />
          </button>
        )}

        {/* Maximize/Minimize toggle button */}
        {onToggleMaximize && (
          <button
            onClick={onToggleMaximize}
            className="canvas-tab-bar-action"
            title={isMaximized ? t('Exit fullscreen') : t('Enter fullscreen')}
          >
            {isMaximized ? (
              <Minimize2 className="w-4 h-4" />
            ) : (
              <Maximize2 className="w-4 h-4" />
            )}
          </button>
        )}
      </div>
    </div>
  )
}

interface TabItemProps {
  tab: TabState
  index: number
  isActive: boolean
  isDragging: boolean
  isDropTarget: boolean
  isClosing: boolean
  isNew: boolean
  onClick: () => void
  onClose: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
}

const TabItem = forwardRef<HTMLDivElement, TabItemProps>(function TabItem({
  tab,
  index,
  isActive,
  isDragging,
  isDropTarget,
  isClosing,
  isNew,
  onClick,
  onClose,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd
}, ref) {
  const { t } = useTranslation()
  // Get file extension for icon
  const extension = tab.path?.split('.').pop() || ''

  // Handle middle-click to close tab
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1) {
      // Middle mouse button
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  // Build class names
  const classNames = [
    'canvas-tab',
    isActive && 'active',
    isDragging && 'dragging',
    isDropTarget && 'drop-target',
    isClosing && 'closing',
    isNew && 'appearing',
  ].filter(Boolean).join(' ')

  return (
    <div
      ref={ref}
      draggable
      onClick={onClick}
      onMouseDown={handleMouseDown}
      onContextMenu={onContextMenu}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={classNames}
    >
      {/* Active tab bottom punch-through element */}
      {isActive && <div className="canvas-tab-punch" />}

      {/* Status indicator / File icon */}
      <div className="canvas-tab-icon">
        {tab.isLoading ? (
          <Loader2 className="w-4 h-4 animate-spin text-primary" />
        ) : tab.error ? (
          <AlertCircle className="w-4 h-4 text-destructive" />
        ) : (
          <FileIcon
            extension={extension}
            isFolder={false}
            size={16}
          />
        )}
      </div>

      {/* Title */}
      <span className="canvas-tab-title">
        {tab.title}
      </span>

      {/* Dirty indicator (unsaved changes) */}
      {tab.isDirty && (
        <div className="canvas-tab-dirty" />
      )}

      {/* Actions - only close button, shown on hover */}
      <div className="canvas-tab-actions">
        {/* Close button */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          className="canvas-tab-close"
          title={t('Close (⌘W / Middle-click)')}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
})

/**
 * Standalone Canvas Tab Bar - Used in the main layout
 * Uses canvasLifecycle for all state and actions
 */
export function CanvasTabBar() {
  const { t } = useTranslation()
  const { tabs, activeTabId, switchTab, closeTab, closeAllTabs, refreshTab, openUrl } = useCanvasLifecycle()
  const isCanvasMaximized = useCanvasStore(state => state.isMaximized)
  const toggleCanvasMaximized = useCanvasStore(state => state.toggleMaximized)
  const { isMaximized: isWindowMaximized, toggleMaximize: toggleWindowMaximize } = useWindowMaximize()

  // Combined maximize state: both window AND canvas are maximized
  const isFullyMaximized = isCanvasMaximized && isWindowMaximized

  // Handle new tab - opens Bing as default
  const handleNewTab = useCallback(() => {
    openUrl(DEFAULT_NEW_TAB_URL, t('New Tab'))
  }, [openUrl, t])

  // Handle combined maximize toggle: window maximize + canvas fullscreen
  const handleToggleMaximize = useCallback(async () => {
    if (isFullyMaximized) {
      // Exit: restore window size first, then exit canvas fullscreen
      await toggleWindowMaximize()
      toggleCanvasMaximized()
    } else {
      // Enter: maximize window and canvas fullscreen together
      if (!isWindowMaximized) {
        await toggleWindowMaximize()
      }
      if (!isCanvasMaximized) {
        toggleCanvasMaximized()
      }
    }
  }, [isFullyMaximized, isWindowMaximized, isCanvasMaximized, toggleWindowMaximize, toggleCanvasMaximized])

  return (
    <CanvasTabs
      tabs={tabs}
      activeTabId={activeTabId}
      onTabClick={switchTab}
      onTabClose={closeTab}
      onRefresh={refreshTab}
      onNewTab={handleNewTab}
      onCloseAll={closeAllTabs}
      isMaximized={isFullyMaximized}
      onToggleMaximize={handleToggleMaximize}
    />
  )
}
