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
import { useTeamStore } from '../../stores/team.store'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useTranslation } from '../../i18n'
import { StatusBoard, type BoardView } from './StatusBoard'
import { EventSidebar } from './EventSidebar'
import { triggerLabel, formatRunTime, runEventTitle, conversationLabel } from './run-history'

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

  // Replay: load the selected past run's recorded board.
  const [pastBoard, setPastBoard] = useState<EpochBoard | null>(null)
  const [loadingPast, setLoadingPast] = useState(false)
  useEffect(() => {
    if (!isPastRun || !focused) { setPastBoard(null); return }
    let cancelled = false
    setLoadingPast(true)
    void loadEpochBoard(detail.team.id, focused).then(b => {
      if (cancelled) return
      setPastBoard(b)
      setLoadingPast(false)
    })
    return () => { cancelled = true }
  }, [isPastRun, focused, detail.team.id, loadEpochBoard])

  // The board the left column renders, computed from the focused event.
  const board = useMemo<BoardView>(() => {
    if (isLiveRun && focused) {
      return {
        mode: 'live', epochId: focused,
        roster: detail.roster, edges: detail.edges, tasks: detail.tasks, findings: detail.findings,
        live: { status: detail.team.status },
      }
    }
    if (focusedConversation) {
      // A conversation has no board tasks; its "activity" is the live stream of
      // whoever is working it (the topology pulses those members).
      return {
        mode: 'live', epochId: focused,
        roster: detail.roster, edges: detail.edges, tasks: [], findings: [],
        live: { status: focusedConversation.active ? 'running' : 'idle' },
      }
    }
    if (isPastRun && pastBoard) {
      const roster: RosterMember[] = pastBoard.members.map(m => ({
        appId: m.appId, memberName: m.memberName, role: m.role, isLead: m.isLead, spaceId: null, status: 'idle' as const,
      }))
      return {
        mode: 'replay', epochId: focused,
        roster, edges: detail.edges, tasks: pastBoard.tasks, findings: pastBoard.findings,
        replay: {
          startedAt: pastBoard.epoch.startedAt,
          triggerType: pastBoard.epoch.triggerType,
          outcome: pastBoard.epoch.outcome,
          summary: pastBoard.epoch.summary,
        },
      }
    }
    // Idle / loading: rest on the team structure (a calm org shape).
    return {
      mode: 'live', epochId: null,
      roster: detail.roster, edges: detail.edges, tasks: [], findings: [],
      live: { status: liveRunId ? detail.team.status : 'idle' },
    }
  }, [isLiveRun, focusedConversation, isPastRun, pastBoard, focused, detail, liveRunId])

  const header = useMemo(() => {
    if (isLiveRun) {
      // Stable time · trigger identity; liveness is the pulse, not the title.
      return { Icon: Zap, label: runEventTitle(epochs.find(e => e.id === liveRunId), t), live: true }
    }
    if (focusedConversation) {
      return { Icon: MessageSquare, label: conversationLabel(focusedConversation, t), live: !!focusedConversation.active }
    }
    if (isPastRun) {
      const e = pastBoard?.epoch ?? epochs.find(x => x.id === focused)
      const when = e ? formatRunTime(e.startedAt) : ''
      const trig = triggerLabel(e?.triggerType, t)
      return { Icon: History, label: when ? `${when} · ${trig}` : t('Past run'), live: false }
    }
    return { Icon: History, label: t('Team structure'), live: false }
  }, [isLiveRun, focusedConversation, isPastRun, pastBoard, epochs, focused, liveRunId, detail.team.status, t])

  return (
    <div className="flex h-full overflow-hidden">
      {/* Board column */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-2 sm:px-4">
          <span className="text-xs text-muted-foreground">{t('Viewing:')}</span>
          <header.Icon className={`h-3.5 w-3.5 flex-shrink-0 ${header.live ? 'text-emerald-500' : 'text-muted-foreground'}`} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{header.label}</span>
          {header.live && <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-emerald-500" />}
          <button
            onClick={() => setPanelOpen(v => !v)}
            className={`flex-shrink-0 rounded-md p-1.5 transition-colors ${panelOpen ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary'}`}
            title={t('Events')}
          >
            <PanelRight className="h-4 w-4" />
          </button>
        </div>

        <div className="relative flex-1 overflow-y-auto">
          {loadingPast && !pastBoard && (
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
