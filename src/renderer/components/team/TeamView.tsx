/**
 * TeamView — right pane of the team tab.
 *
 * Header: team name (read-only) + goal preview (click → Settings) + Run/Pause
 * + settings gear. Body: Status / History / Settings tab switch.
 *
 * All configuration (goal, schedule, collaboration, members, dissolve) lives in
 * the Settings tab — no overflow "..." menu.  The member detail panel renders as
 * a right-side overlay (full-screen sheet on mobile, side panel on desktop).
 */

import { useEffect, useState } from 'react'
import { Play, Pause, Cog, LayoutGrid, History, Network, UserPlus, Eye } from 'lucide-react'
import type { TeamDetail, RosterMember } from '../../../shared/apps/team-types'
import { useTeamStore } from '../../stores/team.store'
import { useTranslation } from '../../i18n'
import { StatusBoard } from './StatusBoard'
import { TeamMemberChatView } from './TeamMemberChatView'
import { HistoryTab } from './HistoryTab'
import { SettingsTab } from './SettingsTab'
import { TeamInviteDialog } from './TeamInviteDialog'

type BoardTab = 'status' | 'history' | 'settings'

interface TeamViewProps {
  detail: TeamDetail
}

export function TeamView({ detail }: TeamViewProps) {
  const { t } = useTranslation()
  const team = detail.team

  const activeFlows = useTeamStore(s => s.activeFlows)
  const loadDetail = useTeamStore(s => s.loadDetail)
  const epochs = useTeamStore(s => s.epochs)
  const runTeam = useTeamStore(s => s.runTeam)
  const pauseTeam = useTeamStore(s => s.pauseTeam)

  const [tab, setTab] = useState<BoardTab>('status')
  const [selectedMember, setSelectedMember] = useState<RosterMember | null>(null)
  const [chatEpochId, setChatEpochId] = useState<string | null>(null)
  const [editingStructure, setEditingStructure] = useState(false)
  const [showInvite, setShowInvite] = useState(false)

  const liveEpochId = team.currentEpochId ?? epochs[0]?.id ?? null

  const openMemberLive = (m: RosterMember) => { setChatEpochId(liveEpochId); setSelectedMember(m) }
  const openMemberForEpoch = (m: RosterMember, epochId: string) => { setChatEpochId(epochId); setSelectedMember(m) }

  // Poll detail while running so the status board feels alive.
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

  return (
    <div className="relative flex h-full overflow-hidden">
      {/* Main column */}
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
              {/* Edit collaboration structure — contextual to the Status board it edits. */}
              {tab === 'status' && (
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
                onClick={() => isRunning ? pauseTeam(team.id) : runTeam(team.id)}
                className="flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm text-foreground transition-colors hover:bg-secondary"
                title={isRunning ? t('Pause') : t('Run')}
              >
                {isRunning ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                <span className="hidden sm:inline">{isRunning ? t('Pause') : t('Run')}</span>
              </button>
            </>
          )}

        </div>

        {/* ── Tab bar (matches the digital-human header: icon + underline) ── */}
        <div className="flex items-center gap-0.5 border-b border-border px-3 sm:px-4">
          <TabButton active={tab === 'status'} icon={LayoutGrid} label={t('Status')} onClick={() => setTab('status')} />
          <TabButton active={tab === 'history'} icon={History} label={t('History')} onClick={() => setTab('history')} />
          <TabButton active={tab === 'settings'} icon={Cog} label={t('Settings')} onClick={() => setTab('settings')} />
        </div>

        {/* ── Tab content ─────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">
          {tab === 'status' && (
            <StatusBoard
              detail={detail}
              activeFlows={activeFlows}
              onSelectMember={openMemberLive}
              editingStructure={editingStructure && !isJoined}
              onExitEditing={() => setEditingStructure(false)}
            />
          )}
          {tab === 'history' && <HistoryTab detail={detail} onOpenMember={openMemberForEpoch} />}
          {tab === 'settings' && <SettingsTab detail={detail} />}
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
            />
          </div>
        </div>
      )}

      {showInvite && <TeamInviteDialog teamId={team.id} onClose={() => setShowInvite(false)} />}
    </div>
  )
}

// ──────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────

function TabButton({ active, icon: Icon, label, onClick }: {
  active: boolean
  icon: typeof LayoutGrid
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
