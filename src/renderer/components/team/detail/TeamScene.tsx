import { useEffect, useMemo, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import type { RosterMember, TeamDetail } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { formatTimeAgo } from '../../../utils/format-time'
import { AutomationAvatar } from '../../apps/AutomationAvatar'
import { progressMemberName } from '../workbench/progress-labels'
import type { TaskProgress } from '../workbench/progress'
import { taskTime } from '../workbench/time'
import type { TaskActivityData } from '../workbench/useTaskActivity'
import { blinkDelay, capStage, crewState, isExchange, needsAttention, orderCrew, partnersOf, talkLinks, type CrewEntry, type CrewState } from './crew'
import { crewStateText, useRecentTalk } from './crew-ui'
import { LABEL_LINE, layoutScene, MORE_RADIUS, SCENE_RADIUS } from './scene-layout'
import { MemberConversationsLink } from './task-ui'

const STAGE_CAP = 6
const PILE_CAP = 12
const PILE_NAMED = 6
const WIDE = 480
const PILE_WIDTH = 168
const STAGE_HEIGHT = { wide: 168, narrow: 160 }
const NARROW_PILE_HEIGHT = 96
const BODY_PAD = 20
const BODY_GAP = 8
const TICKER = 2

const DOT: Partial<Record<CrewState, string>> = { working: 'working', waiting: 'waiting', failed: 'failed', done: 'done' }
const STATE_TONE: Partial<Record<CrewState, string>> = { waiting: 'text-halo-warning', failed: 'text-destructive' }

/**
 * Who is on the task right now and who is free, at a fixed height so members
 * coming and going move faces around instead of resizing the card.
 */
export function TeamScene({ detail, epochId, progress, data, onOpenMember, onOpenAll, onOpenExchange }: {
  detail: TeamDetail
  epochId: string
  progress: TaskProgress
  data: TaskActivityData
  onOpenMember: (appId: string) => void
  onOpenAll: () => void
  onOpenExchange: (activityId: string) => void
}) {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = rootRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const roster = detail.roster
  const leadAppId = detail.team.leadAppId ?? null
  const members = useMemo(() => new Map(roster.map(member => [member.appId, member])), [roster])
  const crew = useMemo<CrewEntry[]>(() => progress.members
    .filter(row => row.state === 'working' || row.state === 'waiting' || row.state === 'failed')
    .map(row => ({ appId: row.appId, state: crewState(members.get(row.appId), row.state === 'waiting', row.state === 'failed') })), [progress.members, members])
  const tookPart = useMemo(() => new Set([...progress.members.filter(row => row.state === 'done').map(row => row.appId), ...data.participants]), [progress.members, data.participants])
  // Once finished and nobody is on it, the stage keeps who did the work (lead first) instead of standing empty.
  const cast = useMemo<CrewEntry[]>(() => crew.length || !progress.finished ? crew : roster
    .filter(member => member.appId === leadAppId || tookPart.has(member.appId))
    .sort((a, b) => Number(b.appId === leadAppId) - Number(a.appId === leadAppId))
    .map(member => ({ appId: member.appId, state: 'done' })), [crew, progress.finished, roster, leadAppId, tookPart])
  const recent = useRecentTalk(data.activities)
  const links = useMemo(() => talkLinks(recent, epochId, new Set(crew.filter(entry => entry.state !== 'offline').map(entry => entry.appId))), [recent, epochId, crew])
  const ordered = useMemo(() => orderCrew(cast, links), [cast, links])
  const { shown, hidden } = useMemo(() => capStage(ordered, links, leadAppId, STAGE_CAP), [ordered, links, leadAppId])

  const wide = width >= WIDE
  const stageWidth = Math.max(0, wide ? width - BODY_PAD - BODY_GAP - PILE_WIDTH : width - BODY_PAD)
  const stageHeight = wide ? STAGE_HEIGHT.wide : STAGE_HEIGHT.narrow
  const layout = useMemo(() => stageWidth ? layoutScene(shown, hidden, links, leadAppId, stageWidth) : null, [shown, hidden, links, leadAppId, stageWidth])

  const onStage = new Set(cast.map(entry => entry.appId))
  const idle = roster.filter(member => !onStage.has(member.appId))
  const talking = new Set(links.flatMap(link => [link.a, link.b]))
  const state = new Map(cast.map(entry => [entry.appId, entry.state]))
  const nameOf = (appId: string) => progressMemberName(roster, appId, t)
  const describe = (appId: string) => `${nameOf(appId)} · ${crewStateText(state.get(appId)!, partnersOf(appId, links).map(nameOf), t)}`

  const count = (match: CrewState) => crew.filter(entry => entry.state === match).length
  const chips: { text: string; tone?: string; dot?: string }[] = []
  if (crew.length) {
    if (count('working')) chips.push({ text: t('{{count}} working', { count: count('working') }), dot: 'bg-primary' })
    if (count('waiting')) chips.push({ text: t('{{count}} waiting for you', { count: count('waiting') }), tone: 'text-halo-warning', dot: 'bg-halo-warning' })
    if (count('failed')) chips.push({ text: t('{{count}} ran into a problem', { count: count('failed') }), tone: 'text-destructive', dot: 'bg-destructive' })
    if (talking.size) chips.push({ text: t('{{count}} talking', { count: talking.size }), dot: 'border-[1.5px] border-primary bg-transparent' })
    chips.push({ text: t('{{count}} on standby', { count: idle.length }), dot: 'bg-faint-foreground' })
  } else {
    chips.push({ text: t('No one is working on it right now · {{count}} took part', { count: cast.length || roster.filter(member => tookPart.has(member.appId)).length }) })
  }

  const exchanges = useMemo(() => data.activities.filter(isExchange), [data.activities])
  const ticker = crew.length ? exchanges
    .map(activity => ({ activity, at: taskTime(activity.createdAt) ?? 0 }))
    .sort((a, b) => b.at - a.at)
    .slice(0, TICKER) : []

  const scale = layout && layout.height > stageHeight ? stageHeight / layout.height : 1
  const offset = layout ? (stageHeight - layout.height * scale) / 2 : 0
  const r = SCENE_RADIUS

  return <section ref={rootRef} data-team-scene aria-label={t('Team scene')} className="mt-5 rounded-2xl">
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-3.5 pt-2.5">
      <h3 className="text-[12.5px] font-semibold">{t('Team scene')}</h3>
      {chips.map(chip => <span key={chip.text} className={`inline-flex items-center gap-1.5 text-xs ${chip.tone ?? 'text-subtle-foreground'}`}>
        {chip.dot && <i aria-hidden="true" className={`size-[7px] rounded-full ${chip.dot}`} />}{chip.text}
      </span>)}
    </div>
    {width > 0 && <div className={`flex gap-2 px-2.5 pb-1.5 pt-1 ${wide ? '' : 'flex-col'}`}>
      <div className="relative min-w-0 flex-1 overflow-hidden" style={{ height: stageHeight }}>
        {!cast.length && <p className="px-1 pt-4 text-[12.5px] text-subtle-foreground">{progress.finished ? t('This task is finished; everyone is free again.') : t('Nothing is running right now.')}</p>}
        {layout && cast.length > 0 && <div className="team-scene-move absolute left-0 top-0" style={{ width: layout.width, height: layout.height, transform: `translateY(${offset}px) scale(${scale})`, transformOrigin: 'top center' }}>
          {layout.faces.map(face => {
            const faceState = state.get(face.appId)!
            const blink = face.talking && faceState === 'working'
            return <button key={face.appId} type="button" onClick={() => onOpenMember(face.appId)} aria-label={describe(face.appId)} title={describe(face.appId)}
              style={{ transform: `translate(${face.x - r}px, ${face.y - r}px)`, ...(blink ? { ['--blink-delay' as string]: blinkDelay(face.appId) } : {}) }}
              className={`team-scene-move team-scene-in absolute left-0 top-0 flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${face.talking ? 'ring-2 ring-[color:var(--scene-bg)]' : ''} ${blink ? 'avatar-blink' : ''} ${faceState === 'offline' ? 'opacity-50 grayscale-[.5]' : ''}`}>
              <AutomationAvatar name={nameOf(face.appId)} size={r * 2} />
              {/* Layered with its own face: a face in front may cover it, but it never lands on another face. */}
              {DOT[faceState] && <i aria-hidden="true" data-tone={DOT[faceState]} className="avatar-status-dot" />}
            </button>
          })}
          {layout.labels.map(label => <div key={label.key} aria-hidden="true" style={{ transform: `translate(${label.x - label.width / 2}px, ${label.y}px)`, width: label.width }}
            className="team-scene-move team-scene-in pointer-events-none absolute left-0 top-0 text-center text-[11.5px] text-subtle-foreground">
            {label.single ? <SingleLabel appId={label.appIds[0]} state={state.get(label.appIds[0])!} lead={label.appIds[0] === leadAppId} name={nameOf(label.appIds[0])} lines={label.lines} t={t} />
              : <p className="overflow-hidden break-words" style={{ lineHeight: `${LABEL_LINE}px`, maxHeight: label.lines * LABEL_LINE }}>
                {label.appIds.map((appId, index) => <span key={appId}>
                  {index > 0 && <span className="text-faint-foreground"> · </span>}
                  <span className={appId === leadAppId ? 'font-semibold text-foreground' : ''}>{nameOf(appId)}</span>
                </span>)}
              </p>}
          </div>)}
          {layout.more && <span title={t('{{count}} more on this task', { count: layout.more.count })} style={{ transform: `translate(${layout.more.x - MORE_RADIUS}px, ${layout.more.y - MORE_RADIUS}px)`, width: MORE_RADIUS * 2, height: MORE_RADIUS * 2 }}
            className="team-scene-move absolute left-0 top-0 flex items-center justify-center rounded-full border border-dashed border-border text-[11.5px] tabular-nums text-subtle-foreground">+{layout.more.count}</span>}
        </div>}
      </div>
      <IdlePile members={idle} tookPart={tookPart} wide={wide} nameOf={nameOf} onOpenMember={onOpenMember} t={t} />
    </div>}
    <div className="grid gap-[3px] px-3.5 pb-1.5 pt-1.5">
      {ticker.map(({ activity, at }) => <button key={activity.id} type="button" onClick={() => onOpenExchange(activity.id)} className="block w-full truncate rounded text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        {at > 0 && <span className="mr-1.5 tabular-nums text-faint-foreground">{formatTimeAgo(at, t)}</span>}
        <span className="text-foreground">{nameOf(activity.actorAppId)}</span> → <span className="text-foreground">{nameOf(activity.targetAppId!)}</span>
        {activity.subject.trim() && <>: {activity.subject.trim()}</>}
      </button>)}
      <MemberConversationsLink count={exchanges.length} onOpen={onOpenAll} className="justify-self-start" />
    </div>
  </section>
}

function SingleLabel({ appId, state, lead, name, lines, t }: { appId: string; state: CrewState; lead: boolean; name: string; lines: number; t: TFunction }) {
  return <>
    <p key={appId} className={`truncate ${lead ? 'font-semibold text-foreground' : ''}`} style={{ lineHeight: `${LABEL_LINE}px` }}>{name}</p>
    {lines > 1 && <p className={`truncate text-[10.5px] ${STATE_TONE[state] ?? 'text-faint-foreground'}`} style={{ lineHeight: `${LABEL_LINE}px` }}>{crewStateText(state, [], t)}</p>}
  </>
}

/** Members not on the task, faded; a green dot marks those who did their part. */
function IdlePile({ members, tookPart, wide, nameOf, onOpenMember, t }: {
  members: readonly RosterMember[]; tookPart: ReadonlySet<string>; wide: boolean
  nameOf: (appId: string) => string; onOpenMember: (appId: string) => void; t: TFunction
}) {
  const shown = members.slice(0, PILE_CAP)
  const rest = members.length - shown.length
  const named = members.length <= PILE_NAMED
  const size = named ? 28 : 24
  return <div className={`shrink-0 overflow-hidden ${wide ? 'py-2 pl-3 pr-1.5' : 'px-1 pb-1 pt-2.5'}`}
    style={wide ? { width: PILE_WIDTH, height: STAGE_HEIGHT.wide } : { height: NARROW_PILE_HEIGHT }}>
    <h4 className="mb-2 text-xs font-medium text-subtle-foreground">{t('On standby · {{count}}', { count: members.length })}</h4>
    {!members.length ? <p className="text-xs text-faint-foreground">{t('Everyone is on this task')}</p>
      : <div className={`flex flex-wrap ${named ? 'gap-x-1.5 gap-y-2' : 'gap-1.5'}`}>
        {shown.map(member => {
          const took = tookPart.has(member.appId)
          const offline = member.presence === 'offline'
          const text = `${member.memberName} · ${took ? t('Did their part') : offline ? t('Offline') : t('On standby')}`
          return <button key={member.appId} type="button" onClick={() => onOpenMember(member.appId)} title={text} aria-label={text}
            className={`flex flex-col items-center gap-0.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${named ? 'w-[46px]' : ''}`}>
            <span className="relative flex">
              <span className={`flex ${offline ? 'opacity-40 grayscale' : 'opacity-60 saturate-[.45]'}`}><AutomationAvatar name={member.memberName} size={size} /></span>
              {took && <i aria-hidden="true" data-tone="done" data-size="small" className="avatar-status-dot" />}
            </span>
            {named && <span className="max-w-[46px] truncate text-[10.5px] text-faint-foreground">{member.memberName}</span>}
          </button>
        })}
        {rest > 0 && <span className="flex h-[22px] min-w-[22px] items-center justify-center self-start rounded-full bg-secondary px-1.5 text-[11px] tabular-nums text-subtle-foreground">+{rest}</span>}
      </div>}
  </div>
}
