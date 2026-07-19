/**
 * TeamView — the right pane of the team tab (spec §6.1 framework).
 *
 * Header: name + goal preview + Invite/Run/settings. A cross-tab attention
 * banner (C2) sits above the tab bar so a waiting decision follows the user
 * everywhere. Tabs: Conversation (default) / Live / Settings.
 *
 * The Live tab is the team's canonical view — one unit of work at a time (a live run, a
 * conversation, or a past-run replay), picked from its event sidebar. It absorbs
 * what used to be a separate History tab: selecting + viewing happen in one place.
 *
 * Behaviors:
 *  - D1: pressing Run auto-switches to Live to watch the launch.
 *  - C2: any pending decision surfaces the banner regardless of tab.
 * The member detail panel renders as a right-side overlay.
 */

import { useEffect, useState } from 'react'
import { Play, Pause, Cog, MessagesSquare, Radar, Network, UserPlus, Eye } from 'lucide-react'
import type { TeamDetail, RosterMember } from '../../../shared/apps/team-types'
import { useTeamStore } from '../../stores/team.store'
import { useTranslation } from '../../i18n'
import { LiveTab } from './LiveTab'
import { ConversationTab } from './ConversationTab'
import { AttentionBanner } from './AttentionBanner'
import { TeamMemberChatView } from './TeamMemberChatView'
import { SettingsTab } from './SettingsTab'
import { TeamInviteDialog } from './TeamInviteDialog'

type BoardTab = 'conversation' | 'live' | 'settings'

interface TeamViewProps {
  detail: TeamDetail
}

export function TeamView({ detail }: TeamViewProps) {
  const { t } = useTranslation()
  const team = detail.team

  const loadDetail = useTeamStore(s => s.loadDetail)
  const epochs = useTeamStore(s => s.epochs)
  const runTeam = useTeamStore(s => s.runTeam)
  const pauseTeam = useTeamStore(s => s.pauseTeam)

  const [tab, setTab] = useState<BoardTab>('conversation')
  const [selectedMember, setSelectedMember] = useState<RosterMember | null>(null)
  const [chatEpochId, setChatEpochId] = useState<string | null>(null)
  const [editingStructure, setEditingStructure] = useState(false)
  const [showInvite, setShowInvite] = useState(false)
  // The unit of work the Live tab is focused on (a live run, a conversation, or a
  // past run). null = default (live run, else the most recent run).
  const [focusedEpochId, setFocusedEpochId] = useState<string | null>(null)

  const liveEpochId = team.currentEpochId ?? epochs[0]?.id ?? null

  // A member opened from the Live board binds to whatever item is focused there
  // (so a past-run member opens that run's transcript, not the live one).
  const openMemberLive = (m: RosterMember) => { setChatEpochId(focusedEpochId ?? liveEpochId); setSelectedMember(m) }

  // Poll detail while running so the floor feels alive.
  useEffect(() => {
    if (team.status !== 'running') return
    const id = setInterval(() => { void loadDetail(team.id) }, 3000)
    return () => clearInterval(id)
  }, [team.status, team.id, loadDetail])

  // Re-sync selected member with the latest roster; drop if removed.
  useEffect(() => {
    if (!selectedMember) return
    const fresh = detail.roster.find(m => m.appId === selectedMember.appId)
    setSelectedMember(fresh ?? null)
  }, [detail.roster]) // eslint-disable-line react-hooks/exhaustive-deps

  const isRunning = team.status === 'running'
  const overlayOpen = !!selectedMember
  // Gates every authority-only control (run/edit/invite) — a joined office is watch-only.
  const isJoined = team.hostNodeId != null
  const pending = detail.pendingEscalations ?? []

  // D1: pressing Run jumps to Live to watch the launch (a scheduled run does not
  // steal focus — that path never calls this).
  const handleRun = async () => {
    const ok = await runTeam(team.id)
    if (ok) {
      setFocusedEpochId(null)
      setTab('live')
    }
  }

  // The attention banner opens the member's chat wherever the user is (C2).
  const goToDecision = (appId: string) => {
    const m = detail.roster.find(r => r.appId === appId)
    if (m) openMemberLive(m)
  }

  // Jump to Live focused on a specific item (from the conversation active-door
  // card, or the "Live" entry). An empty id means "no specific event" → Live
  // falls back to its default focus (the live run, else the most recent run).
  const openLiveFocused = (epochId: string) => {
    setFocusedEpochId(epochId || null)
    setTab('live')
  }

  return (
    <div className="relative flex h-full overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* ── Header ──────────────────────────────────── */}
        <div className="flex items-start gap-2 border-b border-border px-3 py-3 sm:px-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-medium text-foreground">{team.name}</h2>
              {isJoined && (
                <span className="flex flex-shrink-0 items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
                  <Eye className="h-3 w-3" />
                  {t('Joined office')}
                </span>
              )}
            </div>
            <button
              onClick={() => setTab('settings')}
              className="mt-0.5 line-clamp-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
              title={t('Edit in Settings')}
            >
              {team.goal}
            </button>
          </div>

          {!isJoined && (
            <>
              {tab === 'live' && (
                <button
                  onClick={() => setEditingStructure(v => !v)}
                  className={`flex-shrink-0 rounded-lg border p-1.5 transition-colors ${
                    editingStructure
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-secondary hover:text-foreground'
                  }`}
                  title={t('Edit collaboration structure')}
                >
                  <Network className="h-4 w-4" />
                </button>
              )}

              <button
                onClick={() => setShowInvite(true)}
                className="flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm text-foreground transition-colors hover:bg-secondary"
                title={t('Invite')}
              >
                <UserPlus className="h-4 w-4" />
                <span className="hidden sm:inline">{t('Invite')}</span>
              </button>

              <button
                onClick={() => isRunning ? void pauseTeam(team.id) : void handleRun()}
                className="flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm text-foreground transition-colors hover:bg-secondary"
                title={isRunning ? t('Pause') : t('Run')}
              >
                {isRunning ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                <span className="hidden sm:inline">{isRunning ? t('Pause') : t('Run')}</span>
              </button>
            </>
          )}
        </div>

        {/* ── Attention chain banner (C2): rides above the tabs on every tab ── */}
        <AttentionBanner pending={pending} onGoTo={goToDecision} />

        {/* ── Tab bar ──────────────────────────────────── */}
        <div className="flex items-center gap-0.5 border-b border-border px-3 sm:px-4">
          <TabButton active={tab === 'conversation'} icon={MessagesSquare} label={t('Conversation')} onClick={() => setTab('conversation')} />
          <TabButton active={tab === 'live'} icon={Radar} label={t('Live')} onClick={() => setTab('live')} />
          <TabButton active={tab === 'settings'} icon={Cog} label={t('Settings')} onClick={() => setTab('settings')} />
        </div>

        {/* ── Tab content ─────────────────────────────── */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {tab === 'conversation' && (
            <ConversationTab detail={detail} onOpenLive={openLiveFocused} />
          )}
          {tab === 'live' && (
            <LiveTab
              detail={detail}
              onSelectMember={openMemberLive}
              editingStructure={editingStructure && !isJoined}
              onExitEditing={() => setEditingStructure(false)}
              focusedEpochId={focusedEpochId}
              onFocus={setFocusedEpochId}
            />
          )}
          {tab === 'settings' && (
            <div className="flex-1 overflow-y-auto">
              <SettingsTab detail={detail} />
            </div>
          )}
        </div>
      </div>

      {/* ── Right overlay: member work surface ────────── */}
      {overlayOpen && selectedMember && (
        <div className="absolute inset-0 z-20 flex justify-end">
          <div
            className="absolute inset-0 animate-fade-in bg-black/30 backdrop-blur-[1px]"
            onClick={() => setSelectedMember(null)}
          />
          <div className="relative h-full w-full animate-slide-in-right border-l border-border bg-background shadow-2xl sm:w-[34rem] sm:max-w-[60%]">
            <TeamMemberChatView
              member={selectedMember}
              teamId={team.id}
              epochId={chatEpochId}
              isCurrentEpoch={!!chatEpochId && chatEpochId === team.currentEpochId}
              onClose={() => setSelectedMember(null)}
              onSwitchContext={setChatEpochId}
            />
          </div>
        </div>
      )}

      {showInvite && <TeamInviteDialog teamId={team.id} onClose={() => setShowInvite(false)} />}
    </div>
  )
}

function TabButton({ active, icon: Icon, label, onClick }: {
  active: boolean
  icon: typeof Radar
  label: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 border-b-2 -mb-px px-3 py-2 text-xs font-medium transition-colors ${active
        ? 'border-foreground text-foreground'
        : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  )
}
