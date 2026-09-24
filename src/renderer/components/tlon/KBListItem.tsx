/**
 * KBListItem — a knowledge-base card in the card wall.
 *
 * Follows the same anatomy as AutomationCard/SkillCard/McpCard (the other
 * card walls under AppsPage): avatar + name + colored status subtitle in
 * the header, a hover-revealed action row on the right, a description, and
 * a compact meta row at the bottom. Kept consistent on purpose — users
 * already learn the pattern from the other three card walls.
 */

import { useTranslation } from '../../i18n'
import { useTlonStore } from '../../stores/tlon.store'
import { useAppsStore } from '../../stores/apps.store'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { KbAvatar } from './KbAvatar'
import { MoreHorizontal, Pause, Play, Star, Check, Trash2 } from 'lucide-react'
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { KnowledgeBaseEntry } from '../../../shared/types/tlon'

interface KBListItemProps {
  kb: KnowledgeBaseEntry
  onOpen: () => void
}

/** Relative time string like "3h ago", "just now". */
function formatTimeAgo(dateStr: string | undefined): string | null {
  if (!dateStr) return null
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  if (isNaN(then)) return null
  const diffMs = now - then
  if (diffMs < 0) return null
  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function KBListItem({ kb, onOpen }: KBListItemProps) {
  const { t } = useTranslation()
  const { showConfirm, DialogComponent } = useConfirmDialog()
  const updateKB = useTlonStore(s => s.updateKB)
  const deleteKB = useTlonStore(s => s.deleteKB)
  const setDefaultKB = useTlonStore(s => s.setDefaultKB)
  const apps = useAppsStore(s => s.apps)

  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [menuOpen])

  const isPaused = kb.status === 'paused'

  // Filter mounted digital humans: only show those still installed
  const mountedAppCount = useMemo(() => {
    if (!kb.appIds?.length) return 0
    return kb.appIds.filter(appId => apps.some(a => a.id === appId)).length
  }, [kb.appIds, apps])

  const isAllLearned = kb.stats.rawFileCount > 0 && kb.stats.indexedCount >= kb.stats.rawFileCount
  const docCount = isAllLearned
    ? t('{{count}} documents', { count: kb.stats.rawFileCount })
    : t('{{indexed}} of {{count}} learned', {
        indexed: kb.stats.indexedCount,
        count: kb.stats.rawFileCount,
      })

  const lastLearnTime = formatTimeAgo(kb.stats.lastIngestAt)
  const sizeStr = kb.stats.rawSizeBytes > 0 ? formatSize(kb.stats.rawSizeBytes) : null

  const handleDelete = useCallback(async () => {
    setMenuOpen(false)
    const ok = await showConfirm({
      title: t('Delete knowledge base'),
      message: t('Delete "{{name}}"? This permanently removes its files and notes.', { name: kb.name }),
      confirmLabel: t('Delete'),
      cancelLabel: t('Cancel'),
      variant: 'danger',
    })
    if (ok) await deleteKB(kb.id)
  }, [kb.id, kb.name, showConfirm, t, deleteKB])

  const handleTogglePause = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    updateKB(kb.id, { status: isPaused ? 'active' : 'paused' })
  }, [kb.id, isPaused, updateKB])

  const handleSetDefault = useCallback(() => {
    setMenuOpen(false)
    if (!kb.isDefault) setDefaultKB(kb.id)
  }, [kb.id, kb.isDefault, setDefaultKB])

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter') onOpen() }}
      className="group relative flex h-full flex-col text-left bg-card border border-border rounded-lg p-4 transition-colors cursor-pointer hover:border-primary
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {/* Header row */}
      <div className="flex items-start gap-2.5">
        <KbAvatar name={kb.name} id={kb.id} size={36} />
        <div className="min-w-0 flex-1">
          {/* Scope rides the title line, as on the skill/MCP/digital-human
              cards — on its own row it left three stacked lines of almost
              nothing in a header this size. */}
          <div className="flex items-center gap-1.5 min-w-0">
            <h3 className="text-sm font-semibold text-foreground truncate leading-tight">{kb.name}</h3>
            {kb.isDefault && (
              <span title={t('Default knowledge base')} className="flex-shrink-0">
                <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
              </span>
            )}
            {kb.spaceIds.length > 0 && (
              <span className="flex-shrink-0 truncate text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-secondary/70">
                {t('{{count}} workspace(s)', { count: kb.spaceIds.length })}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-1.5 min-w-0">
            <span
              className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                isPaused ? 'border border-muted-foreground/40' : 'bg-emerald-500'
              }`}
            />
            <span className={`text-xs truncate ${isPaused ? 'text-muted-foreground' : 'text-emerald-600 dark:text-emerald-400'}`}>
              {isPaused ? t('Paused') : t('Active')}
            </span>
          </div>
        </div>

        {/* Hover action row */}
        <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 max-sm:opacity-100 transition-opacity">
          <button
            onClick={handleTogglePause}
            title={isPaused ? t('Resume learning') : t('Pause learning')}
            className={`p-1.5 rounded-md transition-colors ${isPaused ? 'text-muted-foreground hover:text-foreground hover:bg-secondary' : 'text-primary hover:bg-primary/10'}`}
          >
            {isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          </button>
          <div ref={menuRef} className="relative">
            <button
              onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }}
              title={t('More')}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
            {menuOpen && (
              <div onClick={e => e.stopPropagation()} className="absolute right-0 top-full mt-1 z-20 min-w-[180px] bg-popover border border-border rounded-lg shadow-lg py-1 text-sm">
                <button onClick={handleSetDefault} className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-muted/60 transition-colors">
                  <span className="flex items-center gap-2"><Star className="w-3.5 h-3.5 text-muted-foreground" /> {t('Set as default')}</span>
                  {kb.isDefault && <Check className="w-3.5 h-3.5 text-primary" />}
                </button>
                <div className="my-1 border-t border-border/60" />
                <button onClick={handleDelete} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-red-500/10 text-red-500 transition-colors">
                  <Trash2 className="w-3.5 h-3.5" /> {t('Delete')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Description — always occupies its slot: with the meta row pinned to
          the floor, omitting it just left a hole between header and footer. */}
      <p className={`mt-2.5 text-xs line-clamp-2 ${kb.description ? 'text-muted-foreground' : 'text-muted-foreground/50'}`}>
        {kb.description || t('No description yet')}
      </p>

      {/* Meta row — pinned to the card floor so it lands on the same line
          across the row, whatever length of description sits above it. */}
      <div className="mt-auto pt-2.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="tabular-nums">{docCount}</span>
        {sizeStr && <><span>·</span><span className="tabular-nums">{sizeStr}</span></>}
        {lastLearnTime && <><span>·</span><span className="tabular-nums">{lastLearnTime}</span></>}
        {mountedAppCount > 0 && (
          <span className="ml-auto">{t('used by {{count}}', { count: mountedAppCount })}</span>
        )}
      </div>

      {DialogComponent}
    </div>
  )
}
