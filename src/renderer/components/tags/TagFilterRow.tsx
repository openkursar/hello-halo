/**
 * The tag row above a list: "All" plus every tag the list's items carry, one
 * selectable at a time. Absent until some item carries a tag. While a tag is
 * selected, it can be renamed (merging into an existing name) or deleted from
 * every item of the list.
 */

import { useState } from 'react'
import { Check, Pencil, Trash2, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { cleanTag, sameTag, MAX_TAG_LENGTH, type TagCount } from '../../../shared/apps/app-tags'

interface TagFilterRowProps {
  tags: readonly TagCount[]
  /** The selected tag, '' for all. */
  value: string
  onChange: (tag: string) => void
  onRename: (from: string, to: string) => Promise<boolean>
  onDelete: (tag: string, count: number) => Promise<boolean>
}

const chip = 'inline-flex shrink-0 items-center gap-1 rounded-full border px-3 min-h-8 text-xs transition-colors'

export function TagFilterRow({ tags, value, onChange, onRename, onDelete }: TagFilterRowProps) {
  const { t } = useTranslation()
  const [renaming, setRenaming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (tags.length === 0 && !value) return null

  const selected = tags.find(tag => sameTag(tag.name, value))
  const commitRename = async () => {
    const to = cleanTag(renaming ?? '')
    if (!selected || !to || to === selected.name) { setRenaming(null); return }
    setBusy(true)
    const ok = await onRename(selected.name, to)
    setBusy(false)
    if (ok) { setRenaming(null); onChange(to) }
  }

  return (
    <div className="mb-4 flex items-center gap-2 overflow-x-auto pb-1 -mx-1 px-1" role="toolbar" aria-label={t('Tags')}>
      <button
        type="button"
        aria-pressed={!value}
        onClick={() => onChange('')}
        className={`${chip} ${!value ? 'border-primary bg-primary/10 text-primary' : 'border-border-soft text-muted-foreground hover:border-border hover:text-foreground'}`}
      >
        {t('All')}
      </button>
      {tags.map(tag => {
        const active = sameTag(tag.name, value)
        return (
          <button
            key={tag.name}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(active ? '' : tag.name)}
            className={`${chip} ${active ? 'border-primary bg-primary/10 text-primary' : 'border-border-soft text-muted-foreground hover:border-border hover:text-foreground'}`}
          >
            <span className="max-w-[12rem] truncate">{tag.name}</span>
            <span className="opacity-70">{tag.count}</span>
          </button>
        )
      })}
      {selected && (renaming !== null ? (
        <span className="flex shrink-0 items-center gap-1">
          <input
            autoFocus
            value={renaming}
            maxLength={MAX_TAG_LENGTH}
            aria-label={t('New tag name')}
            title={t('A tag is at most {{count}} characters', { count: MAX_TAG_LENGTH })}
            onChange={event => setRenaming(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') void commitRename()
              if (event.key === 'Escape') setRenaming(null)
            }}
            className="min-h-8 w-32 rounded-lg border border-border bg-card px-2 text-xs focus:outline-none focus:border-primary"
          />
          <button type="button" disabled={busy} onClick={() => void commitRename()} aria-label={t('Save')} className="rounded-lg p-2 text-primary hover:bg-secondary disabled:opacity-50"><Check size={14} /></button>
          <button type="button" onClick={() => setRenaming(null)} aria-label={t('Cancel')} className="rounded-lg p-2 text-muted-foreground hover:bg-secondary"><X size={14} /></button>
        </span>
      ) : (
        <span className="ml-auto flex shrink-0 items-center gap-1 pl-2">
          <button type="button" onClick={() => setRenaming(selected.name)} className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground">
            <Pencil size={12} />{t('Rename')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              const ok = await onDelete(selected.name, selected.count)
              setBusy(false)
              if (ok) onChange('')
            }}
            className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-halo-error disabled:opacity-50"
          >
            <Trash2 size={12} />{t('Delete tag')}
          </button>
        </span>
      ))}
    </div>
  )
}
