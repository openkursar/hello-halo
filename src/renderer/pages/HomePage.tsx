/**
 * Home Page - Space list view
 */

import React, { useEffect, useState, useRef } from 'react'
import { useAppStore } from '../stores/app.store'
import { useSpaceStore } from '../stores/space.store'
import { SPACE_ICONS, DEFAULT_SPACE_ICON } from '../types'
import type { Space, CreateSpaceInput, SpaceIconId } from '../types'
import {
  SpaceIcon,
  Sparkles,
  Settings,
  Plus,
  Trash2,
  FolderOpen,
  Pencil
} from '../components/icons/ToolIcons'
import { Header } from '../components/layout/Header'
import { SpaceGuide } from '../components/space/SpaceGuide'
import { Monitor } from 'lucide-react'
import { api } from '../api'
import { useTranslation } from '../i18n'

// Check if running in web mode
const isWebMode = api.isRemoteMode()

export function HomePage() {
  const { t } = useTranslation()
  const { setView } = useAppStore()
  const { haloSpace, spaces, loadSpaces, setCurrentSpace, refreshCurrentSpace, createSpace, updateSpace, deleteSpace } = useSpaceStore()

  // Dialog state
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newSpaceName, setNewSpaceName] = useState('')
  const [newSpaceIcon, setNewSpaceIcon] = useState<SpaceIconId>(DEFAULT_SPACE_ICON)

  // Edit dialog state
  const [editingSpace, setEditingSpace] = useState<Space | null>(null)
  const [editSpaceName, setEditSpaceName] = useState('')
  const [editSpaceIcon, setEditSpaceIcon] = useState<SpaceIconId>(DEFAULT_SPACE_ICON)

  // Path selection state
  const [useCustomPath, setUseCustomPath] = useState(false)
  const [customPath, setCustomPath] = useState<string | null>(null)
  const [defaultPath, setDefaultPath] = useState<string>('~/.halo/spaces')

  // Load spaces on mount
  useEffect(() => {
    loadSpaces()
  }, [loadSpaces])

  // Load default path when dialog opens
  useEffect(() => {
    if (showCreateDialog) {
      api.getDefaultSpacePath().then((res) => {
        if (res.success && res.data) {
          setDefaultPath(res.data as string)
        }
      })
      // Focus the space name input when dialog opens
      setTimeout(() => {
        spaceNameInputRef.current?.focus()
      }, 100)
    }
  }, [showCreateDialog])

  // Ref for space name input
  const spaceNameInputRef = useRef<HTMLInputElement>(null)

  // Handle folder selection
  const handleSelectFolder = async () => {
    if (isWebMode) return // Disabled in web mode
    const res = await api.selectFolder()
    if (res.success && res.data) {
      const path = res.data as string
      setCustomPath(path)
      setUseCustomPath(true)
      // Extract directory name as suggested space name
      const dirName = path.split('/').pop() || ''
      if (dirName && !newSpaceName.trim()) {
        setNewSpaceName(dirName)
      }
      // Focus the space name input
      setTimeout(() => {
        spaceNameInputRef.current?.focus()
        spaceNameInputRef.current?.select()
      }, 100)
    }
  }

  // Reset dialog state
  const resetDialog = () => {
    setShowCreateDialog(false)
    setNewSpaceName('')
    setNewSpaceIcon(DEFAULT_SPACE_ICON)
    setUseCustomPath(false)
    setCustomPath(null)
  }

  // Handle space click - no reset needed, SpacePage handles its own state
  const handleSpaceClick = (space: Space) => {
    setCurrentSpace(space)
    refreshCurrentSpace()  // Load full space data (preferences) from backend
    setView('space')
  }

  // Handle create space
  const handleCreateSpace = async () => {
    if (!newSpaceName.trim()) return

    const input: CreateSpaceInput = {
      name: newSpaceName.trim(),
      icon: newSpaceIcon,
      customPath: useCustomPath && customPath ? customPath : undefined
    }

    const newSpace = await createSpace(input)

    if (newSpace) {
      resetDialog()
    }
  }

  // Shorten path for display
  const shortenPath = (path: string) => {
    const home = path.includes('/Users/') ? path.replace(/\/Users\/[^/]+/, '~') : path
    return home
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
    const lastSegment = space.path.split('/').pop() ?? ''
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
        {/* Halo Space Card */}
        {haloSpace && (
          <div
            data-onboarding="halo-space"
            onClick={() => handleSpaceClick(haloSpace)}
            className="halo-space-card p-6 rounded-xl cursor-pointer mb-8 animate-fade-in"
          >
            <div className="flex items-center gap-3">
              <Sparkles className="w-6 h-6 text-primary" />
              <div>
                <h2 className="text-lg font-medium">{t('Enter Halo')}</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {t('Aimless time, ideas will crystallize here')}
                </p>
              </div>
            </div>
          </div>
        )}

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
                className="space-card p-4 group animate-fade-in"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <SpaceIcon iconId={space.icon} size={20} />
                    <span className="font-medium truncate">{space.name}</span>
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
                  {formatTimeAgo(space.updatedAt)}{t('active')}
                </p>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Create Space Dialog */}
      {showCreateDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card border border-border rounded-xl p-6 w-full max-w-md animate-fade-in">
            <h2 className="text-lg font-medium mb-4">{t('Create Dedicated Space')}</h2>

            {/* Icon select */}
            <div className="mb-4">
              <label className="block text-sm text-muted-foreground mb-2">{t('Icon (optional)')}</label>
              <div className="flex flex-wrap gap-2">
                {SPACE_ICONS.map((iconId) => (
                  <button
                    key={iconId}
                    onClick={() => setNewSpaceIcon(iconId)}
                    className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
                      newSpaceIcon === iconId
                        ? 'bg-primary/20 border-2 border-primary'
                        : 'bg-secondary hover:bg-secondary/80'
                    }`}
                  >
                    <SpaceIcon iconId={iconId} size={20} />
                  </button>
                ))}
              </div>
            </div>

            {/* Storage location */}
            <div className="mb-6">
              <label className="block text-sm text-muted-foreground mb-2">{t('Storage Location')}</label>
              <div className="space-y-2">
                {/* Default location */}
                <label
                  className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                    !useCustomPath
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-muted-foreground/50'
                  }`}
                >
                  <input
                    type="radio"
                    name="pathType"
                    checked={!useCustomPath}
                    onChange={() => {
                      setUseCustomPath(false)
                      setTimeout(() => {
                        spaceNameInputRef.current?.focus()
                      }, 100)
                    }}
                    className="w-4 h-4 text-primary"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm">{t('Default Location')}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {shortenPath(defaultPath)}/{newSpaceName || '...'}
                    </div>
                  </div>
                </label>

                {/* Custom location */}
                <label
                  className={`flex items-center gap-3 p-3 rounded-lg border transition-all ${
                    isWebMode
                      ? 'cursor-not-allowed opacity-60 border-border'
                      : useCustomPath
                        ? 'cursor-pointer border-primary bg-primary/5'
                        : 'cursor-pointer border-border hover:border-muted-foreground/50'
                  }`}
                >
                  <input
                    type="radio"
                    name="pathType"
                    checked={useCustomPath}
                    onChange={() => !isWebMode && setUseCustomPath(true)}
                    disabled={isWebMode}
                    className="w-4 h-4 text-primary"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm">{t('Custom Folder')}</div>
                    {isWebMode ? (
                      <div className="text-xs text-muted-foreground flex items-center gap-1">
                        <Monitor className="w-3 h-3" />
                        {t('Please select folder in desktop app')}
                      </div>
                    ) : customPath ? (
                      <div className="text-xs text-muted-foreground truncate">
                        {shortenPath(customPath)}
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground">
                        {t('Select an existing project or folder')}
                      </div>
                    )}
                  </div>
                  {!isWebMode && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault()
                        handleSelectFolder()
                      }}
                      className="px-3 py-1.5 text-xs bg-secondary hover:bg-secondary/80 rounded-md flex items-center gap-1.5 transition-colors"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                      {t('Browse')}
                    </button>
                  )}
                </label>
              </div>
            </div>

            {/* Space name - moved to bottom, above create button */}
            <div className="mb-6">
              <label className="block text-sm text-muted-foreground mb-2">{t('Name this space')}</label>
              <input
                ref={spaceNameInputRef}
                type="text"
                value={newSpaceName}
                onChange={(e) => setNewSpaceName(e.target.value)}
                placeholder={t('My Project')}
                className="w-full px-4 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
              />
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3">
              <button
                onClick={resetDialog}
                className="px-4 py-2 text-muted-foreground hover:bg-secondary rounded-lg transition-colors"
              >
                {t('Cancel')}
              </button>
              <button
                onClick={handleCreateSpace}
                disabled={!newSpaceName.trim() || (useCustomPath && !customPath)}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('Create')}
              </button>
            </div>
          </div>
        </div>
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
