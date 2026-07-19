/**
 * TeamMemberChatView — a teammate's live work surface (spec §6.4).
 *
 * The chat engine itself is the shared {@link TeamSessionChat}; this component
 * frames it for a MEMBER: the header (name / owner / presence), the context chip
 * ("Bound to: …" — which run/conversation this side-thread is attached to), the offline
 * banner, and the inline escalation panel. The context is ALWAYS explicit — the
 * message lands in the epoch the chip points at (P0-3), never an implicit "latest".
 */

import { useMemo } from 'react'
import { X, Star, ChevronDown } from 'lucide-react'
import { EscalationPanel } from './EscalationPanel'
import { MemberPresenceChip, OwnerLabel } from './MemberPresenceChip'
import { TeamSessionChat } from './TeamSessionChat'
import { runEventTitle, conversationLabel } from './run-history'
import { useAppsStore } from '../../stores/apps.store'
import { useMemberPresence, useTeamStore } from '../../stores/team.store'
import { useTranslation } from '../../i18n'
import type { RosterMember, TeamMemberRuntimeStatus } from '../../../shared/apps/team-types'

interface TeamMemberChatViewProps {
  member: RosterMember
  teamId: string
  /**
   * The run/conversation (epoch) this side-thread is bound to. Each epoch is an
   * independent transcript, so it fully identifies which history to load. null
   * only when the team has never run and no conversation exists (guided empty).
   */
  epochId: string | null
  /** True when this epoch is the team's live/current run. */
  isCurrentEpoch: boolean
  onClose: () => void
  /** Switch the bound context (the chip dropdown), staying on this member. */
  onSwitchContext?: (epochId: string) => void
}

function statusDot(status: TeamMemberRuntimeStatus): string {
  switch (status) {
    case 'working': return 'bg-emerald-500'
    case 'error': return 'bg-red-500'
    case 'waiting_user': return 'bg-amber-500'
    default: return 'bg-muted-foreground/40'
  }
}

export function TeamMemberChatView({ member, teamId, epochId, isCurrentEpoch, onClose, onSwitchContext }: TeamMemberChatViewProps) {
  const { t } = useTranslation()
  const appId = member.appId
  const appSpaceId = useAppsStore(s => s.apps.find(a => a.id === appId)?.spaceId)
  const spaceId = appSpaceId ?? member.spaceId ?? ''

  const presence = useMemberPresence(teamId, appId)
  const showOwner = presence.isRemote

  // The events this teammate can be spoken to about: the live run + any open
  // conversation it serves. Drives the context chip's dropdown (§6.4).
  const conversations = useTeamStore(s => s.conversations)
  const detail = useTeamStore(s => s.detail)
  const epochs = useTeamStore(s => s.epochs)
  // The live run's stable identity is time · trigger (a run is an event, not a
  // named thing), consistent with the Live tab + event sidebar.
  const runEpochId = detail?.team.currentEpochId
  const runLabel = useMemo(
    () => runEventTitle(epochs.find(e => e.id === runEpochId), t),
    [epochs, runEpochId, t]
  )
  const contextOptions = useMemo(() => {
    const opts: { epochId: string; label: string }[] = []
    if (runEpochId) opts.push({ epochId: runEpochId, label: runLabel })
    for (const c of conversations) {
      // A member's own direct thread + native/IM conversations it participates in.
      if (c.kind === 'member' && c.memberAppId !== appId) continue
      opts.push({ epochId: c.epochId, label: conversationLabel(c, t) })
    }
    return opts
  }, [conversations, detail?.team.currentEpochId, runLabel, appId, t])

  const currentLabel = useMemo(() => {
    const found = contextOptions.find(o => o.epochId === epochId)
    if (found) return found.label
    if (epochId && epochId === detail?.team.currentEpochId) return runLabel
    return t('this session')
  }, [contextOptions, epochId, detail?.team.currentEpochId, runLabel, t])

  const hasContext = !!epochId

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${statusDot(member.status)}`} />
        <div className="flex min-w-0 items-center gap-1.5">
          {member.isLead && <Star className="h-3.5 w-3.5 flex-shrink-0 fill-current text-amber-500" />}
          <span className="truncate text-sm font-medium text-foreground">{member.memberName}</span>
          {member.role && <span className="truncate text-xs text-muted-foreground">· {member.role}</span>}
          {showOwner && (
            <span className="flex min-w-0 items-center gap-1.5">
              <OwnerLabel ownerName={presence.ownerName} />
              <MemberPresenceChip
                reachability={presence.reachability}
                ownerName={presence.ownerName}
                showLabel={presence.reachability !== 'online'}
              />
            </span>
          )}
          {!isCurrentEpoch && epochId && (
            <span className="flex-shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">{t('Past run')}</span>
          )}
        </div>
        <button
          onClick={onClose}
          className="ml-auto flex-shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          title={t('Close')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Context chip (§6.4): what this side-thread is bound to. Everything you
          say here, and the record you see, belong to the selected event. */}
      {hasContext && (
        <div className="flex items-center gap-1.5 border-b border-border px-4 py-1.5">
          <span className="text-xs text-muted-foreground">{t('To:')}</span>
          {contextOptions.length > 1 && onSwitchContext ? (
            <div className="relative">
              <select
                value={epochId ?? ''}
                onChange={(e) => onSwitchContext(e.target.value)}
                className="appearance-none rounded-md border border-border bg-secondary py-0.5 pl-2 pr-6 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                title={t('Everything you say here, and the record you see, belong to the selected event.')}
              >
                {contextOptions.map(o => (
                  <option key={o.epochId} value={o.epochId}>{o.label}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            </div>
          ) : (
            <span
              className="rounded-md bg-secondary px-2 py-0.5 text-xs text-foreground"
              title={t('Everything you say here, and the record you see, belong to the selected event.')}
            >
              {currentLabel}
            </span>
          )}
        </div>
      )}

      {/* No context yet → guide the user to open a fresh session (§6.4). */}
      {!hasContext ? (
        <NoContextGuide member={member} teamId={teamId} onOpened={onSwitchContext} />
      ) : (
        <TeamSessionChat
          appId={appId}
          spaceId={spaceId}
          teamId={teamId}
          epochId={epochId}
          isRemote={presence.isRemote}
          ownerName={presence.ownerName}
          reachability={presence.reachability}
          placeholder={t('Message {{name}}…', { name: member.memberName })}
          emptyTitle={t('No work yet in this team.')}
          emptyHint={t('Run the team, or send a message to this member.')}
        />
      )}

      {/* Escalation (user decision) — surfaced inline when this member awaits a decision. */}
      {member.status === 'waiting_user' && (
        <div className="shrink-0 border-t border-amber-500/30 bg-amber-500/5 p-3">
          <EscalationPanel member={member} teamName="" />
        </div>
      )}
    </div>
  )
}

/** §6.4 empty state: "Open a new session with them?" → creates a visible session. */
function NoContextGuide({ member, teamId, onOpened }: {
  member: RosterMember
  teamId: string
  onOpened?: (epochId: string) => void
}) {
  const { t } = useTranslation()
  const openConversation = useTeamStore(s => s.openConversation)

  const handleStart = async () => {
    // A member direct thread rides the same conversation machinery; opening a
    // native session here gives an immediately-visible, explicitly-bound context.
    const epochId = await openConversation(teamId, t('With {{name}}', { name: member.memberName }))
    if (epochId) onOpened?.(epochId)
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-foreground">
        {t('Start a new session with {{name}}?', { name: member.memberName })}
      </p>
      <p className="max-w-xs text-xs text-muted-foreground">
        {t('It will show up in the Conversations list.')}
      </p>
      <button
        onClick={() => void handleStart()}
        className="rounded-lg bg-primary px-4 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90"
      >
        {t('Start')}
      </button>
    </div>
  )
}
