/**
 * DefaultMemberCard — the plain status-card skin (unchanged from the original
 * MemberNode look): status dot, ★ lead, working pulse, owner/presence, and a
 * one-line role / current-task summary.
 */

import { Star, Loader2, AlertTriangle, Timer } from 'lucide-react'
import type { TeamMemberRuntimeStatus } from '../../../../../shared/apps/team-types'
import { MemberPresenceChip, OwnerLabel } from '../../MemberPresenceChip'
import { WaitingOnOwnerBadge } from './WaitingOnOwnerBadge'
import { useTranslation } from '../../../../i18n'
import type { MemberView } from '../member-view'

function statusDotClass(status: TeamMemberRuntimeStatus): string {
  switch (status) {
    case 'working': return 'bg-emerald-500'
    case 'error': return 'bg-red-500'
    case 'waiting_user': return 'bg-amber-500'
    default: return 'bg-muted-foreground/40'
  }
}

export function DefaultMemberCard({ view, selected, active }: { view: MemberView; selected: boolean; active: boolean }) {
  const { t } = useTranslation()
  const { member, presence, isLead, isUnreachable, isWorking, isAlert, waitsOnOwner, summary, checkCount } = view

  return (
    <div
      className={`group relative flex w-full flex-col gap-1.5 rounded-xl border bg-background px-3 py-2.5 shadow-sm transition-all
        ${isUnreachable ? 'border-dashed opacity-55 saturate-0' : ''}
        ${selected ? 'border-primary ring-2 ring-primary/30'
          : active ? 'border-primary ring-1 ring-primary/40'
          : isAlert ? 'border-amber-500/50'
          : isWorking ? 'border-emerald-500/40'
          : isLead ? 'border-primary/40 shadow-md'
          : 'border-border'}`}
    >
      <div className="flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
          {isWorking && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />}
          <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${statusDotClass(member.status)}`} />
        </span>
        <span className="flex min-w-0 items-center gap-1 text-sm font-medium text-foreground">
          {isLead && <Star className="h-3.5 w-3.5 flex-shrink-0 fill-current text-amber-500" />}
          <span className="truncate">{member.memberName}</span>
        </span>
        <span className="ml-auto flex flex-shrink-0 items-center gap-1">
          {checkCount > 0 && (
            <span
              className="flex items-center gap-0.5 rounded-full bg-secondary px-1.5 text-[10px] text-muted-foreground"
              title={t('Someone has it check in on a schedule')}
            >
              <Timer className="h-3 w-3" />
              {checkCount}
            </span>
          )}
          {isAlert && <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
          {isWorking && !isAlert && <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-500" />}
        </span>
      </div>

      {presence.isRemote && (
        <div className="flex min-w-0 items-center gap-1.5">
          <OwnerLabel ownerName={presence.ownerName} />
          <MemberPresenceChip
            reachability={presence.reachability}
            ownerName={presence.ownerName}
            showLabel={isUnreachable}
          />
        </div>
      )}

      {/* Replaces the role/summary slot: same information, one notch louder than
          the muted grey text it displaces. */}
      {waitsOnOwner ? (
        <WaitingOnOwnerBadge ownerName={presence.ownerName} className="self-start" />
      ) : (
        <span className="truncate text-xs text-muted-foreground">
          {summary || (isLead ? t('Team Lead') : '\u00A0')}
        </span>
      )}
    </div>
  )
}
