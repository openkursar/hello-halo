/**
 * Choosing an item's tags: tick the list's existing tags, or type a new one
 * and press Enter. Every change is handed back at once; the caller saves it.
 */

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { cleanTag, sameTag, MAX_TAG_LENGTH, MAX_TAGS_PER_APP, type TagCount } from '../../../shared/apps/app-tags'

interface TagEditorProps {
  value: readonly string[]
  /** Tags already used in this list, offered for one-click reuse. */
  suggestions: readonly TagCount[]
  onChange: (next: string[]) => void
}

/** `value` with `tag` added or removed. */
export function toggleTag(value: readonly string[], tag: string): string[] {
  return value.some(existing => sameTag(existing, tag))
    ? value.filter(existing => !sameTag(existing, tag))
    : [...value, tag]
}

export function TagEditor({ value, suggestions, onChange }: TagEditorProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const full = value.length >= MAX_TAGS_PER_APP
  const options = [
    ...value.filter(tag => !suggestions.some(s => sameTag(s.name, tag))),
    ...suggestions.map(s => s.name),
  ]
  const add = () => {
    const tag = cleanTag(draft)
    setDraft('')
    if (!tag || full || value.some(existing => sameTag(existing, tag))) return
    onChange([...value, tag])
  }
  return (
    <div className="w-full sm:w-60 p-2 space-y-2">
      <label className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-2 focus-within:border-primary">
        <Plus size={14} className="shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={draft}
          maxLength={MAX_TAG_LENGTH}
          disabled={full}
          placeholder={full ? t('At most {{count}} tags', { count: MAX_TAGS_PER_APP }) : t('Add a tag')}
          aria-label={t('Add a tag')}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add() } }}
          className="min-h-9 w-full bg-transparent text-sm focus:outline-none"
        />
      </label>
      {draft.length >= MAX_TAG_LENGTH && (
        <p role="status" className="px-1 text-[11px] text-muted-foreground">{t('A tag is at most {{count}} characters', { count: MAX_TAG_LENGTH })}</p>
      )}
      {options.length > 0 && (
        <div className="max-h-56 overflow-y-auto">
          {options.map(tag => {
            const checked = value.some(existing => sameTag(existing, tag))
            return (
              <label key={tag} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-muted/60">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && full}
                  onChange={() => onChange(toggleTag(value, tag))}
                  className="h-3.5 w-3.5 rounded border-border accent-primary"
                />
                <span className="min-w-0 truncate">{tag}</span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}
