/**
 * MemberPresenceChip — status dot + label (Online / Away / Offline) for a team member.
 *
 * Wording is deliberately people-centric and location-free: never exposes node
 * ids, "remote", "host", or any transport concept — only whether a teammate is
 * reachable right now.
 */

import type { MemberReachability } from '../../stores/team.store'
import { useTranslation } from '../../i18n'

interface MemberPresenceChipProps {
  reachability: MemberReachability
  showLabel?: boolean
  /** When present, away/offline get a human tooltip ("Alice stepped away") instead of a bare state word. */
  ownerName?: string | null
  className?: string
}

function dotClass(reachability: MemberReachability): string {
  switch (reachability) {
    case 'online': return 'bg-emerald-500'
    case 'away': return 'bg-amber-500'
    case 'offline':
    default: return 'bg-muted-foreground/40'
  }
}

export function MemberPresenceChip({ reachability, showLabel = true, ownerName = null, className = '' }: MemberPresenceChipProps) {
  const { t } = useTranslation()

  const label: Record<MemberReachability, string> = {
    online: t('Online'),
    away: t('Away'),
    offline: t('Offline'),
  }

  const owner = ownerName?.trim()
  const tooltip = ((): string | undefined => {
    if (!owner) return undefined
    switch (reachability) {
      case 'away': return t('{{owner}} stepped away for a moment', { owner })
      case 'offline': return t('{{owner}}\u2019s computer is offline right now', { owner })
      default: return t('{{owner}} is around', { owner })
    }
  })()

  return (
    <span className={`inline-flex shrink-0 items-center gap-1 ${className}`} title={tooltip}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(reachability)}`} aria-hidden="true" />
      {showLabel && (
        <span className={`text-xs ${reachability === 'offline' ? 'text-muted-foreground' : 'text-foreground/70'}`}>
          {label[reachability]}
        </span>
      )}
      {!showLabel && <span className="sr-only">{label[reachability]}</span>}
    </span>
  )
}

interface OwnerLabelProps {
  ownerName: string | null
  className?: string
}

/**
 * OwnerLabel — shows the owner's real name for a member contributed by someone
 * else. Falls back to a neutral generic when the name hasn't been advertised
 * yet. Never reveals where the member runs.
 */
export function OwnerLabel({ ownerName, className = '' }: OwnerLabelProps) {
  const { t } = useTranslation()
  const name = ownerName?.trim() || t('A teammate')

  return (
    <span
      className={`inline-flex max-w-full shrink-0 items-center truncate rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ${className}`}
      title={t('Brought in by {{owner}}', { owner: name })}
    >
      {t('{{owner}}\u2019s', { owner: name })}
    </span>
  )
}
