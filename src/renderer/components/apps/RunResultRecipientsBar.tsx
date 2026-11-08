/**
 * RunResultRecipientsBar
 *
 * Selected count plus "Select all" / "Clear" for the contacts a list is
 * showing right now (its search applied), so a run result can reach many
 * chats without ticking each one. Shared by both IM contact lists.
 */

import { useTranslation } from '../../i18n'

/** The shown items whose state differs from `next` — what a bulk action must change. */
export function recipientsToChange<T>(shown: readonly T[], isOn: (item: T) => boolean, next: boolean): T[] {
  return shown.filter(item => isOn(item) !== next)
}

interface RunResultRecipientsBarProps<T> {
  shown: readonly T[]
  isOn: (item: T) => boolean
  onSet: (item: T, next: boolean) => void | Promise<void>
}

export function RunResultRecipientsBar<T>({ shown, isOn, onSet }: RunResultRecipientsBarProps<T>) {
  const { t } = useTranslation()
  if (shown.length < 2) return null

  const selected = shown.filter(isOn).length
  const apply = (next: boolean) => {
    for (const item of recipientsToChange(shown, isOn, next)) void onSet(item, next)
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span className="text-muted-foreground">
        {t('{{count}} of {{total}} get scheduled run results', { count: selected, total: shown.length })}
      </span>
      <span className="flex items-center gap-3 ml-auto">
        <button
          type="button"
          onClick={() => apply(true)}
          disabled={selected === shown.length}
          className="text-primary hover:text-primary/80 disabled:text-muted-foreground/50 disabled:cursor-default transition-colors"
        >
          {t('Select all')}
        </button>
        <button
          type="button"
          onClick={() => apply(false)}
          disabled={selected === 0}
          className="text-primary hover:text-primary/80 disabled:text-muted-foreground/50 disabled:cursor-default transition-colors"
        >
          {t('Clear')}
        </button>
      </span>
    </div>
  )
}
