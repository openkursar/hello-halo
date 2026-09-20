/**
 * SpaceCard
 *
 * Grid card for one workspace on the management page (SpacesPage). The
 * whole point of this card over the header dropdown's row is the asset
 * chip strip: a
 * workspace isn't just a name and a folder, it's files + digital humans +
 * skills + MCP servers, and the chips make that visible without opening it.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { FolderOpen, MoreHorizontal, Pencil, Trash2, Unplug } from 'lucide-react'
import type { Space, SpaceSummary, ArtifactRailTab } from '../../types'
import { SpaceAvatar } from './SpaceAvatar'
import { SpaceAssetChips } from './SpaceAssetChips'
import { EditSpaceDialog } from './EditSpaceDialog'
import { useSpaceStore } from '../../stores/space.store'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { useTranslation } from '../../i18n'
import { formatTimeAgo } from '../../utils/format-time'

interface SpaceCardProps {
  space: Space
  summary?: SpaceSummary
  /** Switch to this workspace and enter it. */
  onOpen: () => void
  /** Switch to this workspace, enter it, and land the resource rail on a
   * specific tab — the asset chips' click target. */
  onOpenTab: (tab: ArtifactRailTab) => void
}

export function SpaceCard({ space, summary, onOpen, onOpenTab }: SpaceCardProps) {
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
    if (confirmed) await deleteSpace(space.id)
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
    if (confirmed) await forgetSpace(space.id)
  }, [space.id, showConfirm, t, forgetSpace])

  const name = space.isTemp ? t('Halo Workspace') : space.name
  const lastActiveMs = space.lastActiveAt ? new Date(space.lastActiveAt).getTime() : undefined
  const metaLine = [
    summary && summary.conversationCount > 0 ? t('{{count}} conversations', { count: summary.conversationCount }) : null,
    lastActiveMs ? formatTimeAgo(lastActiveMs, t) : null,
  ].filter(Boolean).join(' · ')
  // isTemp never manages (no rename/delete/folder — it isn't a real project
  // directory); isMissing manages only "remove from list" — no reindex.
  const canManage = !space.isTemp

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen() }}
      className={`group relative flex flex-col text-left bg-card border rounded-lg p-4 transition-all cursor-pointer
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary
        ${space.isMissing
          ? 'border-dashed opacity-60 hover:opacity-100'
          : 'border-border/60 hover:border-border hover:shadow-sm'}`}
    >
      <div className="flex items-start gap-2.5">
        <SpaceAvatar space={space} size={40} className={space.isMissing ? 'opacity-60' : ''} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <h3 className="text-sm font-semibold text-foreground truncate leading-tight">{name}</h3>
          </div>
          {!space.isTemp && (
            <p className="text-xs font-mono text-muted-foreground truncate mt-0.5" title={space.workingDir || space.path}>
              {space.workingDir || space.path}
            </p>
          )}
        </div>

        {space.isMissing && (
          <Unplug className="w-4 h-4 flex-shrink-0 text-muted-foreground" aria-label={t('Unavailable')} />
        )}

        {canManage && (
          <div ref={menuRef} className="relative flex-shrink-0 opacity-0 group-hover:opacity-100 max-sm:opacity-100 transition-opacity">
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v) }}
              title={t('More')}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
            {menuOpen && (
              <div onClick={e => e.stopPropagation()} className="absolute right-0 top-full mt-1 z-20 min-w-[180px] bg-popover border border-border rounded-lg shadow-lg py-1 text-sm">
                {space.isMissing ? (
                  <button onClick={handleForget} className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-halo-error hover:bg-halo-error/10 transition-colors">
                    <Unplug className="w-3.5 h-3.5" /> {t('Remove from list')}
                  </button>
                ) : (
                  <>
                    <button onClick={() => { setMenuOpen(false); setEditing(true) }} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/60 transition-colors">
                      <Pencil className="w-3.5 h-3.5 text-muted-foreground" /> {t('Rename')}
                    </button>
                    <button onClick={handleOpenFolder} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/60 transition-colors">
                      <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" /> {t('Show in Folder')}
                    </button>
                    <div className="my-1 border-t border-border/60" />
                    <button onClick={handleDelete} className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-halo-error hover:bg-halo-error/10 transition-colors">
                      <Trash2 className="w-3.5 h-3.5" /> {t('Delete')}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mt-3">
        <SpaceAssetChips summary={summary} onSelectTab={onOpenTab} />
      </div>

      {metaLine && (
        <p className="mt-2 text-[11px] text-muted-foreground tabular-nums">{metaLine}</p>
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
            onSaved={() => setEditing(false)}
          />
        </div>
      )}
      {DialogComponent && (
        <div onClick={(e) => e.stopPropagation()}>{DialogComponent}</div>
      )}
    </div>
  )
}
