/**
 * Where a conversation's group is sending it. A live region, so a change is
 * announced without anything entering the chat.
 */

import { Loader2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { GroupRouteInfo } from '../../../shared/types/ai-groups-runtime'
import { MemberName } from './group-parts'
import { describeRoute } from './group-text'

export function GroupRouteStatus({ route, live, center = false, className = '' }: {
  route: GroupRouteInfo | null
  /** A reply is being waited for, so a switch in progress is still true. */
  live: boolean
  center?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const view = describeRoute(route, t, live)
  return (
    <div role="status" aria-live="polite" className={`${center ? 'flex flex-col items-center text-center' : ''} ${className}`}>
      <p className={`flex items-center gap-1.5 text-xs ${view.kind === 'exhausted' ? 'text-halo-warning' : 'text-muted-foreground'}`}>
        {view.kind === 'switching' && <Loader2 aria-hidden className="h-3 w-3 shrink-0 animate-spin" />}
        {view.caption}
      </p>
      {(view.kind === 'serving' || view.kind === 'switching') && (
        <MemberName account={view.member.account} model={view.member.model} className={`mt-1 ${center ? 'items-center' : ''}`} />
      )}
    </div>
  )
}
