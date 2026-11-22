import type { TFunction } from 'i18next'
import type { RosterMember } from '../../../../shared/apps/team-types'
import { parseSpaceCoordinatorAppId } from '../../../../shared/apps/team-types'
import { failureCause, isSettingsCause, ownsModelSettings, type FailureCause, type MemberProgress, type ProgressSummary } from './progress'

export function progressMemberName(roster: readonly RosterMember[], appId: string | null | undefined, t: TFunction) {
  if (appId && parseSpaceCoordinatorAppId(appId)) return t('Main chat')
  return roster.find(member => member.appId === appId)?.memberName ?? t('Former member')
}

/** What a member needs or is doing here; empty when there is nothing to add to its name. */
export function memberProgressText(row: MemberProgress, roster: readonly RosterMember[], t: TFunction) {
  if (row.state === 'waiting') return row.question ? t('Waiting for you · {{question}}', { question: row.question }) : t('Waiting for its owner’s decision')
  if (row.state === 'failed') return row.senderAppId !== undefined ? t('Didn’t receive {{sender}}’s message', { sender: progressMemberName(roster, row.senderAppId, t) }) : failureCauseText(failureCause(row), t)
  if (row.state === 'working') return row.taskTitle ? t('Working on {{task}}', { task: row.taskTitle }) : t('Working…')
  if (row.state === 'done') return t('Done')
  return row.taskTitle ?? ''
}

export function failureCauseText(cause: FailureCause | null, t: TFunction): string {
  switch (cause) {
    case 'model': return t('Its model is no longer available')
    case 'account': return t('Its model account was rejected')
    case 'quota': return t('Its model quota or rate limit was hit')
    case 'service': return t('Its model service is temporarily unavailable')
    case 'network': return t('It couldn’t reach its model service')
    case 'timeout': return t('It didn’t finish in time')
    default: return t('Its last turn failed')
  }
}

/**
 * Who has to act on a member's failed turn: you, with a way into its model settings,
 * or its owner, named. Nothing when the trouble usually clears on its own.
 */
export function failureFix(row: MemberProgress, roster: readonly RosterMember[], t: TFunction): { text?: string; changeModel?: boolean } {
  if (row.state !== 'failed' || row.senderAppId !== undefined) return {}
  const cause = failureCause(row)
  const settings = isSettingsCause(cause)
  if (!settings && cause !== null) return {}
  const member = roster.find(entry => entry.appId === row.appId)
  if (!member || parseSpaceCoordinatorAppId(row.appId)) return {}
  if (ownsModelSettings(member)) return settings ? { text: t('Needs you'), changeModel: true } : {}
  if (member.owner) return { text: settings ? t('{{owner}} needs to change its model settings', { owner: member.owner }) : t('{{owner}} needs to look into it', { owner: member.owner }) }
  return { text: settings ? t('Its owner needs to change its model settings') : t('Its owner needs to look into it') }
}

export function progressSummaryText(summary: ProgressSummary, outputCount: number, t: TFunction) {
  switch (summary.kind) {
    case 'waiting': return t('{{count}} waiting for you', { count: summary.count })
    case 'failed': return t('{{count}} ran into a problem', { count: summary.count })
    case 'decision': return t('{{count}} waiting for a decision', { count: summary.count })
    case 'working': return t('{{count}} working', { count: summary.count })
    case 'done': return [t('Completed'), ...(outputCount ? [t('{{count}} outputs', { count: outputCount })] : [])].join(' · ')
    case 'idle': return t('Team progress')
  }
}
