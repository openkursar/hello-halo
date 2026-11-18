import type { TFunction } from 'i18next'
import type { RosterMember, TeamDetail } from '../../../../shared/apps/team-types'
import { AutomationAvatar } from '../../apps/AutomationAvatar'
import type { MemberStateKey } from './status'

const DOT_TONE: Partial<Record<MemberStateKey, string>> = { error: 'failed', waiting_user: 'waiting', working: 'working' }

export const MEMBER_FACT_TONE: Record<MemberStateKey, string> = {
  error: 'text-destructive',
  waiting_user: 'text-halo-warning',
  working: 'text-subtle-foreground',
  idle: 'text-faint-foreground',
  offline: 'text-faint-foreground',
}

/** `blink` is a talking member's blink delay, so each keeps its own beat. */
export function MemberFace({ name, state, size, blink, className = '' }: { name: string; state: MemberStateKey; size: number; blink?: string; className?: string }) {
  const tone = DOT_TONE[state]
  return <span style={blink ? { ['--blink-delay' as string]: blink } : undefined}
    className={`relative flex shrink-0 ${state === 'offline' ? 'opacity-50 grayscale-[.5]' : ''} ${blink ? 'avatar-blink' : ''} ${className}`}>
    <AutomationAvatar name={name} size={size} />
    {tone && <i aria-hidden="true" data-tone={tone} className="avatar-status-dot" />}
  </span>
}

/** Whose digital human this is, when it is not yours. */
export function memberOwner(member: RosterMember, t: TFunction): string | null {
  return member.sameMachine === false && member.owner ? t('{{owner}}’s digital human', { owner: member.owner }) : null
}

/** The one thing worth knowing about a member right now. */
export function memberFact(detail: TeamDetail, member: RosterMember, state: MemberStateKey, t: TFunction): string {
  if (state === 'offline') return t('Offline')
  if (state === 'error') return member.currentTaskTitle ? t('Ran into a problem in {{task}}', { task: member.currentTaskTitle }) : t('Ran into a problem')
  if (state === 'waiting_user') {
    const question = (detail.pendingEscalations ?? []).find(item => item.appId === member.appId)?.question
    return question ? t('Asks: {{question}}', { question }) : t('Waiting for your decision')
  }
  if (state === 'working') {
    const label = member.busy?.[0]?.label || member.currentTaskTitle
    return label ? t('Working on {{task}}', { task: label }) : t('Working')
  }
  return t('On standby')
}
