/**
 * Artifact Rail - Side panel showing created files
 *
 * Desktop (>=640px): Inline panel with drag-to-resize
 * Mobile (<640px): Floating button + Overlay panel
 *
 * Supports view mode toggle: Card (default) vs Tree (developer mode)
 * Supports external control for Canvas integration (smart collapse)
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { ArtifactCard } from './ArtifactCard'
import { ArtifactTree } from './ArtifactTree'
import { api } from '../../api'
import type { Artifact, ArtifactViewMode, ArtifactChangeEvent } from '../../types'
import { useIsGenerating } from '../../stores/chat.store'
import { useSpaceStore } from '../../stores/space.store'
import { useOnboardingStore } from '../../stores/onboarding.store'
import { useCanvasLifecycle } from '../../hooks/useCanvasLifecycle'
import { useCanvasStore } from '../../stores/canvas.store'
import { ChevronRight, FolderOpen, Monitor, LayoutGrid, FolderTree, X, Globe } from 'lucide-react'
import { ONBOARDING_ARTIFACT_NAME } from '../onboarding/onboardingData'
import { useTranslation } from '../../i18n'
import { useIsMobile } from '../../hooks/useIsMobile'

// Check if running in web mode
const isWebMode = api.isRemoteMode()

// Storage keys
const VIEW_MODE_STORAGE_KEY = 'halo:artifact-view-mode'

// Width constraints (in pixels) - Desktop only
const MIN_WIDTH = 200
const MAX_WIDTH = 400
const DEFAULT_WIDTH = 300
const COLLAPSED_WIDTH = 48
const clampWidth = (v: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, v))

interface ArtifactRailProps {
  // External control props for Canvas integration
  externalExpanded?: boolean        // Controlled expanded state from parent
  onExpandedChange?: (expanded: boolean) => void  // Callback when user toggles
  // Width persistence
  initialWidth?: number             // Persisted width from config
  onWidthChange?: (width: number) => void  // Callback when user finishes resizing
}

// Load initial view mode from storage
function getInitialViewMode(): ArtifactViewMode {
  if (typeof window === 'undefined') return 'card'
  const stored = localStorage.getItem(VIEW_MODE_STORAGE_KEY)
  return (stored === 'tree' || stored === 'card') ? stored : 'card'
}

// Default browser home URL
const DEFAULT_BROWSER_URL = 'https://www.bing.com'

function normalizeArtifactFromEvent(item: unknown, fallbackSpaceId: string): Artifact | null {
  if (!item || typeof item !== 'object') return null
  const candidate = item as Partial<Artifact> & {
    path?: string
    name?: string
    type?: string
    icon?: string
    extension?: string
    size?: number
    createdAt?: string
    spaceId?: string
    id?: string
  }

  if (!candidate.path || !candidate.name) {
    return null
  }

  return {
    id: candidate.id || `artifact-${Date.now()}`,
    spaceId: candidate.spaceId || fallbackSpaceId,
    conversationId: 'all',
    name: candidate.name,
    type: candidate.type === 'folder' ? 'folder' : 'file',
    path: candidate.path,
    extension: candidate.extension || '',
    icon: candidate.icon || 'file-text',
    createdAt: candidate.createdAt || new Date().toISOString(),
    preview: undefined,
    size: typeof candidate.size === 'number' ? candidate.size : undefined
  }
}

export function ArtifactRail({
  externalExpanded,
  onExpandedChange,
  initialWidth,
  onWidthChange
}: ArtifactRailProps) {
  const { t } = useTranslation()

  // Self-subscribe to space data
  const currentSpace = useSpaceStore(state => state.currentSpace)
  const spaceId = currentSpace?.id ?? ''
  const isTemp = currentSpace?.isTemp ?? false

  const handleOpenFolder = useCallback(() => {
    if (spaceId) {
      useSpaceStore.getState().openSpaceFolder(spaceId)
    }
  }, [spaceId])

  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  // Use external control if provided, otherwise internal state
  const isControlled = externalExpanded !== undefined
  const [internalExpanded, setInternalExpanded] = useState(true)
  const isExpanded = isControlled ? externalExpanded : internalExpanded

  const [isLoading, setIsLoading] = useState(false)
  const [width, setWidth] = useState(initialWidth != null ? clampWidth(initialWidth) : DEFAULT_WIDTH)
  const widthRef = useRef(width)
  const [isDragging, setIsDragging] = useState(false)

  // Sync width when initialWidth arrives from async config load
  useEffect(() => {
    if (initialWidth !== undefined && !isDragging) {
      const clamped = clampWidth(initialWidth)
      setWidth(clamped)
      widthRef.current = clamped
    }
  }, [initialWidth, isDragging])
  const [viewMode, setViewMode] = useState<ArtifactViewMode>(getInitialViewMode)
  const [mobileOverlayOpen, setMobileOverlayOpen] = useState(false)
  const railRef = useRef<HTMLDivElement>(null)
  const onWidthChangeRef = useRef(onWidthChange)
  onWidthChangeRef.current = onWidthChange
  const isGenerating = useIsGenerating()
  const { isActive: isOnboarding, currentStep, completeOnboarding } = useOnboardingStore()
  const isMobile = useIsMobile()

  // Canvas lifecycle for opening browser
  const { openUrl } = useCanvasLifecycle()

  // When Canvas is open, disable transition to prevent layout flicker during resize/close
  const isCanvasOpen = useCanvasStore(state => state.isOpen)

  // Handle expand/collapse toggle
  const handleToggleExpanded = useCallback(() => {
    console.log('[ArtifactRail] 🔴 Click! isExpanded:', isExpanded, 'time:', Date.now())
    const newExpanded = !isExpanded

    // UI-first optimization: When Canvas is open, directly update DOM
    // before React state update to ensure layout resizes immediately
    if (isCanvasOpen && railRef.current) {
      const targetWidth = newExpanded ? width : COLLAPSED_WIDTH
      railRef.current.style.width = `${targetWidth}px`
      console.log('[ArtifactRail] 🚀 Direct DOM update:', targetWidth, 'time:', Date.now())
    }

    // Then update React state (will re-render but width is already correct)
    if (isControlled) {
      onExpandedChange?.(newExpanded)
    } else {
      setInternalExpanded(newExpanded)
    }
  }, [isExpanded, isControlled, onExpandedChange, isCanvasOpen, width])

  // Debug: log when isExpanded changes
  useEffect(() => {
    console.log('[ArtifactRail] 🟢 isExpanded changed to:', isExpanded, 'time:', Date.now())
  }, [isExpanded])

  // Check if we're in onboarding view-artifact step
  const isOnboardingViewStep = isOnboarding && currentStep === 'view-artifact'

  // Handle artifact click during onboarding
  // Delay completion so user can see the file open first
  const handleOnboardingArtifactClick = useCallback(() => {
    if (isOnboardingViewStep) {
      // Let the ArtifactCard's click handler open the file first
      // Then complete onboarding after a short delay
      setTimeout(() => {
        completeOnboarding()
      }, 500)
    }
  }, [isOnboardingViewStep, completeOnboarding])

  // Toggle view mode and persist
  const toggleViewMode = useCallback(() => {
    setViewMode(prev => {
      const next = prev === 'card' ? 'tree' : 'card'
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, next)
      return next
    })
  }, [])

  // Handle drag resize (desktop only)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (isMobile) return
    e.preventDefault()
    setIsDragging(true)
  }, [isMobile])

  useEffect(() => {
    if (!isDragging || isMobile) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!railRef.current) return
      const newWidth = window.innerWidth - e.clientX
      const clampedWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, newWidth))
      setWidth(clampedWidth)
      widthRef.current = clampedWidth
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      onWidthChangeRef.current?.(widthRef.current)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, isMobile])

  // Close mobile overlay when switching to desktop
  useEffect(() => {
    if (!isMobile && mobileOverlayOpen) {
      setMobileOverlayOpen(false)
    }
  }, [isMobile, mobileOverlayOpen])

  // Load artifacts from the main process
  const loadArtifacts = useCallback(async () => {
    if (!spaceId) return

    try {
      setIsLoading(true)
      const response = await api.listArtifacts(spaceId)
      if (response.success && response.data) {
        setArtifacts(response.data as Artifact[])
      }
    } catch (error) {
      console.error('[ArtifactRail] Failed to load artifacts:', error)
    } finally {
      setIsLoading(false)
    }
  }, [spaceId])

  // Load artifacts on mount and when space changes
  useEffect(() => {
    loadArtifacts()
  }, [loadArtifacts])

  // Refresh artifacts when generation completes (debounced)
  useEffect(() => {
    if (!isGenerating) {
      const timer = setTimeout(loadArtifacts, 500)
      return () => clearTimeout(timer)
    }
  }, [isGenerating, loadArtifacts])

  // Subscribe to artifact change events for incremental updates
  useEffect(() => {
    if (!spaceId) return

    // Initialize watcher for this space
    api.initArtifactWatcher(spaceId).catch(err => {
      console.error('[ArtifactRail] Failed to init watcher:', err)
    })

    // Subscribe to change events
    const cleanup = api.onArtifactChanged((event: ArtifactChangeEvent) => {
      if (event.spaceId !== spaceId) return

      console.log('[ArtifactRail] Artifact changed:', event.type, event.relativePath)

      const normalizedArtifact = event.item
        ? normalizeArtifactFromEvent(event.item, spaceId)
        : null

      switch (event.type) {
        case 'add':
        case 'addDir':
          if (normalizedArtifact) {
            setArtifacts(prev => {
              if (prev.some(a => a.path === normalizedArtifact.path)) return prev
              return [normalizedArtifact, ...prev]
            })
          } else {
            loadArtifacts()
          }
          break

        case 'unlink':
        case 'unlinkDir':
          setArtifacts(prev => prev.filter(a => a.path !== event.path))
          break

        case 'change':
          if (normalizedArtifact) {
            setArtifacts(prev =>
              prev.map(a => (a.path === normalizedArtifact.path ? normalizedArtifact : a))
            )
          } else {
            loadArtifacts()
          }
          break
      }
    })

    return cleanup
  }, [spaceId, loadArtifacts])

  // Refresh artifacts when entering view-artifact onboarding step
  useEffect(() => {
    if (isOnboardingViewStep) {
      // Delay slightly to ensure file is written
      const timer = setTimeout(loadArtifacts, 300)
      return () => clearTimeout(timer)
    }
  }, [isOnboardingViewStep, loadArtifacts])

  // Handle opening browser - also collapse the rail to maximize browser area
  const handleOpenBrowser = useCallback(() => {
    openUrl(DEFAULT_BROWSER_URL, 'Bing')
    // Auto-collapse rail when opening browser to maximize viewing area
    if (isControlled) {
      onExpandedChange?.(false)
    } else {
      setInternalExpanded(false)
    }
  }, [openUrl, isControlled, onExpandedChange])

  // Shared content renderer
  const renderContent = () => (
    <div className="flex-1 overflow-hidden">
      {viewMode === 'tree' ? (
        <ArtifactTree spaceId={spaceId} />
      ) : (
        <div className="h-full overflow-auto p-2">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-2">
              <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin mb-3" />
              <p className="text-xs text-muted-foreground">{t('Loading...')}</p>
            </div>
          ) : artifacts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-2">
              <div className="w-12 h-12 rounded-full border-2 border-dashed border-muted-foreground/30 flex items-center justify-center mb-3 halo-breathe">
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary/20 to-transparent" />
              </div>
              <p className="text-xs text-muted-foreground">
                {isTemp ? t('Ideas will crystallize here') : t('Files will appear here')}
              </p>
              {isGenerating && (
                <p className="text-xs text-primary/60 mt-2 animate-pulse">
                  {t('AI is working...')}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {artifacts.map((artifact) => {
                // Check if this is the onboarding artifact
                const isOnboardingArtifact = artifact.name === ONBOARDING_ARTIFACT_NAME

                return (
                  <div
                    key={artifact.id}
                    data-onboarding={isOnboardingArtifact && isOnboardingViewStep ? 'artifact-card' : undefined}
                    onClick={isOnboardingArtifact && isOnboardingViewStep ? handleOnboardingArtifactClick : undefined}
                  >
                    <ArtifactCard artifact={artifact} />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )

  // Shared footer renderer with folder and browser buttons
  // flex-shrink-0 ensures footer doesn't compress, allowing content to take remaining space
  const renderFooter = () => (
    <div className="flex-shrink-0 p-2 border-t border-border">
      {viewMode === 'card' && artifacts.length > 0 && (
        <p className="text-xs text-muted-foreground text-center mb-2">
          {artifacts.length} {t('artifacts')}
        </p>
      )}
      {isWebMode ? (
        <div className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs text-muted-foreground/50 rounded-lg cursor-not-allowed">
          <Monitor className="w-4 h-4" />
          <span>{t('Please open folder in client')}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {/* Open folder button */}
          <button
            onClick={handleOpenFolder}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground rounded-lg transition-colors"
            title={t('Open folder (⌘⇧F)')}
          >
            <FolderOpen className="w-4 h-4 text-amber-500" />
            <span>{t('Folder')}</span>
          </button>
          {/* Open browser button */}
          <button
            onClick={handleOpenBrowser}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground rounded-lg transition-colors"
            title={t('Open browser (⌘⇧B)')}
          >
            <Globe className="w-4 h-4 text-blue-500" />
            <span>{t('Browser')}</span>
          </button>
        </div>
      )}
    </div>
  )

  // ==================== Mobile Overlay Mode ====================
  if (isMobile) {
    return (
      <>
        {/* Floating trigger button - z-[60] to stay above Canvas overlay (z-50) */}
        <button
          onClick={() => setMobileOverlayOpen(true)}
          className="
            fixed right-0 top-1/3 z-[60]
            w-10 h-14
            bg-card/90 backdrop-blur-sm
            border-l border-y border-border
            rounded-l-xl
            shadow-lg
            flex flex-col items-center justify-center gap-1
            hover:bg-card
            active:scale-95
            transition-all duration-200
          "
          aria-label={t('Open artifacts panel')}
        >
          <FolderOpen className="w-4 h-4 text-amber-500" />
          {artifacts.length > 0 && (
            <span className="text-[10px] font-medium text-muted-foreground">
              {artifacts.length}
            </span>
          )}
        </button>

        {/* Overlay backdrop + panel - z-[70] to stay above Canvas overlay (z-50) */}
        {mobileOverlayOpen && (
          <div className="fixed inset-0 z-[70] flex justify-end">
            {/* Backdrop */}
            <div
              className="absolute inset-0 bg-background/60 backdrop-blur-sm animate-fade-in"
              onClick={() => setMobileOverlayOpen(false)}
            />

            {/* Slide-in panel */}
            <div
              className="
                relative w-[min(280px,75vw)] h-full
                bg-card border-l border-border
                flex flex-col
                animate-slide-in-right-full
                shadow-2xl
              "
            >
              {/* Header */}
              <div className="p-3 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-muted-foreground">{t('Artifacts')}</span>
                  <button
                    onClick={toggleViewMode}
                    className={`
                      p-1 rounded transition-all duration-200
                      hover:bg-secondary/80
                      ${viewMode === 'tree' ? 'bg-secondary text-primary' : 'text-muted-foreground/50 hover:text-muted-foreground'}
                    `}
                    title={viewMode === 'card' ? t('Switch to tree view') : t('Switch to card view')}
                  >
                    {viewMode === 'card' ? (
                      <FolderTree className="w-3.5 h-3.5" />
                    ) : (
                      <LayoutGrid className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
                <button
                  onClick={() => setMobileOverlayOpen(false)}
                  className="p-1 hover:bg-secondary rounded transition-colors"
                  aria-label={t('Close')}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Content */}
              {renderContent()}

              {/* Footer */}
              {renderFooter()}
            </div>
          </div>
        )}
      </>
    )
  }

  // ==================== Desktop Inline Mode ====================
  const displayWidth = isExpanded ? width : COLLAPSED_WIDTH

  return (
    <div
      ref={railRef}
      className="h-full flex-shrink-0 border-l border-border bg-card/30 flex flex-col relative"
      style={{
        width: displayWidth,
        // Disable transition when: dragging OR Canvas is open (prevent layout flicker)
        transition: (isDragging || isCanvasOpen) ? 'none' : 'width 0.2s ease'
      }}
    >
      {/* Drag handle - only show when expanded */}
      {isExpanded && (
        <div
          className={`absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/50 transition-colors z-20 ${
            isDragging ? 'bg-primary/50' : ''
          }`}
          onMouseDown={handleMouseDown}
          title={t('Drag to resize')}
        />
      )}

      {/* Header - height matches CanvasTabs (py-1.5 + h-7 content = ~40px) */}
      <div className="flex-shrink-0 px-3 h-10 border-b border-border flex items-center justify-between">
        {isExpanded && (
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-muted-foreground">{t('Artifacts')}</span>
            <button
              onClick={toggleViewMode}
              className={`
                p-1 rounded transition-all duration-200
                hover:bg-secondary/80
                ${viewMode === 'tree' ? 'bg-secondary text-primary' : 'text-muted-foreground/50 hover:text-muted-foreground'}
              `}
              title={viewMode === 'card' ? t('Switch to tree view (developer)') : t('Switch to card view')}
            >
              {viewMode === 'card' ? (
                <FolderTree className="w-3.5 h-3.5" />
              ) : (
                <LayoutGrid className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        )}
        <button
          onClick={handleToggleExpanded}
          className="p-1 hover:bg-secondary rounded transition-colors"
        >
          <ChevronRight className={`w-4 h-4 transition-transform ${isExpanded ? '' : 'rotate-180'}`} />
        </button>
      </div>

      {/* Content */}
      {isExpanded && renderContent()}

      {/* Footer */}
      {isExpanded && renderFooter()}

      {/* Collapsed state - show both folder and browser icons */}
      {!isExpanded && (
        <div className="flex-1 flex flex-col items-center py-4 gap-2">
          {isWebMode ? (
            <div
              className="p-2 rounded-lg cursor-not-allowed opacity-50"
              title={t('Please open folder in client')}
            >
              <Monitor className="w-5 h-5 text-muted-foreground" />
            </div>
          ) : (
            <>
              <button
                onClick={handleOpenFolder}
                className="p-2 hover:bg-secondary rounded-lg transition-colors"
                title={t('Open folder')}
              >
                <FolderOpen className="w-5 h-5 text-amber-500" />
              </button>
              <button
                onClick={handleOpenBrowser}
                className="p-2 hover:bg-secondary rounded-lg transition-colors"
                title={t('Open browser')}
              >
                <Globe className="w-5 h-5 text-blue-500" />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
