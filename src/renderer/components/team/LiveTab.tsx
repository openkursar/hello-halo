/**
 * LiveTab — the team's canonical view: watch it work on ONE unit of work.
 *
 * Symmetric with the Conversation tab (chat + session list): here it's the
 * topology/activity view + an event list ({@link EventSidebar}). Selecting any
 * event — a live run, a conversation members are working, or a PAST run —
 * renders it on the left. A past run replays as the same topology visualization
 * (static shape + its recorded activity + products), which is why this tab
 * absorbs what used to be a separate History tab.
 *
 * The header always says which item you're looking at (never an unlabeled graph);
 * with nothing running it rests on the most recent run.
 */

import { useEffect, useMemo, useState } from 'react'
import { PanelRight, Zap, MessageSquare, History, Loader2 } from 'lucide-react'
import type { TeamDetail, RosterMember, EpochBoard, TeamConversation } from '../../../shared/apps/team-types'
import { awaitsOurDecision } from '../../../shared/apps/team-types'
import { useTeamStore } from '../../stores/team.store'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useTranslation } from '../../i18n'
import { StatusBoard, type BoardView } from './StatusBoard'
import { EventSidebar } from './EventSidebar'
import { triggerLabel, formatRunTime, runEventTitle, conversationLabel, epochLabel, outcomeMeta, replayRoster } from './run-history'

/** Fetched snapshot first, then rows pushed live for the same epoch — later wins per id. */
function mergeById<T extends { id: string }>(snapshot: T[], live: T[]): T[] {
  if (live.length === 0) return snapshot
  const byId = new Map(snapshot.map(row => [row.id, row]))
  for (const row of live) byId.set(row.id, row)
  return [...byId.values()]
}

interface LiveTabProps {
  detail: TeamDetail
  onSelectMember: (member: RosterMember) => void
  editingStructure?: boolean
  onExitEditing?: () => void
  /** The focused item (owned by the parent so Run/jump-from-chat can drive it). */
  focusedEpochId: string | null
  onFocus: (epochId: string | null) => void
}

export function LiveTab({ detail, onSelectMember, editingStructure, onExitEditing, focusedEpochId, onFocus }: LiveTabProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()

  const conversations = useTeamStore(s => s.conversations)
  const epochs = useTeamStore(s => s.epochs)
  const activeFlows = useTeamStore(s => s.activeFlows)
  const loadEpochBoard = useTeamStore(s => s.loadEpochBoard)
  const isPaused = useTeamStore(s => s.officeLiveness.get(detail.team.id) === 'paused')

  const [panelOpen, setPanelOpen] = useState(!isMobile)

  const liveRunId = detail.team.currentEpochId
  // Default focus: the live run, else the most recent run (replay). Never an
  // unlabeled graph — you always know what you're looking at (§6.3).
  const focused = focusedEpochId ?? liveRunId ?? epochs[0]?.id ?? null

  const isLiveRun = !!focused && focused === liveRunId
  const focusedConversation = useMemo<TeamConversation | null>(
    () => conversations.find(c => c.epochId === focused) ?? null,
    [conversations, focused]
  )
  const isPastRun = !!focused && !isLiveRun && !focusedConversation

  // Anything other than the live run needs its board fetched by id: the team
  // detail carries ONE epoch's board (the open run, else the latest), so a
  // conversation's own tasks and findings are simply not in it.
  const [epochBoard, setEpochBoard] = useState<EpochBoard | null>(null)
  const [loadingBoard, setLoadingBoard] = useState(false)
  useEffect(() => {
    if (isLiveRun || !focused) { setEpochBoard(null); return }
    let cancelled = false
    setLoadingBoard(true)
    void loadEpochBoard(detail.team.id, focused).then(b => {
      if (cancelled) return
      setEpochBoard(b)
      setLoadingBoard(false)
    })
    return () => { cancelled = true }
  }, [isLiveRun, focused, detail.team.id, loadEpochBoard])

  // detail.tasks/findings accumulate live board writes for whichever epoch is
  // open (the backend's single-epoch scope, plus any real-time team:blackboard
  // pushes since) — scope them to the focused event so a conversation's own
  // tasks/findings render instead of being silently dropped.
  const focusedTasks = useMemo(() => detail.tasks.filter(tk => tk.epochId === focused), [detail.tasks, focused])
  const focusedFindings = useMemo(() => detail.findings.filter(f => f.epochId === focused), [detail.findings, focused])
  const focusedActivities = useMemo(
    () => (detail.activities ?? []).filter(a => a.epochId === focused),
    [detail.activities, focused]
  )

  // The board the left column renders, computed from the focused event.
  const board = useMemo<BoardView>(() => {
    if (isLiveRun && focused) {
      return {
        mode: 'live', epochId: focused,
        roster: detail.roster, edges: detail.edges, tasks: focusedTasks, findings: focusedFindings,
        activities: focusedActivities,
        live: { status: detail.team.status },
      }
    }
    if (focusedConversation) {
      // A conversation can post board tasks/findings too (team_post_task /
      // team_post_finding are not restricted to run epochs) — its "activity" is
      // both those writes and the live stream of whoever is working it. The
      // fetched board is the snapshot; live pushes that landed since override it.
      return {
        mode: 'live', epochId: focused, kind: 'conversation',
        roster: detail.roster, edges: detail.edges,
        tasks: mergeById(epochBoard?.tasks ?? [], focusedTasks),
        findings: mergeById(epochBoard?.findings ?? [], focusedFindings),
        activities: mergeById(epochBoard?.activities ?? [], focusedActivities),
        live: { status: focusedConversation.active ? 'running' : 'idle' },
      }
    }
    if (isPastRun && epochBoard) {
      const roster = replayRoster(epochBoard.members, detail.roster)
      return {
        mode: 'replay', epochId: focused,
        kind: epochBoard.epoch.lifecycle === 'conversation' ? 'conversation' : 'run',
        roster, edges: detail.edges, tasks: epochBoard.tasks, findings: epochBoard.findings,
        activities: epochBoard.activities ?? [],
        replay: {
          startedAt: epochBoard.epoch.startedAt,
          triggerType: epochBoard.epoch.triggerType,
          outcome: epochBoard.epoch.outcome,
          summary: epochBoard.epoch.summary,
        },
      }
    }
    // Idle / loading: rest on the team structure (a calm org shape).
    return {
      mode: 'live', epochId: null,
      roster: detail.roster, edges: detail.edges, tasks: [], findings: [], activities: [],
      live: { status: liveRunId ? detail.team.status : 'idle' },
    }
  }, [isLiveRun, focusedConversation, isPastRun, epochBoard, focused, detail, liveRunId, focusedTasks, focusedFindings, focusedActivities])

  const header = useMemo(() => {
    if (isLiveRun) {
      // Stable time · trigger identity; liveness is the pulse, not the title.
      return { Icon: Zap, label: runEventTitle(epochs.find(e => e.id === liveRunId), t), live: true }
    }
    if (focusedConversation) {
      return { Icon: MessageSquare, label: conversationLabel(focusedConversation, t), live: !!focusedConversation.active }
    }
    if (isPastRun) {
      const summary = epochs.find(x => x.id === focused)
      // A CLOSED conversation lands here too (it left the open list), and it is
      // still a named thing — showing it as "time · trigger" presents a chat as
      // a run that never happened.
      if (summary?.lifecycle === 'conversation') {
        return { Icon: MessageSquare, label: epochLabel(summary, t), live: false }
      }
      const e = epochBoard?.epoch ?? summary
      const when = e ? formatRunTime(e.startedAt) : ''
      const trig = triggerLabel(e?.triggerType, t)
      return { Icon: History, label: when ? `${when} · ${trig}` : t('Past run'), live: false }
    }
    return { Icon: History, label: t('Team structure'), live: false }
  }, [isLiveRun, focusedConversation, isPastRun, epochBoard, epochs, focused, liveRunId, detail.team.status, t])

  // Run status / outcome, folded into the single header line (the standalone
  // banner is gone). `toneClass` is a text color reused for the dot via
  // `bg-current`. A quietly-viewed conversation carries no status word.
  const isJoined = detail.team.hostNodeId != null
  const status = useMemo<{ word: string; toneClass: string; pulse: boolean } | null>(() => {
    if (board.mode === 'replay' && board.replay) {
      const { cls, label } = outcomeMeta(board.replay.outcome ?? 'no_action', null, t)
      return { word: label, toneClass: cls, pulse: false }
    }
    if (isPaused) return { word: t('Resting'), toneClass: 'text-muted-foreground', pulse: false }
    switch (board.live?.status ?? 'idle') {
      case 'running': return { word: t('Running'), toneClass: 'text-emerald-500', pulse: true }
      case 'waiting_user': {
        // A joined office mirrors the host's status, so "blocked on a decision"
        // says nothing about WHOSE. The roster does: only when one of our own
        // members raised it is this the reader's move.
        if (board.roster.some(awaitsOurDecision)) {
          return { word: t('Waiting for you'), toneClass: 'text-amber-500', pulse: false }
        }
        const blocked = board.roster.find(m => m.status === 'waiting_user')
        const owner = blocked?.owner || t('a teammate')
        return {
          word: t('Waiting on {{owner}}', { owner }),
          toneClass: 'text-muted-foreground',
          pulse: false,
        }
      }
      case 'error': return { word: t('Stopped'), toneClass: 'text-red-500', pulse: false }
      default:
        return focusedConversation
          ? null
          : { word: isJoined ? t('Ready') : t('Idle'), toneClass: 'text-muted-foreground', pulse: false }
    }
  }, [board, isPaused, isJoined, focusedConversation, t])

  return (
    <div className="flex h-full overflow-hidden">
      {/* Board column */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-11 flex-shrink-0 items-center gap-2 border-b border-border px-3 sm:px-6">
          <span className="hidden text-xs text-muted-foreground sm:inline">{t('Viewing:')}</span>
          <header.Icon className={`h-3.5 w-3.5 flex-shrink-0 ${header.live ? 'text-emerald-500' : 'text-muted-foreground'}`} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{header.label}</span>
          {status && (
            <span className="flex flex-shrink-0 items-center gap-1.5">
              <span className="relative flex h-1.5 w-1.5">
                {status.pulse && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60 ${status.toneClass}`} />}
                <span className={`relative inline-flex h-1.5 w-1.5 rounded-full bg-current ${status.toneClass}`} />
              </span>
              <span className={`text-xs font-medium ${status.toneClass}`}>{status.word}</span>
            </span>
          )}
          <button
            onClick={() => setPanelOpen(v => !v)}
            className={`flex-shrink-0 rounded-md p-1.5 transition-colors ${panelOpen ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary'}`}
            title={t('Events')}
          >
            <PanelRight className="h-4 w-4" />
          </button>
        </div>

        <div className="relative flex-1 overflow-y-auto">
          {loadingBoard && !epochBoard && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}
          <StatusBoard
            detail={detail}
            board={board}
            activeFlows={activeFlows}
            onSelectMember={onSelectMember}
            editingStructure={editingStructure}
            onExitEditing={onExitEditing}
          />
        </div>
      </div>

      {/* Event sidebar */}
      {panelOpen && (
        <div className="fixed inset-0 z-50 bg-background sm:relative sm:inset-auto sm:z-auto sm:w-64 sm:flex-shrink-0 sm:border-l sm:border-border">
          <EventSidebar
            detail={detail}
            conversations={conversations}
            epochs={epochs}
            selectedEpochId={focused}
            onSelect={(epochId) => { onFocus(epochId); if (isMobile) setPanelOpen(false) }}
            onClose={() => setPanelOpen(false)}
          />
        </div>
      )}
    </div>
  )
}
