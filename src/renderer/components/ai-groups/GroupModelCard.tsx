/**
 * The model dropdown's first step for a conversation on a group: the group keeps
 * its name while the card names the model in use.
 */

import type { ReactNode } from 'react'
import { ChevronRight, Settings2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { AIGroup, AISource } from '../../types'
import { combineCapabilityFacts, describeMemberFacts } from '../../../shared/ai-groups'
import type { GroupRouteInfo } from '../../../shared/types/ai-groups-runtime'
import { AutoTag } from './group-parts'
import { GroupRouteStatus } from './GroupRouteStatus'
import { formatTokenCount } from './group-text'

interface GroupModelCardProps {
  group: AIGroup
  sources: readonly AISource[]
  /** What the router last reported for this conversation; null before it has served it. */
  route: GroupRouteInfo | null
  /** A reply is being waited for. */
  live: boolean
  onSwitch: () => void
  onEdit: () => void
  /** What the card shares with every model: how hard to think, the engine. */
  children?: ReactNode
}

export function GroupModelCard({ group, sources, route, live, onSwitch, onEdit, children }: GroupModelCardProps) {
  const { t } = useTranslation()
  const envelope = combineCapabilityFacts(group.members.map(member => {
    const source = sources.find(item => item.id === member.sourceId)
    return source ? describeMemberFacts(source, member.modelId) : {}
  }))
  // One model's facts are shown as for any account; with several, what is not known is said so.
  const mixed = group.members.length > 1

  return (
    <div className="p-3">
      <button
        type="button"
        onClick={onSwitch}
        title={t('Switch model')}
        className="group flex w-full items-center gap-2 rounded-lg bg-secondary/60 px-3 py-2 text-left hover:bg-secondary transition-colors ease-halo"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[15px] font-semibold text-foreground">{group.name}</span>
            <AutoTag />
          </span>
          <span className="mt-0.5 truncate text-xs text-muted-foreground">
            {t('{{count}} models', { count: group.members.length })} · {group.strategy === 'spread' ? t('Spread across accounts') : t('Use in order')}
          </span>
        </span>
        <ChevronRight className="w-4 h-4 shrink-0 text-subtle-foreground group-hover:text-foreground transition-colors ease-halo" />
      </button>

      <GroupRouteStatus route={route} live={live} className="mt-3 px-1.5" />

      <dl className="mt-3 space-y-1.5 px-1.5 text-xs">
        {envelope.contextWindow ? (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{t('Context window')}</dt>
            <dd className="tabular-nums text-foreground">
              {formatTokenCount(envelope.contextWindow)}
              {mixed && envelope.contextWindowUnknown.length > 0 && <span className="ml-1 text-muted-foreground">{t('(not confirmed for every model)')}</span>}
            </dd>
          </div>
        ) : null}
        {(envelope.vision !== undefined || mixed) && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{t('Image input')}</dt>
            <dd className="text-foreground">
              {envelope.vision === undefined ? t('Not confirmed') : envelope.vision ? t('Supported') : t('Not supported')}
            </dd>
          </div>
        )}
      </dl>

      <button
        type="button"
        onClick={onEdit}
        className="mt-3 ml-1.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors ease-halo"
      >
        <Settings2 aria-hidden className="h-3 w-3" />
        {t('Edit this group')}
      </button>

      {children}
    </div>
  )
}
