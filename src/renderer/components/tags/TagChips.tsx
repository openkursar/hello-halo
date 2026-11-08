/**
 * An item's tags on its card. Clicking one shows the list filtered by it.
 */

import { useTranslation } from '../../i18n'

interface TagChipsProps {
  tags: readonly string[] | undefined
  onPick?: (tag: string) => void
  /** Chips shown before collapsing the rest into "+N". */
  max?: number
}

export function TagChips({ tags, onPick, max = 2 }: TagChipsProps) {
  const { t } = useTranslation()
  if (!tags?.length) return null
  const shown = tags.slice(0, max)
  const rest = tags.length - shown.length
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {shown.map(tag => (
        <button
          key={tag}
          type="button"
          title={t('Show items tagged {{tag}}', { tag })}
          onClick={event => { event.stopPropagation(); onPick?.(tag) }}
          className="max-w-[10rem] truncate rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground hover:text-primary transition-colors"
        >
          {tag}
        </button>
      ))}
      {rest > 0 && <span className="text-[11px] text-muted-foreground" title={tags.slice(max).join(', ')}>+{rest}</span>}
    </span>
  )
}
