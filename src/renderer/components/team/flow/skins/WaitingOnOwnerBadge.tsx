/**
 * WaitingOnOwnerBadge — "a decision is waiting on the teammate who owns this
 * member", as both office skins state it.
 *
 * It is a fact, never a call to action: only that person's Halo holds the
 * question. So it stays in the resting palette that amber (yours to answer) is
 * deliberately kept out of, and earns its visibility from the pill and the icon
 * instead — a member blocked on a person must not read as an idle one.
 */

import { Hourglass } from 'lucide-react'
import { useTranslation } from '../../../../i18n'

interface WaitingOnOwnerBadgeProps {
  ownerName: string | null
  className?: string
}

export function WaitingOnOwnerBadge({ ownerName, className = '' }: WaitingOnOwnerBadgeProps) {
  const { t } = useTranslation()
  // Kept out of the sentence's own t(): the extractor skips a t() call passed as
  // an argument to another one, which would ship this fallback untranslated.
  const owner = ownerName?.trim() || t('its owner')
  const label = t('Waiting on {{owner}}', { owner })

  return (
    <span
      className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border bg-secondary/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground ${className}`}
      title={label}
    >
      <Hourglass className="h-2.5 w-2.5 flex-shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  )
}
