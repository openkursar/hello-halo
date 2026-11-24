import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronRight, Loader2, MoreHorizontal, Pause, Play, Plus, Settings, UserPlus } from 'lucide-react'
import type { TeamConversation, TeamDetail } from '../../../../shared/apps/team-types'
import type { TeamTaskViewMemory } from '../../../services/canvas-lifecycle'
import { useTranslation } from '../../../i18n'
import { useAppsStore } from '../../../stores/apps.store'
import { useAppsPageStore } from '../../../stores/apps-page.store'
import { usePeopleViewStore } from '../../../stores/people-view.store'
import { useTeamStore, useTeamView } from '../../../stores/team.store'
import { useElementWidth } from '../../../hooks/useElementWidth'
import { teamAvatarFaces } from '../../../hooks/useTeamConversationRows'
import { localTeamSpace, openTeamConversation } from '../../../utils/team-conversation-navigation'
import { AutomationAvatar } from '../../apps/AutomationAvatar'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/Popover'
import { Tooltip } from '../../ui/Tooltip'
import { SettingsTab } from '../SettingsTab'
import { TeamAvatar } from '../TeamAvatar'
import { TeamInviteDialog } from '../TeamInviteDialog'
import { ownedTaskMembers } from '../workbench/members'
import { DockedPanel } from './DockedPanel'
import { MemberFace } from './member-ui'
import { MemberPanel } from './MemberPanel'
import { MembersPage } from './MembersPage'
import { OutputsPanel } from './OutputsPanel'
import { doneThisMonth, liveTaskCount, memberState, type TaskStateKey } from './status'
import { StateIcon } from './task-ui'
import { TaskPanel, type TaskPanelReveal } from './TaskPanel'
import { NO_TASK_FILTERS, TaskList, type TaskFilters } from './TaskList'

/** The one side panel: a task, the team's outputs, or one member. */
type Panel = { kind: 'task'; epochId: string } | { kind: 'outputs' } | { kind: 'member'; appId: string }
/** A page that takes the task list's place, with its own way back. */
type SubPage = 'settings' | 'members'

const DOCK_WIDTH = 1040
const COMPACT_WIDTH = 560
const WIDE_CONTENT = 860
/** Header, task list and the members page share this cap (1120px of content inside sm:px-10) so the actions line up with the list's right edge; the split view stays uncapped. */
const PAGE_MAX = 'max-w-[1200px]'
const STACK_FACES = 5
const ICON_ACTION = 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-subtle-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
const SECONDARY_ACTION = 'inline-flex h-8 min-w-[32px] shrink-0 items-center justify-center gap-1.5 rounded-full bg-secondary px-2.5 text-[13px] sm:px-3.5 text-foreground transition-colors hover:bg-surface-hover disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'

export function TeamDetailPage({ detail, onBack }: { detail: TeamDetail; onBack?: () => void }) {
  const { t } = useTranslation()
  const conversations = useTeamView(view => view.conversations)
  const loading = useTeamView(view => view.isLoadingConversations)
  const error = useTeamView(view => view.conversationsError)
  const navigationTarget = usePeopleViewStore(state => state.teamTarget)
  const apps = useAppsStore(state => state.apps)
  const [rootRef, width] = useElementWidth<HTMLDivElement>()
  const [page, setPage] = useState<SubPage | null>(null)
  const [panel, setPanel] = useState<Panel | null>(null)
  const [filters, setFilters] = useState<TaskFilters>(NO_TASK_FILTERS)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [condensed, setCondensed] = useState(false)
  const [reveal, setReveal] = useState<TaskPanelReveal | undefined>()
  const [pausing, setPausing] = useState(false)
  const [starting, setStarting] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const revealSeq = useRef(0)
  const memories = useRef(new Map<string, TeamTaskViewMemory>())
  const mainRef = useRef<HTMLElement | null>(null)
  const titleRef = useRef<HTMLHeadingElement | null>(null)
  const [measureMain, mainWidth] = useElementWidth<HTMLElement>()
  const attachMain = useCallback((node: HTMLElement | null) => { mainRef.current = node; measureMain(node) }, [measureMain])

  const team = detail.team
  const taskSpaceId = localTeamSpace(detail) ?? team.owningSpaceId
  const tasks = useMemo(() => conversations
    .filter(task => task.kind !== 'member')
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.epochId.localeCompare(b.epochId)), [conversations])
  const ownedIds = useMemo(() => ownedTaskMembers(detail, apps).map(member => member.appId), [detail, apps])
  const roster = useMemo(() => [...detail.roster].sort((a, b) => Number(b.isLead) - Number(a.isLead)), [detail.roster])
  const faces = useMemo(() => teamAvatarFaces(roster), [roster])
  const docked = width >= DOCK_WIDTH
  const compact = width > 0 && width < COMPACT_WIDTH
  const wide = mainWidth >= WIDE_CONTENT
  // A joined team is run from its owner's machine: invite and run stay visible but locked, so the page reads the same on both sides.
  const joined = !!team.hostNodeId
  const hostOwner = joined ? detail.members.find(member => member.ownerNodeId === team.hostNodeId && member.ownerDisplayName?.trim())?.ownerDisplayName?.trim() : undefined

  const panelTask = panel?.kind === 'task' ? tasks.find(task => task.epochId === panel.epochId) : undefined
  const panelMember = panel?.kind === 'member' ? detail.roster.find(member => member.appId === panel.appId) : undefined
  const outputsOpen = panel?.kind === 'outputs'
  const panelOpen = !!panelTask || !!panelMember || outputsOpen

  const showPage = (next: SubPage | null) => {
    setPage(next)
    setPanel(null)
    setCondensed(false)
    mainRef.current?.scrollTo({ top: 0 })
  }
  const openTask = (epochId: string, next?: Omit<TaskPanelReveal, 'seq'>) => {
    // Opening a task starts at its overview with the exchanges folded; the remembered drill only survives a re-dock.
    const memory = memoryFor(epochId)
    if (!next?.memberAppId) delete memory.memberAppId
    if (memory.open?.exchanges) memory.open = { ...memory.open, exchanges: false }
    // A task opened from the members page opens beside it; settings give way to the list.
    if (page === 'settings') showPage(null)
    setPanel({ kind: 'task', epochId })
    setReveal(next ? { ...next, seq: ++revealSeq.current } : undefined)
  }
  const openMembers = () => showPage('members')
  const openMember = (appId: string) => setPanel({ kind: 'member', appId })
  const openOutputs = () => setPanel({ kind: 'outputs' })
  const closePanel = () => setPanel(null)
  const onScroll = (top: number) => {
    const title = titleRef.current
    setCondensed(!!title && top + 48 >= title.offsetTop + title.offsetHeight)
  }
  const memoryFor = (epochId: string) => {
    let memory = memories.current.get(epochId)
    if (!memory) memories.current.set(epochId, memory = {})
    return memory
  }

  useEffect(() => {
    if (!navigationTarget || navigationTarget.teamId !== team.id || loading) return
    if (navigationTarget.epochId) {
      const { entryId, appId, decision } = navigationTarget
      openTask(navigationTarget.epochId, entryId ? (decision ? { decisionId: entryId } : { activityId: entryId }) : appId && !decision ? { memberAppId: appId } : undefined)
    } else if (navigationTarget.appId && detail.roster.some(member => member.appId === navigationTarget.appId)) {
      openMembers()
      openMember(navigationTarget.appId)
    }
    usePeopleViewStore.setState({ teamTarget: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigationTarget, team.id, loading, detail.roster])

  const startTask = () => {
    if (taskSpaceId) openTeamConversation(taskSpaceId, { teamId: team.id, epochId: null, teamName: team.name })
  }
  const openProfile = (appId: string) => {
    usePeopleViewStore.setState({ returnTeam: { teamId: team.id, appId }, returnPerson: null })
    useAppsPageStore.getState().openActivityThread(appId)
    useAppsPageStore.getState().setCurrentTab('my-digital-humans')
  }
  const showRun = joined || !!team.goal.trim()
  const stoppable = !joined && !!team.currentEpochId
  // A disabled button gets no hover, so the reason lives on a wrapper tooltip instead of `title`.
  const ownerOnly = (button: ReactNode, hint: string) => joined ? <Tooltip label={hint} side="bottom">{button}</Tooltip> : button
  const run = async () => {
    if (starting) return
    setStarting(true)
    try {
      const started = await useTeamStore.getState().runTeam(team.id)
      if (started) openTask(started.epochId)
    } finally { setStarting(false) }
  }
  const pause = async () => {
    if (pausing) return
    setPausing(true)
    try { await useTeamStore.getState().pauseTeam(team.id) } finally { setPausing(false) }
  }

  const startButton = <button onClick={startTask} disabled={!taskSpaceId} className="inline-flex h-8 items-center justify-center gap-1 whitespace-nowrap rounded-full bg-foreground px-3.5 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
    {t('Start task')}<span aria-hidden="true">↗</span>
  </button>
  const actions = <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
    {ownerOnly(<button onClick={() => setInviteOpen(true)} disabled={joined} aria-label={compact ? t('Invite') : undefined} title={joined ? undefined : t('Invite members')} className={SECONDARY_ACTION}>
      <UserPlus size={14} aria-hidden="true" />{!compact && t('Invite')}
    </button>, hostOwner ? t('Only {{owner}}, the team owner, can invite members', { owner: hostOwner }) : t('Only the team owner can invite members'))}
    {stoppable
      ? <button onClick={() => void pause()} disabled={pausing} aria-label={compact ? t('Pause team') : undefined} title={t('Pauses everything the team is working on. Tasks stay open and pick up again with a new message; to close one task for good, open it and choose End task.')} className={SECONDARY_ACTION}>
        {pausing ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}{!compact && t('Pause team')}
      </button>
      : showRun && ownerOnly(<button onClick={() => void run()} disabled={joined || starting} aria-label={compact ? t('Run') : undefined} title={joined ? undefined : t('Run toward the team goal now')} className={SECONDARY_ACTION}>
        {starting ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}{!compact && t('Run')}
      </button>, hostOwner ? t('Only {{owner}}, the team owner, can run the team', { owner: hostOwner }) : t('Only the team owner can run the team'))}
    {startButton}
    <button onClick={() => showPage('settings')} aria-label={t('Team settings')} title={t('Team settings')} className={ICON_ACTION}><Settings size={16} aria-hidden="true" /></button>
  </div>
  const menuItem = (onClick: () => void, icon: ReactNode, label: ReactNode, disabled = false) => <button onClick={() => { setMoreOpen(false); onClick() }} disabled={disabled}
    className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] hover:bg-surface-hover disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
    <span className="flex w-4 shrink-0 justify-center text-subtle-foreground">{icon}</span><span className="min-w-0 flex-1 truncate">{label}</span>
  </button>
  // Beside an open panel, the panel's own action leads; the team's wait behind one menu.
  const panelActions = <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
    <Popover open={moreOpen} onOpenChange={setMoreOpen}>
      <PopoverTrigger title={t('More')} className={`${ICON_ACTION} cursor-pointer`}><MoreHorizontal size={16} aria-hidden="true" /></PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-44 p-1">
        {menuItem(startTask, <Plus size={14} />, <>{t('Start task')}<span aria-hidden="true"> ↗</span></>, !taskSpaceId)}
        {menuItem(() => setInviteOpen(true), <UserPlus size={14} />, t('Invite'), joined)}
        {stoppable
          ? menuItem(() => void pause(), pausing ? <Loader2 size={14} className="animate-spin" /> : <Pause size={13} />, t('Pause team'), pausing)
          : showRun && menuItem(() => void run(), starting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />, t('Run'), joined || starting)}
        {menuItem(() => showPage('settings'), <Settings size={14} />, t('Team settings'))}
        {joined && <p className="px-2.5 pb-1.5 pt-1 text-xs leading-5 text-subtle-foreground">{hostOwner ? t('Only {{owner}}, the team owner, can invite members or run the team', { owner: hostOwner }) : t('Only the team owner can invite members or run the team')}</p>}
      </PopoverContent>
    </Popover>
  </div>
  const renderPanel = (isDocked: boolean) => panelTask
    ? <TaskPanel key={panelTask.epochId} detail={detail} task={panelTask} taskSpaceId={taskSpaceId} docked={isDocked} memory={memoryFor(panelTask.epochId)} reveal={reveal}
      onRevealHandled={seq => setReveal(current => current?.seq === seq ? undefined : current)} onClose={closePanel} onOpenTask={id => openTask(id)} />
    : panelMember
      ? <MemberPanel key={panelMember.appId} detail={detail} member={panelMember} tasks={tasks} taskSpaceId={taskSpaceId} docked={isDocked} owned={ownedIds.includes(panelMember.appId)}
        onOpenTask={epochId => openTask(epochId, { memberAppId: panelMember.appId })} onOpenProfile={() => openProfile(panelMember.appId)} onClose={closePanel} />
      : outputsOpen
        ? <OutputsPanel detail={detail} tasks={tasks} docked={isDocked} onOpenTask={id => openTask(id)} onClose={closePanel} />
        : null
  const panelLabel = panelMember ? t('Member details') : outputsOpen ? t('Outputs') : t('Task details')
  const backButton = 'shrink-0 rounded-full p-1.5 text-subtle-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'

  const back = <button onClick={() => onBack ? onBack() : useTeamStore.getState().selectTeam(null)} aria-label={t('Back to teams')} title={t('Back to teams')} className={backButton}><ArrowLeft size={18} /></button>
  const pulse = (!loading || tasks.length > 0) && <TeamPulse detail={detail} tasks={tasks} outputsOpen={outputsOpen} onOpenOutputs={openOutputs} className="min-w-0 overflow-hidden whitespace-nowrap" />
  // Side by side, the team collapses to one bar over both columns so the list and the panel each scroll on their own.
  const split = panelOpen && docked && !page
  useEffect(() => {
    if (mainRef.current) onScroll(mainRef.current.scrollTop)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [split])

  // The collapsed header, the same whether scrolled past the title or sitting over the list and a panel.
  const teamBar = (className: string, tools: ReactNode) => <div className={`flex items-center gap-2.5 border-b border-border-soft bg-background px-3 py-2.5 sm:px-4 ${className}`}>
    {back}
    <button onClick={openMembers} aria-label={t('View team members')} title={t('View team members')} className="shrink-0 rounded-full p-0.5 transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <TeamAvatar faces={faces} name={team.name} size={36} />
    </button>
    <div className="min-w-0 flex-1 text-left">
      <div className="flex min-w-0 items-center gap-2">
        <p className="max-w-[60%] shrink-0 truncate text-[15px] font-semibold leading-6">{team.name}</p>
        {pulse}
      </div>
      {team.goal.trim() && <p title={team.goal} className="truncate text-[12.5px] leading-5 text-subtle-foreground">{team.goal}</p>}
    </div>
    {tools}
  </div>

  return <div ref={rootRef} className="relative flex h-full min-h-0 flex-col bg-background">
    {split && teamBar('shrink-0', panelActions)}
    <div className="relative flex min-h-0 flex-1">
      <main ref={attachMain} onScroll={event => onScroll(event.currentTarget.scrollTop)} className="relative min-w-0 flex-1 overflow-y-auto">
        {page
          ? <>
            <div className={`sticky top-0 z-20 flex h-12 items-center gap-2 bg-background px-3 sm:px-4 ${condensed ? 'shadow-[0_1px_0_hsl(var(--border)/0.5)]' : ''}`}>
              <button onClick={() => showPage(null)} className="inline-flex h-8 min-w-0 items-center gap-1.5 rounded-full px-2 text-[13px] text-subtle-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                <ArrowLeft size={16} className="shrink-0" aria-hidden="true" /><span className="truncate">{team.name}</span>
              </button>
            </div>
            <div className={`mx-auto w-full ${page === 'settings' ? 'max-w-2xl px-5 sm:px-6' : `${PAGE_MAX} px-6 sm:px-10`} pb-16 pt-2`}>
              {page === 'settings'
                ? <>
                  <h1 ref={titleRef} className="mb-5 text-[22px] font-semibold leading-8 tracking-tight">{t('Team settings')}</h1>
                  <SettingsTab detail={detail} openMemberId={null} onOpenMemberChange={appId => { if (appId) openMember(appId) }} layout="page" />
                </>
                : <>
                  <h1 ref={titleRef} className="mb-4 flex items-baseline gap-2 text-[22px] font-semibold leading-8 tracking-tight">
                    {t('Members')}<span className="text-[15px] font-normal tabular-nums text-faint-foreground">{detail.roster.length}</span>
                  </h1>
                  <MembersPage detail={detail} tasks={tasks} selectedId={panelMember?.appId ?? null} onOpenMember={openMember} />
                </>}
            </div>
          </>
          : <>
            {!split && <>
              <div className="sticky top-0 z-20 h-12">
                <div className={`flex h-12 items-center justify-between gap-2 bg-background px-3 transition-[visibility] duration-200 sm:px-4 ${condensed ? 'invisible' : ''}`}>
                  {back}
                  {!wide && actions}
                </div>
                {teamBar(`absolute inset-x-0 top-0 transition-[opacity,transform,visibility] duration-200 ${condensed ? 'visible translate-y-0 opacity-100' : 'invisible -translate-y-1 opacity-0'}`, actions)}
              </div>

              <section className={`mx-auto flex w-full ${PAGE_MAX} flex-col items-center px-6 pb-1 pt-3 text-center sm:px-10`}>
                <MemberStrip detail={detail} roster={roster} onClick={openMembers} />
                <div className={`mt-3 items-center gap-3 ${wide ? 'grid w-full grid-cols-[1fr_auto_1fr]' : 'flex max-w-full justify-center'}`}>
                  {wide && <span aria-hidden="true" />}
                  <div className="flex min-w-0 items-center justify-center gap-2">
                    <h1 ref={titleRef} className="min-w-0 truncate text-[22px] font-semibold leading-8 tracking-tight sm:text-[24px]">{team.name}</h1>
                  </div>
                  {wide && <div className={`justify-self-end ${condensed ? 'invisible' : ''}`}>{actions}</div>}
                </div>
                {pulse && <div className="mt-1 max-w-full">{pulse}</div>}
                {team.goal.trim() && <p title={team.goal} className="mt-1.5 line-clamp-2 max-w-full whitespace-pre-wrap break-words text-sm leading-6 text-subtle-foreground">{team.goal}</p>}
              </section>
            </>}

            <div className={split ? 'px-5 pb-16 pt-4 sm:px-6' : `mx-auto w-full ${PAGE_MAX} px-6 pb-16 pt-8 sm:px-10`}>
              <TaskList wide={wide} detail={detail} tasks={tasks} taskSpaceId={taskSpaceId} filters={filters} onFilters={setFilters} selectedId={panelTask?.epochId ?? null} loading={loading} error={error}
                onOpenTask={id => openTask(id)} onOpenSettings={() => showPage('settings')} onOpenMembers={openMembers} focused={panelOpen} />
            </div>
          </>}
      </main>

      {panelOpen && docked && <DockedPanel label={panelLabel} containerWidth={width}>
        {renderPanel(true)}
      </DockedPanel>}
    </div>
    {panelOpen && !docked && <section aria-label={panelLabel} className="absolute inset-0 z-30 bg-background">
      {renderPanel(false)}
    </section>}
    {inviteOpen && <TeamInviteDialog teamId={team.id} onClose={() => setInviteOpen(false)} />}
  </div>
}

/** Where the team stands in one line: its most pressing state (a failure, a decision for the user, live tasks), then what it finished this month. */
function TeamPulse({ detail, tasks, outputsOpen, onOpenOutputs, className }: {
  detail: TeamDetail; tasks: readonly TeamConversation[]; outputsOpen: boolean; onOpenOutputs: () => void; className?: string
}) {
  const { t } = useTranslation()
  const status = detail.team.status
  const live = liveTaskCount(detail, tasks)
  const [key, tone, text]: [TaskStateKey, string, string] = status === 'error' ? ['error', 'text-destructive', t('Needs attention')]
    : status === 'waiting_user' && detail.pendingEscalations?.length ? ['waiting_user', 'text-halo-warning', t('Waiting for you')]
      : live ? ['running', 'text-primary', t('{{count}} tasks running', { count: live })]
        : ['idle', 'text-subtle-foreground', t('Idle')]
  const done = doneThisMonth(detail, tasks)
  const outputs = done.reduce((sum, task) => sum + (task.artifactCount ?? 0), 0)
  return <p className={`flex items-center gap-1.5 text-[13px] text-subtle-foreground ${className ?? ''}`}>
    <StateIcon state={key} />
    <span className={tone}>{text}</span>
    {done.length > 0 && <span>· {t('{{count}} completed this month', { count: done.length })}</span>}
    {outputs > 0 && <>
      <span aria-hidden="true">·</span>
      <button onClick={onOpenOutputs} aria-expanded={outputsOpen} title={t('View the team outputs')}
        className={`-mx-1.5 inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${outputsOpen ? 'bg-secondary text-foreground' : ''}`}>
        {t('{{count}} outputs', { count: outputs })}<ChevronRight size={13} aria-hidden="true" className="text-faint-foreground" />
      </button>
    </>}
  </p>
}

/** Who is on the team at a glance, and how many of them are busy; a member on several tasks counts once. Opens the members page. */
function MemberStrip({ detail, roster, onClick }: { detail: TeamDetail; roster: TeamDetail['roster']; onClick: () => void }) {
  const { t } = useTranslation()
  if (!roster.length) return null
  const veiled = roster.length > STACK_FACES
  const shown = roster.slice(0, STACK_FACES)
  const rest = roster.length - STACK_FACES + 1
  const working = roster.filter(member => memberState(detail, member) === 'working').length
  return <button onClick={onClick} aria-label={t('View team members')} className="inline-flex items-center gap-2.5 rounded-full py-1 pl-1 pr-3 transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
    <span className="flex -space-x-2">
      {shown.map((member, index) => <span key={member.appId} className="relative rounded-full ring-2 ring-background">
        {veiled && index === shown.length - 1
          ? <span className="relative flex overflow-hidden rounded-full">
            <AutomationAvatar name={member.memberName} size={28} />
            <span className="absolute inset-0 flex items-center justify-center bg-foreground/40 text-[10px] font-semibold tabular-nums text-background">+{rest > 99 ? 99 : rest}</span>
          </span>
          : <MemberFace name={member.memberName} state={memberState(detail, member)} size={28} />}
      </span>)}
    </span>
    <span className="text-[13px] text-subtle-foreground">
      {t('{{count}} members', { count: roster.length })}
      {working > 0 && <> · <span className="text-primary">{t('{{count}} working', { count: working })}</span></>}
    </span>
  </button>
}
