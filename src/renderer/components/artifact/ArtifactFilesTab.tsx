/**
 * ArtifactFilesTab - "Files" content for the space resource rail
 *
 * Owns everything specific to browsing a space's files: the tree/card view
 * toggle, artifact loading + live change subscription, card-view rendering
 * and its context menu, and the "open folder" action. ArtifactRail (the
 * shell) only owns expand/collapse, resize and the tab strip — this is the
 * one tab that exists today; Skill/MCP tabs join as siblings later.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ArtifactCard, type ArtifactContextMenuState } from './ArtifactCard'
import { ArtifactTree } from './ArtifactTree'
import { api } from '../../api'
import type { Artifact, ArtifactViewMode, ArtifactChangeEvent } from '../../types'
import { useIsGenerating } from '../../stores/chat.store'
import { useSpaceStore } from '../../stores/space.store'
import { useOnboardingStore } from '../../stores/onboarding.store'
import { FolderOpen, Monitor, LayoutGrid, FolderTree } from 'lucide-react'
import { ONBOARDING_ARTIFACT_NAME } from '../onboarding/onboardingData'
import { useTranslation } from '../../i18n'
import { copyToClipboard } from '../../utils/clipboard'

const isWebMode = api.isRemoteMode()
const VIEW_MODE_STORAGE_KEY = 'halo:artifact-view-mode'

function getInitialViewMode(): ArtifactViewMode {
  if (typeof window === 'undefined') return 'tree'
  const stored = localStorage.getItem(VIEW_MODE_STORAGE_KEY)
  return (stored === 'tree' || stored === 'card') ? stored : 'tree'
}

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
    relativePath: candidate.relativePath || candidate.name,
    preview: undefined,
    size: typeof candidate.size === 'number' ? candidate.size : undefined
  }
}

export function ArtifactFilesTab() {
  const { t } = useTranslation()

  const currentSpace = useSpaceStore(state => state.currentSpace)
  const spaceId = currentSpace?.id ?? ''
  const isTemp = currentSpace?.isTemp ?? false

  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [viewMode, setViewMode] = useState<ArtifactViewMode>(getInitialViewMode)
  const [cardContextMenu, setCardContextMenu] = useState<ArtifactContextMenuState | null>(null)
  const cardContextMenuRef = useRef<HTMLDivElement>(null)
  const isGenerating = useIsGenerating()
  const { isActive: isOnboarding, currentStep, completeOnboarding } = useOnboardingStore()

  const handleOpenFolder = useCallback(() => {
    if (spaceId) {
      useSpaceStore.getState().openSpaceFolder(spaceId)
    }
  }, [spaceId])

  const handleShowCardContextMenu = useCallback((menu: ArtifactContextMenuState) => {
    setCardContextMenu(menu)
  }, [])

  const handleCopyRelativePath = useCallback(async (relativePath: string) => {
    try {
      await copyToClipboard(relativePath)
    } catch (error) {
      console.error('[ArtifactFilesTab] Failed to copy relative path:', error)
    }
    setCardContextMenu(null)
  }, [])

  const handleRevealInFolder = useCallback(async (path: string) => {
    if (isWebMode) return
    try {
      await api.showArtifactInFolder(path)
    } catch (error) {
      console.error('[ArtifactFilesTab] Failed to show in folder:', error)
    }
    setCardContextMenu(null)
  }, [])

  // Dismiss card context menu on outside click or Escape
  useEffect(() => {
    if (!cardContextMenu) return
    const handlePointerDown = (e: MouseEvent) => {
      if (cardContextMenuRef.current && !cardContextMenuRef.current.contains(e.target as Node)) {
        setCardContextMenu(null)
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCardContextMenu(null)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [cardContextMenu])

  // Adjust card context menu position to stay within viewport
  useEffect(() => {
    if (!cardContextMenu || !cardContextMenuRef.current) return
    const rect = cardContextMenuRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let { x, y } = cardContextMenu
    if (x + rect.width > vw) x = vw - rect.width - 8
    if (y + rect.height > vh) y = vh - rect.height - 8
    if (x < 0) x = 8
    if (y < 0) y = 8
    cardContextMenuRef.current.style.left = `${x}px`
    cardContextMenuRef.current.style.top = `${y}px`
  }, [cardContextMenu])

  const toggleViewMode = useCallback(() => {
    setViewMode(prev => {
      const next = prev === 'card' ? 'tree' : 'card'
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, next)
      return next
    })
  }, [])

  const loadArtifacts = useCallback(async () => {
    if (!spaceId) return
    try {
      setIsLoading(true)
      const response = await api.listArtifacts(spaceId)
      if (response.success && response.data) {
        setArtifacts(response.data as Artifact[])
      }
    } catch (error) {
      console.error('[ArtifactFilesTab] Failed to load artifacts:', error)
    } finally {
      setIsLoading(false)
    }
  }, [spaceId])

  useEffect(() => {
    loadArtifacts()
  }, [loadArtifacts])

  useEffect(() => {
    if (!isGenerating) {
      const timer = setTimeout(loadArtifacts, 500)
      return () => clearTimeout(timer)
    }
  }, [isGenerating, loadArtifacts])

  useEffect(() => {
    if (!spaceId) return

    api.initArtifactWatcher(spaceId).catch(err => {
      console.error('[ArtifactFilesTab] Failed to init watcher:', err)
    })

    const cleanup = api.onArtifactChanged((event: ArtifactChangeEvent) => {
      if (event.spaceId !== spaceId) return

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

  const isOnboardingViewStep = isOnboarding && currentStep === 'view-artifact'

  const handleOnboardingArtifactClick = useCallback(() => {
    if (isOnboardingViewStep) {
      setTimeout(() => {
        completeOnboarding()
      }, 500)
    }
  }, [isOnboardingViewStep, completeOnboarding])

  useEffect(() => {
    if (isOnboardingViewStep) {
      const timer = setTimeout(loadArtifacts, 300)
      return () => clearTimeout(timer)
    }
  }, [isOnboardingViewStep, loadArtifacts])

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Tab-local toolbar: tree/card toggle + open folder */}
      <div className="flex-shrink-0 px-2 h-9 border-b border-border/60 flex items-center justify-between">
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
        {isWebMode ? (
          <span
            className="flex items-center gap-1.5 text-xs text-muted-foreground/50 cursor-not-allowed"
            title={t('Please open folder in client')}
          >
            <Monitor className="w-3.5 h-3.5" />
          </span>
        ) : (
          <button
            onClick={handleOpenFolder}
            className="p-1 hover:bg-secondary rounded transition-colors"
            title={t('Open folder')}
          >
            <FolderOpen className="w-3.5 h-3.5 text-amber-500" />
          </button>
        )}
      </div>

      {/* Content */}
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
                <p className="text-xs text-muted-foreground text-center mb-1">
                  {artifacts.length} {t('artifacts')}
                </p>
                {artifacts.map((artifact) => {
                  const isOnboardingArtifact = artifact.name === ONBOARDING_ARTIFACT_NAME

                  return (
                    <div
                      key={artifact.id}
                      data-onboarding={isOnboardingArtifact && isOnboardingViewStep ? 'artifact-card' : undefined}
                      onClick={isOnboardingArtifact && isOnboardingViewStep ? handleOnboardingArtifactClick : undefined}
                    >
                      <ArtifactCard artifact={artifact} onShowContextMenu={handleShowCardContextMenu} />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Card view context menu (portal to body for correct z-index) */}
      {cardContextMenu && createPortal(
        <div
          ref={cardContextMenuRef}
          role="menu"
          className="fixed z-[9999] min-w-[180px] bg-popover border border-border rounded-lg shadow-lg py-1"
          style={{ top: cardContextMenu.y, left: cardContextMenu.x }}
        >
          <button
            role="menuitem"
            onClick={() => handleCopyRelativePath(cardContextMenu.relativePath)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary transition-colors text-left"
          >
            <span>{t('Copy relative path')}</span>
          </button>
          {!isWebMode && (
            <button
              role="menuitem"
              onClick={() => handleRevealInFolder(cardContextMenu.path)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary transition-colors text-left"
            >
              <span>{cardContextMenu.isFolder ? t('Open folder location') : t('Show in folder')}</span>
            </button>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
