import { useEffect, useMemo, useState } from 'react'
import type { TFunction } from 'i18next'
import type { RosterMember, TeamActivity, TeamConversation, TeamDetail } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { formatTimeAgo } from '../../../utils/format-time'
import { blinkDelay, orderCrew, partnersOf, pastCrew, recentTalk, rowGroups, talkExpiry, talkLinks, taskCrew, type CrewState } from './crew'
import { MemberFace } from './member-ui'
import type { MemberStateKey } from './status'

export const CREW_FACE: Record<CrewState, MemberStateKey> = { working: 'working', waiting: 'waiting_user', failed: 'error', offline: 'offline', done: 'idle', idle: 'idle' }

/** `partners` are the names of whoever this member is talking with right now. */
export function crewStateText(state: CrewState, partners: readonly string[], t: TFunction): string {
  if (state === 'waiting') return t('Waiting for a decision')
  if (state === 'failed') return t('Ran into a problem')
  if (state === 'offline') return t('Offline')
  if (state === 'done') return t('Did their part')
  if (state === 'idle') return t('On standby')
  return partners.length ? t('Talking with {{names}}', { names: partners.join(', ') }) : t('Working')
}

/** Exchanges still inside the talk window; recomputed when the oldest leaves it, not on a poll. */
export function useRecentTalk(activities: readonly TeamActivity[] | undefined): TeamActivity[] {
  const [tick, setTick] = useState(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const recent = useMemo(() => recentTalk(activities ?? [], Date.now()), [activities, tick])
  useEffect(() => {
    const expiry = talkExpiry(recent)
    if (expiry === null) return
    const timer = setTimeout(() => setTick(value => value + 1), Math.max(0, expiry - Date.now()) + 100)
    return () => clearTimeout(timer)
  }, [recent])
  return recent
}

const STATE_TONE: Record<CrewState, string> = { working: 'text-primary', waiting: 'text-halo-warning', failed: 'text-destructive', offline: 'text-subtle-foreground', done: 'text-halo-success', idle: 'text-subtle-foreground' }

const PAST_CAP = { finished: 4, live: 3 }
const POP_GROUP = 'block [&+&]:mt-2.5 [&+&]:border-t [&+&]:border-border-soft [&+&]:pt-2'
const POP_HEAD = 'mb-1.5 block text-[11.5px] font-medium text-faint-foreground'
const MORE_CHIP = 'flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1.5 text-[11px] tabular-nums'

/**
 * Who is on a task now and who took part, at the end of its row: members talking to each
 * other overlap, those who took part and are free now stack faded past a divider (in full
 * once the task is finished), each side folding into "+N"; hovering lists everyone.
 */
export function RowCrew({ detail, task, recent, cap, size }: { detail: TeamDetail; task: TeamConversation; recent: readonly TeamActivity[]; cap: number; size: number }) {
  const { t } = useTranslation()
  const crew = useMemo(() => taskCrew(detail, task), [detail, task])
  const past = useMemo(() => pastCrew(detail, task, crew), [detail, task, crew])
  const links = useMemo(() => talkLinks(recent, task.epochId, new Set(crew.filter(entry => entry.state !== 'offline').map(entry => entry.appId))), [recent, task.epochId, crew])
  if (!crew.length && !past.length) return null
  const finished = !!task.completed || task.finishedAt !== undefined
  const ordered = orderCrew(crew, links)
  const shown = ordered.slice(0, cap)
  const hidden = ordered.length - shown.length
  const pastShown = past.slice(0, finished ? PAST_CAP.finished : PAST_CAP.live)
  const pastHidden = past.length - pastShown.length
  const members = new Map(detail.roster.map(member => [member.appId, member]))
  const name = (appId: string) => nameOf(members.get(appId), t)
  const stateText = (entry: { appId: string; state: CrewState }) => crewStateText(entry.state, partnersOf(entry.appId, links).map(name), t)
  const mutual = (a: string, b: string) => recent.some(row => row.epochId === task.epochId && row.actorAppId === b && row.targetAppId === a)
  const pastHead = finished ? t('{{count}} took part', { count: past.length }) : t('{{count}} took part, free now', { count: past.length })
  return <span className="group/crew relative flex h-[30px] shrink-0 items-center gap-1.5 px-0.5">
    <span className="sr-only">{[...ordered.map(entry => `${name(entry.appId)} · ${stateText(entry)}`), ...(past.length ? [`${pastHead}: ${past.map(name).join(', ')}`] : [])].join(', ')}</span>
    {shown.length > 0 && <span aria-hidden="true" className="flex items-center gap-3">
      {rowGroups(shown, links).map(group => <span key={group[0].appId} className="flex items-center">
        {group.map((entry, index) => <MemberFace key={entry.appId} name={name(entry.appId)} state={CREW_FACE[entry.state]} size={size}
          blink={group.length > 1 && entry.state === 'working' ? blinkDelay(entry.appId) : undefined}
          className={group.length > 1 ? `rounded-full ring-2 ring-background ${index ? '-ml-[5px]' : ''}` : ''} />)}
      </span>)}
      {hidden > 0 && <span className={`${MORE_CHIP} bg-primary/10 text-primary`}>+{hidden}</span>}
    </span>}
    {shown.length > 0 && past.length > 0 && <span aria-hidden="true" className="mx-[3px] h-4 w-px shrink-0 bg-border" />}
    {past.length > 0 && <span aria-hidden="true" className="flex items-center">
      {pastShown.map((appId, index) => <MemberFace key={appId} name={name(appId)} state="idle" size={finished ? size : size - 2}
        className={`rounded-full ring-2 ring-background ${index ? '-ml-[7px]' : ''} ${finished ? '' : 'opacity-50 saturate-[.4]'}`} />)}
      {pastHidden > 0 && <span className={`${MORE_CHIP} -ml-[7px] bg-secondary text-subtle-foreground ring-2 ring-background`}>+{pastHidden}</span>}
    </span>}
    <span aria-hidden="true" className="absolute right-0 top-[calc(100%+6px)] z-10 hidden w-[260px] rounded-xl border border-border bg-background px-3 py-2.5 text-xs shadow-lg group-hover/crew:block">
      {ordered.length > 0 && <span className={POP_GROUP}>
        <span className={POP_HEAD}>{t('{{count}} on it now', { count: ordered.length })}</span>
        {ordered.map(entry => <span key={entry.appId} className="flex items-center gap-2 py-0.5">
          <MemberFace name={name(entry.appId)} state={CREW_FACE[entry.state]} size={18} />
          <span className="min-w-0 flex-1 truncate text-foreground">{name(entry.appId)}</span>
          <span className={STATE_TONE[entry.state]}>{stateText(entry)}</span>
        </span>)}
      </span>}
      {links.length > 0 && <span className={POP_GROUP}>
        <span className={POP_HEAD}>{t('Talking now')}</span>
        {links.map(link => <span key={`${link.a}:${link.b}`} className="block truncate py-0.5 text-muted-foreground">
          {name(link.a)} {mutual(link.a, link.b) ? '⇄' : '→'} {name(link.b)} <span className="text-faint-foreground">· {formatTimeAgo(link.at, t)}</span>
        </span>)}
      </span>}
      {past.length > 0 && <span className={POP_GROUP}>
        <span className={POP_HEAD}>{pastHead}</span>
        <span className="flex flex-wrap gap-x-2.5 gap-y-0.5 leading-[1.7] text-subtle-foreground">{past.map(appId => <span key={appId}>{name(appId)}</span>)}</span>
      </span>}
    </span>
  </span>
}

function nameOf(member: RosterMember | undefined, t: TFunction): string {
  return member?.memberName ?? t('Former member')
}
