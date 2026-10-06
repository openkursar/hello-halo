/**
 * NewSpaceCard
 *
 * Dashed-border "new workspace" card at the end of the grid on the
 * workspace management page — same footprint as SpaceCard, so it reads as
 * one more item in the wall rather than a separate control. Also doubles
 * as the empty state: with zero dedicated spaces, this card is the whole
 * grid.
 *
 * A folder dropped on it (desktop only) opens the create form already
 * pointed at that folder, so a project folder becomes a workspace with one
 * confirmation.
 */

import { useState, type DragEvent } from 'react'
import { Plus } from 'lucide-react'
import { api } from '../../api'
import { useNotificationStore } from '../../stores/notification.store'
import { useTranslation } from '../../i18n'

interface NewSpaceCardProps {
  onClick: () => void
  /** Accept dropped folders; omit where a local path means nothing (remote web). */
  onFolderDrop?: (path: string) => void
}

/** What was dropped: a local folder (with its path), something else, or nothing usable. */
export type FolderDrop = { path: string } | 'not-a-folder' | null

/**
 * Read a drop. Only a local folder can become a workspace; the first item
 * decides, and a folder whose path cannot be resolved is nothing usable.
 */
export function readFolderDrop(
  dataTransfer: Pick<DataTransfer, 'items' | 'files'>,
  getPathForFile: (file: File) => string,
): FolderDrop {
  const entry = dataTransfer.items?.[0]?.webkitGetAsEntry?.()
  const file = dataTransfer.files?.[0]
  if (!entry || !file) return null
  if (!entry.isDirectory) return 'not-a-folder'
  const path = getPathForFile(file)
  return path ? { path } : null
}

export function NewSpaceCard({ onClick, onFolderDrop }: NewSpaceCardProps) {
  const { t } = useTranslation()
  const [dragOver, setDragOver] = useState(false)

  const dropHandlers = onFolderDrop ? {
    onDragOver: (e: DragEvent<HTMLButtonElement>) => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setDragOver(true)
    },
    onDragLeave: (e: DragEvent<HTMLButtonElement>) => {
      // Moving onto the card's own icon or label is not leaving it.
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
    },
    onDrop: (e: DragEvent<HTMLButtonElement>) => {
      e.preventDefault()
      setDragOver(false)
      const drop = readFolderDrop(e.dataTransfer, api.getPathForFile)
      if (drop === 'not-a-folder') {
        useNotificationStore.getState().show({
          id: 'new-space-drop',
          variant: 'warning',
          title: t('Only a folder can become a workspace'),
          duration: 4000,
        })
      } else if (drop) {
        onFolderDrop(drop.path)
      }
    },
  } : {}

  return (
    <button
      onClick={onClick}
      {...dropHandlers}
      className={`flex h-full min-h-[104px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed transition-colors ease-halo ${
        dragOver
          ? 'border-primary bg-primary/5 text-foreground'
          : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground hover:bg-secondary/40'
      }`}
    >
      <Plus className="w-5 h-5" />
      <span className="text-sm font-medium">{t('New Workspace')}</span>
      {onFolderDrop && (
        <span className="px-3 text-center text-[11px] text-muted-foreground">
          {dragOver ? t('Drop to create a workspace for this folder') : t('or drop a project folder here')}
        </span>
      )}
    </button>
  )
}
