/**
 * MemberCard
 *
 * A single workstation card on the status board: a square-ish surface with a
 * status dot (no cartoon avatar), the member's name/role, and a
 * short current-task summary. The lead renders as a more prominent "hub" card
 * (variant="lead") with a ★ marker and an active ring while the team runs.
 *
 * Clicking the card opens the member detail panel (handled by the parent).
 */

import { Star, AlertTriangle, Loader2 } from 'lucide-react'
import type { RosterMember, TeamMemberRuntimeStatus } from '../../../shared/apps/team-types'
import { useTranslation } from '../../i18n'

interface MemberCardProps {
  member: RosterMember
  active?: boolean
  variant?: 'member' | 'lead'
  onClick?: () => void
}

/** Semantic dot color per runtime status (functional palette is allowed). */
function statusDotClass(status: TeamMemberRuntimeStatus): string {
  switch (status) {
    case 'working':
      return 'bg-emerald-500'
    case 'error':
      return 'bg-red-500'
    case 'waiting_user':
      return 'bg-amber-500'
    case 'idle':
    default:
      return 'bg-muted-foreground/40'
  }
}

export function MemberCard({ member, active, variant = 'member', onClick }: MemberCardProps) {
  const { t } = useTranslation()

  const statusLabel: Record<TeamMemberRuntimeStatus, string> = {
    working: t('Working'),
    idle: t('Idle'),
    error: t('Error'),
    waiting_user: t('Waiting for your decision'),
  }

  const summary =
    member.status === 'working'
      ? member.currentTaskTitle || t('Working…')
      : member.status === 'waiting_user'
        ? t('Waiting for your decision')
        : member.status === 'error'
          ? member.currentTaskTitle || t('Hit an error')
          : member.currentTaskTitle || t('Idle')

  const isAlert = member.status === 'error' || member.status === 'waiting_user'
  const isWorking = member.status === 'working'
  const isLead = variant === 'lead' || member.isLead

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative flex w-full flex-col gap-2 rounded-xl border p-3 text-left shadow-sm transition-all
        ${isLead ? 'sm:w-56' : 'sm:w-44'}
        ${active
          ? 'border-primary ring-1 ring-primary/40 bg-secondary'
          : isAlert
            ? 'border-amber-500/50 bg-background hover:bg-secondary/40'
            : isWorking
              ? 'border-emerald-500/40 bg-background hover:bg-secondary/40'
              : 'border-border bg-background hover:bg-secondary/50'}
        ${isLead ? 'shadow-md' : ''}`}
    >
      {/* Working ring accent (subtle, theme-aware) */}
      {isWorking && (
        <span className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-emerald-500/20" aria-hidden="true" />
      )}

      <div className="flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
          {isWorking && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
          )}
          <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${statusDotClass(member.status)}`} />
        </span>
        <span className="flex min-w-0 items-center gap-1 font-medium text-foreground">
          {isLead && <Star className="h-3.5 w-3.5 flex-shrink-0 fill-current text-amber-500" />}
          <span className="truncate">{member.memberName}</span>
        </span>
        {isAlert && <AlertTriangle className="ml-auto h-3.5 w-3.5 flex-shrink-0 text-amber-500" />}
        {isWorking && !isAlert && <Loader2 className="ml-auto h-3.5 w-3.5 flex-shrink-0 animate-spin text-emerald-500" />}
      </div>

      {member.role && (
        <span className="truncate text-xs text-muted-foreground">{member.role}</span>
      )}

      <span
        className={`truncate text-xs ${member.status === 'idle' ? 'text-muted-foreground/70' : 'text-foreground/80'}`}
        title={summary}
      >
        {summary}
      </span>

      {isLead && (
        <span className="mt-0.5 inline-flex w-fit items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
          {t('Lead')}
        </span>
      )}

      <span className="sr-only">{statusLabel[member.status]}</span>
    </button>
  )
}
