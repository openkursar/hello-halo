/**
 * SpaceCard
 *
 * Grid card for one workspace on the management page (SpacesPage): its
 * name, folder and last activity, with edit / reveal / delete in its menu.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { FolderOpen, MoreVertical, Pencil, Trash2, Unplug } from 'lucide-react'
import type { Space } from '../../types'
import { SpaceAvatar } from './SpaceAvatar'
import { EditSpaceDialog } from './EditSpaceDialog'
import { useSpaceStore } from '../../stores/space.store'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { useNotificationStore } from '../../stores/notification.store'
import { useTranslation } from '../../i18n'
import { formatTimeAgo } from '../../utils/format-time'
import { trackHome } from '../../services/home-telemetry'

interface SpaceCardProps {
  space: Space
  /** Switch to this workspace and enter it. */
  onOpen: () => void
}

function notifyFailure(title: string) {
  useNotificationStore.getState().show({ title, variant: 'error', duration: 6000 })
}

export function SpaceCard({ space, onOpen }: SpaceCardProps) {
  const { t } = useTranslation()
  const { openSpaceFolder, deleteSpace, forgetSpace } = useSpaceStore()
  const { showConfirm, DialogComponent } = useConfirmDialog()

  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function handle(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [menuOpen])

  const handleOpenFolder = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setMenuOpen(false)
    trackHome('home.space.action', { action: 'reveal', surface: 'manage' })
    void openSpaceFolder(space.id)
  }, [space.id, openSpaceFolder])

  // Same project-vs-centralized-space detection SpaceSelector used to use.
  const handleDelete = useCallback(async () => {
    setMenuOpen(false)
    const lastSegment = space.path.split(/[/\\]/).pop() ?? ''
    const isCentralizedSpace = space.path.includes('/spaces/') && lastSegment.length === 36
    const isProjectSpace = !!space.workingDir || !isCentralizedSpace

    const confirmed = await showConfirm({
      title: t('Delete this workspace?'),
      message: isProjectSpace
        ? t('Are you sure you want to delete this workspace?\n\nOnly Halo data (conversation history) will be deleted, your project files will be kept.')
        : t('Are you sure you want to delete this workspace?\n\nAll conversations and files in the workspace will be deleted.'),
      confirmLabel: t('Delete'),
      cancelLabel: t('Cancel'),
      variant: 'danger',
    })
    if (!confirmed) return
    trackHome('home.space.action', { action: 'delete', surface: 'manage' })
    const result = await deleteSpace(space.id)
    if (result === 'busy') notifyFailure(t('This workspace is still running a reply or task. Stop it or wait for it to finish, then delete again.'))
    else if (result === 'failed') notifyFailure(t('Could not delete this workspace. Please try again.'))
  }, [space, showConfirm, t, deleteSpace])

  const handleForget = useCallback(async () => {
    setMenuOpen(false)
    const confirmed = await showConfirm({
      title: t('Remove this workspace from the list?'),
      message: t('Its files stay wherever they are — Halo just stops tracking it here. Reconnecting the drive later will not bring back its conversations under this entry.'),
      confirmLabel: t('Remove'),
      cancelLabel: t('Cancel'),
      variant: 'danger',
    })
    if (!confirmed) return
    trackHome('home.space.action', { action: 'forget', surface: 'manage' })
    if (!(await forgetSpace(space.id))) notifyFailure(t('Could not remove this workspace from the list. Please try again.'))
  }, [space.id, showConfirm, t, forgetSpace])

  const name = space.isTemp ? t('Halo Workspace') : space.name
  const lastActiveMs = space.lastActiveAt ? new Date(space.lastActiveAt).getTime() : undefined
  const metaLine = lastActiveMs ? formatTimeAgo(lastActiveMs, t) : ''

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen() }}
      className={`group relative flex h-full flex-col text-left bg-card border rounded-lg p-4 transition-all cursor-pointer
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary
        ${space.isMissing
          ? 'border-dashed opacity-60 hover:opacity-100'
          : 'border-border-soft hover:border-border hover:shadow-sm'}`}
    >
      <div className="flex items-start gap-2.5">
        <SpaceAvatar space={space} size={40} className={space.isMissing ? 'opacity-60' : ''} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <h3 className="text-sm font-semibold text-foreground truncate leading-tight">{name}</h3>
          </div>
          <p className="text-xs font-mono text-muted-foreground truncate mt-0.5" title={space.workingDir || space.path}>
            {space.workingDir || space.path}
          </p>
        </div>

        {space.isMissing && (
          <Unplug className="w-4 h-4 flex-shrink-0 text-muted-foreground" aria-label={t('Unavailable')} />
        )}

        {/* isTemp can only be shown in its folder: Halo owns it, so there is
            nothing to rename or delete. isMissing can only be removed. */}
        <div ref={menuRef} className="relative -mt-1 flex-shrink-0 opacity-0 group-hover:opacity-100 max-sm:opacity-100 transition-opacity">
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v) }}
            title={t('More')}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
          >
            <MoreVertical className="w-3.5 h-3.5" />
          </button>
          {menuOpen && (
            <div onClick={e => e.stopPropagation()} className="absolute right-0 top-full mt-1 z-20 min-w-[180px] bg-popover border border-border rounded-lg shadow-lg py-1 text-sm">
              {space.isTemp ? (
                <button onClick={handleOpenFolder} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/60 transition-colors">
                  <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" /> {t('Show in Folder')}
                </button>
              ) : space.isMissing ? (
                <button onClick={handleForget} className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-halo-error hover:bg-halo-error/10 transition-colors">
                  <Unplug className="w-3.5 h-3.5" /> {t('Remove from list')}
                </button>
              ) : (
                <>
                  <button onClick={() => { setMenuOpen(false); setEditing(true) }} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/60 transition-colors">
                    <Pencil className="w-3.5 h-3.5 text-muted-foreground" /> {t('Edit')}
                  </button>
                  <button onClick={handleOpenFolder} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/60 transition-colors">
                    <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" /> {t('Show in Folder')}
                  </button>
                  <div className="my-1 border-t border-border-soft" />
                  <button onClick={handleDelete} className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-halo-error hover:bg-halo-error/10 transition-colors">
                    <Trash2 className="w-3.5 h-3.5" /> {t('Delete')}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {metaLine && (
        <p className="mt-3 text-[11px] text-muted-foreground tabular-nums">{metaLine}</p>
      )}

      {/* Dialogs render as React children of this clickable card, so a click
          anywhere in them (including the confirm/cancel buttons) would
          otherwise bubble to the card's own onClick and fire onOpen right
          as the dialog closes. */}
      {editing && (
        <div onClick={(e) => e.stopPropagation()}>
          <EditSpaceDialog
            space={space}
            onClose={() => setEditing(false)}
            onSaved={() => {
              trackHome('home.space.action', { action: 'rename', surface: 'manage' })
              setEditing(false)
            }}
          />
        </div>
      )}
      {DialogComponent && (
        <div onClick={(e) => e.stopPropagation()}>{DialogComponent}</div>
      )}
    </div>
  )
}
