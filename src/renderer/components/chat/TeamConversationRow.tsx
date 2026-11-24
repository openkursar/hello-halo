import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pin, Pencil, EllipsisVertical, EyeOff, ExternalLink } from 'lucide-react'
import { ConversationGroupHeader } from './ConversationGroupHeader'
import { openPersonTeam } from '../../utils/people-navigation'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { cn } from '../../lib/utils'
import { useChatStore } from '../../stores/chat.store'
import { useTeamChatPinsStore } from '../../stores/team-chat-pins.store'
import { useTeamChatHiddenStore } from '../../stores/team-chat-hidden.store'
import { teamTaskHoverCard, type RowHoverCard } from './conversation-row-format'
import { openTeamConversation } from '../../utils/team-conversation-navigation'
import type { TeamListRow } from '../../hooks/useTeamConversationRows'
import { TaskStatusDot } from '../pulse/TaskStatusDot'
import { TeamAvatar } from '../team/TeamAvatar'

const MENU_HEIGHT = 116

export function TeamConversationRow({ row, spaceId, onToggle, onRefresh, onSelected, onHover, onHoverEnd, compact = false }: {
  row: TeamListRow
  spaceId: string
  onToggle: (teamId: string, open: boolean) => void
  onRefresh: () => void
  onSelected?: () => void
  onHover?: (element: HTMLElement, card: RowHoverCard) => void
  onHoverEnd?: () => void
  compact?: boolean
}) {
  const { t } = useTranslation()
  const selected = useChatStore(s => s.spaceStates.get(spaceId)?.selectedTeamChat)
  const togglePin = useTeamChatPinsStore(s => s.togglePin)
  const hide = useTeamChatHiddenStore(s => s.hide)
  const restoreTeam = useTeamChatHiddenStore(s => s.restoreTeam)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!menuPosition) return
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !menuButtonRef.current?.contains(event.target as Node)) setMenuPosition(null)
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setMenuPosition(null); menuButtonRef.current?.focus() }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', keydown, true)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', keydown, true) }
  }, [menuPosition])
  const run = async (action: () => Promise<{ success: boolean; error?: string }>) => {
    setBusy(true)
    setFailed(false)
    try {
      const result = await action()
      if (!result.success) throw new Error(result.error || 'Team action failed')
      setEditing(false)
      onRefresh()
    } catch (error) {
      console.error('[TeamConversationList] Action failed', { spaceId, rowKey: row.key }, error)
      setFailed(true)
    } finally { setBusy(false) }
  }
  if (row.type === 'team-retry') return <button type="button" onClick={onRefresh} className="w-full px-3 py-2 text-xs text-muted-foreground hover:bg-secondary">{t('Retry')}</button>
  if (row.type === 'team-hidden') return <button type="button" onClick={() => restoreTeam(spaceId, row.teamId)} className="flex w-full items-center gap-1.5 rounded-sm py-1 pl-9 pr-1.5 text-left text-xs text-faint-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
    {t('Show {{count}} removed', { count: row.count })}
  </button>
  if (row.type === 'team-header') {
    const toggle = () => onToggle(row.teamId, !row.collapsed)
    return <ConversationGroupHeader
      name={row.name}
      collapsed={row.collapsed}
      onToggle={toggle}
      onNew={() => { if (openTeamConversation(spaceId, { teamId: row.teamId, epochId: null, teamName: row.name })) onSelected?.() }}
      newLabel={t('New team conversation')}
      avatar={<button type="button" title={t('View {{name}}', { name: row.name })} aria-label={t('View {{name}}', { name: row.name })} onClick={() => { openPersonTeam({ teamId: row.teamId }); onSelected?.() }} className="flex shrink-0 rounded-[6px] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><TeamAvatar faces={row.avatar} name={row.name} /></button>}
    />
  }
  const { task } = row
  const active = selected?.teamId === task.teamId && selected.epochId === task.epochId
  const select = () => { if (openTeamConversation(spaceId, { teamId: task.teamId, epochId: task.epochId, label: task.label, teamName: task.teamName })) onSelected?.() }
  if (compact) {
    const status = task.waitingForMe ? 'waiting' : task.active ? 'generating' : null
    return <button type="button" onClick={select} onMouseEnter={event => onHover?.(event.currentTarget, teamTaskHoverCard(task, t))} onMouseLeave={onHoverEnd} aria-label={task.label || t('New team conversation')} aria-current={active} className={cn('flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full transition-colors ease-halo hover:bg-secondary', active && 'bg-secondary')}>
      {status ? <TaskStatusDot status={status} size="md" /> : <span className={cn('h-[7px] w-[7px] rounded-full', active ? 'bg-foreground' : 'bg-subtle-foreground opacity-50')} />}
    </button>
  }
  const remove = () => {
    if (row.starred) togglePin(spaceId, row.key)
    hide(spaceId, row.key, task.waitingForMe === true)
    setMenuPosition(null)
  }
  const save = () => {
    const name = title.trim()
    if (!name || name === task.label) { setEditing(false); return }
    if (!busy) void run(() => api.teamRenameConversation(task.teamId, task.epochId, name))
  }
  return <div>
    <div data-menu-open={menuPosition ? '' : undefined} className={cn('group relative flex w-full items-center gap-1.5 rounded-sm pr-1.5 py-1.5 text-[13px] transition-colors ease-halo', 'data-[menu-open]:bg-secondary data-[menu-open]:text-foreground theme-dark:data-[menu-open]:text-foreground has-[:focus-visible]:bg-secondary', row.standalone ? 'pl-2.5' : 'pl-9', active ? 'bg-secondary text-foreground font-medium' : 'text-foreground/80 hover:bg-secondary hover:text-foreground theme-dark:text-muted-foreground theme-dark:hover:text-foreground')} onMouseEnter={event => { if (!editing) onHover?.(event.currentTarget, teamTaskHoverCard(task, t)) }} onMouseLeave={onHoverEnd}>
      {row.standalone && <button type="button" title={t('View {{name}}', { name: task.teamName })} aria-label={t('View {{name}}', { name: task.teamName })} onClick={() => { openPersonTeam({ teamId: task.teamId }); onSelected?.() }} className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[6px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><TeamAvatar faces={row.avatar} name={task.teamName} /></button>}
      {(task.waitingForMe || task.active) && <TaskStatusDot status={task.waitingForMe ? 'waiting' : 'generating'} size="sm" className={row.standalone ? undefined : 'absolute left-6 top-1/2 -translate-y-1/2'} />}
      {editing ? <form className="flex min-w-0 flex-1" onSubmit={event => { event.preventDefault(); save() }}>
        <input autoFocus aria-label={t('Conversation title...')} value={title} onChange={event => setTitle(event.target.value)} onFocus={event => event.currentTarget.select()} onBlur={save} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setEditing(false) } }} className="flex-1 text-sm bg-input border border-border rounded px-2 py-1 focus:outline-none focus:border-primary min-w-0" />
      </form> : <button type="button" onClick={select} aria-current={active} className="flex-1 min-w-0 overflow-hidden whitespace-nowrap text-left [mask-image:linear-gradient(to_right,black_calc(100%_-_20px),transparent)]">{task.label || t('New team conversation')}</button>}
      {!editing && <div className="absolute inset-y-0 right-1.5 flex items-center gap-0.5 pl-5 bg-[linear-gradient(to_right,transparent,hsl(var(--secondary))_20px)] opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-data-[menu-open]:opacity-100 group-data-[menu-open]:pointer-events-auto has-[:focus-visible]:opacity-100 has-[:focus-visible]:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto">
        <button type="button" className={cn('w-[22px] h-[22px] flex-shrink-0 rounded-[6px] flex items-center justify-center transition-colors', row.starred ? 'text-accent-on-dark' : 'text-faint-foreground hover:bg-surface-hover hover:text-foreground')} title={row.starred ? t('Unpin') : t('Pin')} aria-label={row.starred ? t('Unpin') : t('Pin')} aria-pressed={row.starred} onClick={() => togglePin(spaceId, row.key)}><Pin className="w-[13px] h-[13px]" strokeWidth={1.8} /></button>
        <button ref={menuButtonRef} type="button" className="w-[22px] h-[22px] flex-shrink-0 rounded-[6px] flex items-center justify-center text-faint-foreground transition-colors hover:bg-surface-hover hover:text-foreground" title={t('More')} aria-label={t('More')} aria-expanded={!!menuPosition} aria-haspopup="menu" onClick={event => { if (menuPosition) { setMenuPosition(null); return } const rect = event.currentTarget.getBoundingClientRect(); onHoverEnd?.(); setMenuPosition({ top: window.innerHeight - rect.bottom >= MENU_HEIGHT ? rect.bottom + 4 : Math.max(4, rect.top - MENU_HEIGHT), left: rect.right }) }}><EllipsisVertical className="w-[13px] h-[13px]" strokeWidth={1.8} /></button>
      </div>}
    </div>
    {menuPosition && createPortal(<div ref={menuRef} role="menu" onMouseDown={event => event.stopPropagation()} className="fixed z-[9999] min-w-[160px] max-w-[240px] bg-popover border border-border rounded-lg shadow-lg py-1" style={{ top: menuPosition.top, left: menuPosition.left, transform: 'translateX(-100%)' }}>
      <>
        <button type="button" role="menuitem" disabled={busy} onClick={() => { setTitle(task.label); setMenuPosition(null); setEditing(true) }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary transition-colors"><Pencil className="w-3.5 h-3.5" /><span>{t('Rename')}</span></button>
        <button type="button" role="menuitem" onClick={() => { setMenuPosition(null); openPersonTeam({ teamId: task.teamId, epochId: task.epochId }); onSelected?.() }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary transition-colors"><ExternalLink className="w-3.5 h-3.5" /><span>{t('View in team')}</span></button>
        {/* Only this list forgets it, and the team's row offers it back, so no confirmation is asked. */}
        <button type="button" role="menuitem" onClick={remove} title={t('The task stays in the team')} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary transition-colors"><EyeOff className="w-3.5 h-3.5" /><span>{t('Remove from list')}</span></button>
      </>
    </div>, document.body)}
    {failed && <p role="alert" className="px-2 py-1 text-xs text-destructive">{t('Could not update conversation. Please try again.')}</p>}
  </div>
}
