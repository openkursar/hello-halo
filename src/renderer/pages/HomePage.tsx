/**
 * Home Page - Space list view
 */

import React, { useEffect, useState } from 'react'
import { useAppStore } from '../stores/app.store'
import { useSpaceStore } from '../stores/space.store'
import { SPACE_ICONS, DEFAULT_SPACE_ICON } from '../types'
import type { Space, SpaceIconId } from '../types'
import {
  SpaceIcon,
  Sparkles,
  Settings,
  Plus,
  Trash2,
  Pencil
} from '../components/icons/ToolIcons'
import { Header } from '../components/layout/Header'
import { SpaceGuide } from '../components/space/SpaceGuide'
import { CreateSpaceDialog } from '../components/space/CreateSpaceDialog'
import { Blocks, ArrowRight, AlertCircle, SendHorizontal, Unplug, BookOpen } from 'lucide-react'
import { api } from '../api'
import { useTranslation } from '../i18n'
import { useAppsStore } from '../stores/apps.store'
import { useAppsPageStore } from '../stores/apps-page.store'
import type { InstalledApp } from '../../shared/apps/app-types'
import type { AppType } from '../../shared/apps/spec-types'

export function HomePage() {
  const { t } = useTranslation()
  const { setView } = useAppStore()
  const { haloSpace, spaces, loadSpaces, setCurrentSpace, refreshCurrentSpace, updateSpace, deleteSpace } = useSpaceStore()
  const { apps, loadApps } = useAppsStore()
  const { setInitialAppId, setCurrentTab, setShowInstallDialog, openMarketplaceFilteredBy } = useAppsPageStore()

  // Load apps on mount for the Apps card
  useEffect(() => {
    loadApps()
  }, [loadApps])

  // Dialog state
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  // Edit dialog state
  const [editingSpace, setEditingSpace] = useState<Space | null>(null)
  const [editSpaceName, setEditSpaceName] = useState('')
  const [editSpaceIcon, setEditSpaceIcon] = useState<SpaceIconId>(DEFAULT_SPACE_ICON)

  // Load spaces on mount
  useEffect(() => {
    loadSpaces()
  }, [loadSpaces])

  // Handle space click - no reset needed, SpacePage handles its own state
  const handleSpaceClick = (space: Space) => {
    if (space.isMissing) return
    setCurrentSpace(space)
    refreshCurrentSpace()  // Load full space data (preferences) from backend
    setView('space')
  }

  // Handle delete space
  const handleDeleteSpace = async (e: React.MouseEvent, spaceId: string) => {
    e.stopPropagation()

    // Find the space to check if it's a custom path
    const space = spaces.find(s => s.id === spaceId)
    if (!space) return

    // Check if it's a project-linked space:
    // - New centralized spaces with project: have workingDir
    // - Legacy custom spaces: path doesn't end with /spaces/{uuid}
    //   (centralized paths are always {haloDir}/spaces/{uuid-v4}, uuid is 36 chars)
    const lastSegment = space.path.split(/[/\\]/).pop() ?? ''
    const isCentralizedSpace = space.path.includes('/spaces/') && lastSegment.length === 36
    const isProjectSpace = !!space.workingDir || !isCentralizedSpace

    const message = isProjectSpace
      ? t('Are you sure you want to delete this space?\n\nOnly Halo data (conversation history) will be deleted, your project files will be kept.')
      : t('Are you sure you want to delete this space?\n\nAll conversations and files in the space will be deleted.')

    if (confirm(message)) {
      await deleteSpace(spaceId)
    }
  }

  // Handle edit space - open dialog
  const handleEditSpace = (e: React.MouseEvent, space: Space) => {
    e.stopPropagation()
    setEditingSpace(space)
    setEditSpaceName(space.name)
    setEditSpaceIcon(space.icon as SpaceIconId)
  }

  // Handle save space edit
  const handleSaveEdit = async () => {
    if (!editingSpace || !editSpaceName.trim()) return

    await updateSpace(editingSpace.id, {
      name: editSpaceName.trim(),
      icon: editSpaceIcon
    })

    setEditingSpace(null)
    setEditSpaceName('')
    setEditSpaceIcon(DEFAULT_SPACE_ICON)
  }

  // Handle cancel edit
  const handleCancelEdit = () => {
    setEditingSpace(null)
    setEditSpaceName('')
    setEditSpaceIcon(DEFAULT_SPACE_ICON)
  }

  // Format time ago
  const formatTimeAgo = (dateStr: string) => {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffDays === 0) return t('Today')
    if (diffDays === 1) return t('Yesterday')
    if (diffDays < 7) return t('{{count}} days ago', { count: diffDays })
    if (diffDays < 30) return t('{{count}} weeks ago', { count: Math.floor(diffDays / 7) })
    return t('{{count}} months ago', { count: Math.floor(diffDays / 30) })
  }

  return (
    <div className="h-full w-full flex flex-col">
      {/* Header - cross-platform support */}
      <Header
        left={
          <>
            <div className="w-[22px] h-[22px] rounded-full border-2 border-primary/60 flex items-center justify-center">
              <div className="w-3 h-3 rounded-full bg-gradient-to-br from-primary/30 to-transparent" />
            </div>
            <span className="text-sm font-medium">Halo</span>
          </>
        }
        right={
          <button
            onClick={() => setView('settings')}
            className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
          >
            <Settings className="w-5 h-5" />
          </button>
        }
      />

      {/* Content */}
      <main className="flex-1 overflow-auto p-6">
        {/* Primary entry cards: Halo Space + Apps */}
        <div className="grid grid-cols-2 gap-4 mb-8 animate-fade-in">
          {/* Halo Space card */}
          {haloSpace && (
            <div
              data-onboarding="halo-space"
              onClick={() => handleSpaceClick(haloSpace)}
              className="halo-space-card p-5 rounded-xl cursor-pointer flex flex-col justify-between min-h-[160px]"
            >
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-primary" />
                <h2 className="text-sm font-semibold">{t('Halo')}</h2>
              </div>
              <div className="flex flex-col gap-2 px-3 pt-3 pb-2 rounded-xl bg-background/60 border border-primary/20 min-h-[72px]">
                <span className="text-xs text-muted-foreground flex-1">
                  {t('Ask me anything...')}
                </span>
                <div className="flex justify-end">
                  <SendHorizontal className="w-4 h-4 text-primary/50" />
                </div>
              </div>
            </div>
          )}

          {/* Studio card — three categorized rows (digital humans / skills / MCP) */}
          <StudioCard
            apps={apps}
            onOpenAutomationList={() => {
              setCurrentTab('my-digital-humans')
              setView('apps')
            }}
            onOpenSkillsList={() => {
              setCurrentTab('my-skills')
              setView('apps')
            }}
            onOpenMcpList={() => {
              setCurrentTab('my-mcp')
              setView('apps')
            }}
            onSelectApp={(appId) => {
              setInitialAppId(appId)
              setView('apps')
            }}
            onCreateAutomation={() => {
              setCurrentTab('my-digital-humans')
              setShowInstallDialog(true)
              setView('apps')
            }}
            onBrowseSkillsMarket={() => {
              // Set view first so AppsPage mounts and StoreView's
              // mount-effect doesn't skip the load. The store action then
              // atomically sets filter + tab and forces a fresh fetch.
              setView('apps')
              void openMarketplaceFilteredBy('skill')
            }}
            onBrowseMcpMarket={() => {
              setView('apps')
              void openMarketplaceFilteredBy('mcp')
            }}
          />
        </div>

        {/* Knowledge entry — opens the Tlon knowledge-base manager */}
        <button
          onClick={() => setView('tlon')}
          className="w-full mb-8 flex items-center gap-3 p-4 rounded-xl border border-border bg-card hover:bg-secondary transition-colors text-left group"
        >
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
            <BookOpen className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t('Knowledge')}</p>
            <p className="text-xs text-muted-foreground truncate">
              {t('Teach Halo from your files and folders')}
            </p>
          </div>
          <ArrowRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
        </button>

        {/* Spaces Section */}
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-medium text-muted-foreground">{t('Dedicated Spaces')}</h3>
          <button
            onClick={() => setShowCreateDialog(true)}
            className="flex items-center gap-1 px-3 py-1 text-sm text-primary hover:bg-primary/10 rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            {t('New')}
          </button>
        </div>

        {/* Space Guide - always visible */}
        <SpaceGuide />

        {spaces.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <p className="text-sm">{t('No dedicated spaces yet')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {spaces.map((space, i) => (
              <div
                key={`${space.id}-${i}`}
                onClick={() => handleSpaceClick(space)}
                className={`space-card p-4 group animate-fade-in ${
                  space.isMissing ? 'opacity-70 cursor-not-allowed border-dashed' : ''
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <SpaceIcon iconId={space.icon} size={20} />
                    <span className="font-medium truncate">{space.name}</span>
                    {space.isMissing && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        <Unplug className="w-3 h-3" />
                        {t('Unavailable')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                    <button
                      onClick={(e) => handleEditSpace(e, space)}
                      className="p-1 hover:bg-secondary rounded transition-all"
                      title={t('Edit Space')}
                    >
                      <Pencil className="w-4 h-4 text-muted-foreground" />
                    </button>
                    <button
                      onClick={(e) => handleDeleteSpace(e, space.id)}
                      className="p-1 hover:bg-destructive/20 rounded transition-all"
                      title={t('Delete space')}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  {space.isMissing
                    ? t('Path unavailable. Reconnect the drive to open this space.')
                    : `${formatTimeAgo(space.lastActiveAt || space.updatedAt)}${t('active')}`}
                </p>
              </div>
            ))}
          </div>
        )}
      </main>

      {showCreateDialog && (
        <CreateSpaceDialog
          onClose={() => setShowCreateDialog(false)}
          onCreated={() => setShowCreateDialog(false)}
        />
      )}

      {/* Edit Space Dialog */}
      {editingSpace && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card border border-border rounded-xl p-6 w-full max-w-md animate-fade-in">
            <h2 className="text-lg font-medium mb-4">{t('Edit Space')}</h2>

            {/* Space name */}
            <div className="mb-4">
              <label className="block text-sm text-muted-foreground mb-2">{t('Space Name')}</label>
              <input
                type="text"
                value={editSpaceName}
                onChange={(e) => setEditSpaceName(e.target.value)}
                placeholder={t('My Project')}
                className="w-full px-4 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
                autoFocus
              />
            </div>

            {/* Icon select */}
            <div className="mb-6">
              <label className="block text-sm text-muted-foreground mb-2">{t('Icon')}</label>
              <div className="flex flex-wrap gap-2">
                {SPACE_ICONS.map((iconId) => (
                  <button
                    key={iconId}
                    onClick={() => setEditSpaceIcon(iconId)}
                    className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
                      editSpaceIcon === iconId
                        ? 'bg-primary/20 border-2 border-primary'
                        : 'bg-secondary hover:bg-secondary/80'
                    }`}
                  >
                    <SpaceIcon iconId={iconId} size={20} />
                  </button>
                ))}
              </div>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3">
              <button
                onClick={handleCancelEdit}
                className="px-4 py-2 text-muted-foreground hover:bg-secondary rounded-lg transition-colors"
              >
                {t('Cancel')}
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={!editSpaceName.trim()}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('Save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────
// Studio card — three categorized rows on the home page
// ──────────────────────────────────────────────

interface StudioCardProps {
  apps: InstalledApp[]
  onOpenAutomationList: () => void
  onOpenSkillsList: () => void
  onOpenMcpList: () => void
  /** Open AppsPage with a specific app pre-selected */
  onSelectApp: (appId: string) => void
  onCreateAutomation: () => void
  onBrowseSkillsMarket: () => void
  onBrowseMcpMarket: () => void
}

function StudioCard({
  apps,
  onOpenAutomationList,
  onOpenSkillsList,
  onOpenMcpList,
  onSelectApp,
  onCreateAutomation,
  onBrowseSkillsMarket,
  onBrowseMcpMarket,
}: StudioCardProps) {
  const { t } = useTranslation()

  const automationApps = apps.filter(a => a.spec.type === 'automation' && a.status !== 'uninstalled')
  const skillApps = apps.filter(a => a.spec.type === 'skill' && a.status !== 'uninstalled')
  const mcpApps = apps.filter(a => a.spec.type === 'mcp' && a.status !== 'uninstalled')

  return (
    <div
      onClick={onOpenAutomationList}
      className="p-5 rounded-xl cursor-pointer border border-border hover:border-primary/40 hover:bg-secondary/50 transition-colors flex flex-col gap-3 min-h-[160px]"
    >
      <div className="flex items-center gap-2">
        <Blocks className="w-5 h-5 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t('Studio')}</h2>
      </div>

      <div className="flex-1 flex flex-col gap-2">
        <StudioRow
          label={t('Digital Humans')}
          type="automation"
          apps={automationApps}
          onOpenList={onOpenAutomationList}
          onSelectApp={onSelectApp}
          emptyAction={{ label: t('Create'), onAction: onCreateAutomation }}
        />
        <StudioRow
          label={t('Skills')}
          type="skill"
          apps={skillApps}
          onOpenList={onOpenSkillsList}
          onSelectApp={onSelectApp}
          emptyAction={{ label: t('Add from marketplace'), onAction: onBrowseSkillsMarket }}
        />
        <StudioRow
          label={t('MCP')}
          type="mcp"
          apps={mcpApps}
          onOpenList={onOpenMcpList}
          onSelectApp={onSelectApp}
          emptyAction={{ label: t('Add from marketplace'), onAction: onBrowseMcpMarket }}
        />
      </div>

      <div className="flex justify-end">
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          {t('Open')} <ArrowRight className="w-3 h-3" />
        </span>
      </div>
    </div>
  )
}

interface StudioRowProps {
  label: string
  type: AppType
  apps: InstalledApp[]
  onOpenList: () => void
  onSelectApp: (appId: string) => void
  emptyAction: { label: string; onAction: () => void }
}

const PREVIEW_COUNT = 3

function StudioRow({ label, type, apps, onOpenList, onSelectApp, emptyAction }: StudioRowProps) {
  const isEmpty = apps.length === 0
  const previewApps = apps.slice(0, PREVIEW_COUNT)
  const extraCount = Math.max(0, apps.length - PREVIEW_COUNT)
  // Only automation apps have meaningful runtime status worth surfacing inline
  const showStatusDot = type === 'automation'

  return (
    <div
      onClick={e => {
        e.stopPropagation()
        if (isEmpty) emptyAction.onAction()
        else onOpenList()
      }}
      className="flex items-center gap-2 py-1 px-1 -mx-1 rounded hover:bg-secondary/60 transition-colors cursor-pointer"
    >
      <span className="text-xs font-medium text-foreground flex-shrink-0">{label}</span>
      <span className="text-[11px] text-muted-foreground flex-shrink-0 tabular-nums">{apps.length}</span>

      {isEmpty ? (
        <span className="text-xs text-muted-foreground/80 truncate flex-1 min-w-0">
          {emptyAction.label}
        </span>
      ) : (
        <span className="flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden">
          {previewApps.map(app => (
            <AppPreviewChip
              key={app.id}
              app={app}
              showStatusDot={showStatusDot}
              onSelect={() => onSelectApp(app.id)}
            />
          ))}
          {extraCount > 0 && (
            <span className="text-[11px] text-muted-foreground flex-shrink-0">+{extraCount}</span>
          )}
        </span>
      )}
    </div>
  )
}

interface AppPreviewChipProps {
  app: InstalledApp
  showStatusDot: boolean
  onSelect: () => void
}

function AppPreviewChip({ app, showStatusDot, onSelect }: AppPreviewChipProps) {
  const isWaiting = app.status === 'waiting_user'
  return (
    <button
      onClick={e => {
        e.stopPropagation()
        onSelect()
      }}
      className="flex items-center gap-1 max-w-[140px] hover:opacity-80 transition-opacity min-w-0"
    >
      {showStatusDot && (
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
          isWaiting ? 'bg-orange-400' :
          app.status === 'active' ? 'bg-green-500/70' :
          app.status === 'error' ? 'bg-red-500' : 'border border-muted-foreground/40'
        }`} />
      )}
      <span className="text-xs text-foreground truncate">{app.spec.name}</span>
      {showStatusDot && isWaiting && (
        <AlertCircle className="w-3 h-3 text-orange-400 flex-shrink-0" />
      )}
    </button>
  )
}
