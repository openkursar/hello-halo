import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Lock, Search } from 'lucide-react'
import type { RosterMember } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { AutomationAvatar } from '../../apps/AutomationAvatar'
import { memberProgressText } from './progress-labels'
import type { ConversationProgress } from './TaskMemberSelector'

const WIDTH = 400
const SEARCHABLE = 8

/**
 * Every member of a team conversation with what each needs or is doing, grouped by
 * what they need from the user; searchable once the team outgrows the rail.
 */
export function TaskMemberPanel({ members, selectedAppId, owned, waiting, working, progress, onActivity, temporary = false, anchor, triggers, onPick, onClose }: {
  members: readonly RosterMember[]
  selectedAppId: string | null
  owned: ReadonlySet<string>
  waiting: ReadonlySet<string>
  working: ReadonlySet<string>
  progress: ConversationProgress | null
  onActivity?: (activityId?: string) => void
  /** Its members were brought in for this work, so none of them is "my digital human". */
  temporary?: boolean
  anchor: RefObject<HTMLElement>
  triggers: readonly RefObject<HTMLElement>[]
  onPick: (member: RosterMember) => void
  /** `refocus` is false when the panel hands the user on to something else. */
  onClose: (refocus?: boolean) => void
}) {
  const { t } = useTranslation()
  const panel = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<number | null>(null)
  const [position, setPosition] = useState<{ left: number; bottom: number; width: number; maxHeight: number } | null>(null)
  const searchable = members.length > SEARCHABLE

  useLayoutEffect(() => {
    const bounds = anchor.current?.getBoundingClientRect()
    if (!bounds) return
    const width = Math.min(WIDTH, window.innerWidth - 16)
    const left = Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8))
    setPosition({ left, bottom: window.innerHeight - bounds.top + 8, width, maxHeight: Math.max(160, Math.min(480, bounds.top - 16)) })
  }, [anchor])
  useEffect(() => { if (position && !searchable) panel.current?.focus() }, [position, searchable])
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!panel.current?.contains(target) && !triggers.some(trigger => trigger.current?.contains(target))) onClose()
    }
    document.addEventListener('pointerdown', outside)
    const resize = () => onClose()
    window.addEventListener('resize', resize)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize) }
  }, [onClose, triggers])

  const progressOf = new Map(progress?.progress.members.map(row => [row.appId, row]) ?? [])
  const needle = query.trim().toLocaleLowerCase()
  const matches = needle ? members.filter(member => `${member.memberName} ${member.role ?? ''}`.toLocaleLowerCase().includes(needle)) : members
  const placed = new Set<string>()
  const take = (test: (member: RosterMember) => boolean) => matches.filter(member => {
    if (placed.has(member.appId) || !test(member)) return false
    placed.add(member.appId)
    return true
  })
  const groups = [
    { key: 'attention', title: t('Needs your attention'), members: take(member => waiting.has(member.appId) || progressOf.get(member.appId)?.state === 'failed') },
    { key: 'working', title: t('Working'), members: take(member => working.has(member.appId)) },
    { key: 'mine', title: temporary ? t('Members') : t('My digital humans'), members: take(member => owned.has(member.appId)) },
    { key: 'rest', title: t('Other members · Read-only'), members: take(() => true) },
  ].filter(group => group.members.length)
  const flat = groups.flatMap(group => group.members)
  const current = active === null ? Math.max(0, flat.findIndex(member => member.appId === selectedAppId)) : Math.min(active, Math.max(0, flat.length - 1))
  useEffect(() => { setActive(null) }, [needle])
  useEffect(() => { list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [current])

  const detailOf = (member: RosterMember): { text: string; tone?: string } => {
    const row = progressOf.get(member.appId)
    if (row?.state === 'waiting') return { text: memberProgressText(row, members, t), tone: 'text-halo-warning' }
    if (row?.state === 'failed') return { text: memberProgressText(row, members, t), tone: 'text-destructive' }
    if (row?.state === 'working') return { text: memberProgressText(row, members, t) }
    if (member.appId === selectedAppId) return { text: t('Current') }
    if (!owned.has(member.appId)) return { text: member.owner ?? t('Read-only') }
    if (waiting.has(member.appId)) return { text: t('Waiting for you'), tone: 'text-halo-warning' }
    if (working.has(member.appId)) return { text: member.currentTaskTitle || t('Working') }
    return { text: row ? memberProgressText(row, members, t) : '' }
  }
  const handOn = (action: () => void) => { onClose(false); action() }

  if (!position) return null
  return createPortal(<div ref={panel} role="dialog" aria-label={t('All members')} tabIndex={-1} data-member-panel=""
    style={{ left: position.left, bottom: position.bottom, width: position.width, maxHeight: position.maxHeight }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (flat.length) setActive((current + (event.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length)
      } else if (event.key === 'Enter' && !event.nativeEvent.isComposing && (event.target === event.currentTarget || event.target instanceof HTMLInputElement) && flat[current]) {
        event.preventDefault(); onPick(flat[current])
      }
    }}
    className="fixed z-[100] flex origin-bottom-left animate-member-panel-in flex-col overflow-hidden rounded-[14px] border border-border-soft bg-popover text-popover-foreground shadow-pop focus:outline-none">
    {progress && <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border-faint px-3.5 text-[13px] text-subtle-foreground">
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{t('All members')}</span>
        {searchable && <span> · {t('{{count}} members', { count: members.length })}</span>}
      </span>
    </div>}
    {searchable && <label className="flex shrink-0 items-center gap-2 border-b border-border-faint px-3.5">
      <Search size={15} className="shrink-0 text-faint-foreground" aria-hidden="true" />
      <input autoFocus value={query} onChange={event => setQuery(event.target.value)} aria-label={t('Search members')}
        placeholder={t('Search {{count}} members…', { count: members.length })}
        className="h-11 min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-faint-foreground focus:outline-none" />
    </label>}
    <div ref={list} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
      {groups.map(group => <div key={group.key} role="group" aria-label={group.title} className="[&+&]:mt-1.5">
        <div className={`flex select-none items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-xs leading-5 ${group.key === 'attention' ? 'text-halo-warning' : 'text-subtle-foreground'}`}>
          <span>{group.title}</span><span className="tabular-nums opacity-70">{group.members.length}</span>
        </div>
        <div className="space-y-0.5">{group.members.map(member => {
          const index = flat.indexOf(member)
          const selected = member.appId === selectedAppId
          const readOnly = !owned.has(member.appId)
          const detail = detailOf(member)
          const row = progressOf.get(member.appId)
          const answer = row?.state === 'waiting' && row.decisionId ? row.decisionId : null
          const view = row?.state === 'failed' && row.activityId ? row.activityId : null
          const dot = waiting.has(member.appId) || row?.state === 'waiting' ? 'waiting' : row?.state === 'failed' ? 'failed'
            : row?.state === 'working' || working.has(member.appId) ? 'working' : null
          return <div key={member.appId} data-active={index === current} onPointerMove={() => { if (index !== current) setActive(index) }}
            className={`flex h-10 items-center gap-2 rounded-[9px] pr-2 ${selected ? 'bg-secondary' : index === current ? 'bg-secondary/60' : ''}`}>
            <button type="button" tabIndex={-1} aria-current={selected || undefined} onClick={() => onPick(member)}
              className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch pl-2.5 text-left focus:outline-none">
              <span className="relative flex shrink-0">
                <AutomationAvatar name={member.memberName} size={24} />
                {readOnly && <i aria-hidden="true" className="avatar-lock-badge"><Lock strokeWidth={3} /></i>}
                {dot && <i aria-hidden="true" data-tone={dot} className="avatar-status-dot" />}
              </span>
              <span className={`max-w-[70%] shrink-0 truncate text-[13.5px] text-foreground ${selected ? 'font-semibold' : ''}`}>{member.memberName}</span>
              {member.role && <span className="-ml-1 min-w-0 shrink-[4] truncate text-xs text-faint-foreground">{member.role}</span>}
              {detail.text && <span title={detail.text} className={`ml-auto min-w-0 truncate pl-1 text-xs ${detail.tone ?? 'text-faint-foreground'}`}>
                {detail.text}
              </span>}
            </button>
            {answer && progress && <button type="button" onClick={() => handOn(() => progress.onAnswer(answer))}
              className="inline-flex h-[26px] shrink-0 items-center rounded-full border border-halo-warning/45 bg-background px-2.5 text-xs text-halo-warning hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('Answer')}</button>}
            {view && onActivity && <button type="button" onClick={() => handOn(() => onActivity(view))}
              className="inline-flex h-[26px] shrink-0 items-center rounded-full border border-border bg-background px-2.5 text-xs text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('View')}</button>}
          </div>
        })}</div>
      </div>)}
      {!flat.length && <p className="px-2.5 py-6 text-center text-sm text-muted-foreground">{t('No matching members')}</p>}
    </div>
  </div>, document.body)
}
