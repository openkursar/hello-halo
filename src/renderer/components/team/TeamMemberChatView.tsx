/**
 * TeamMemberChatView — a teammate's live work surface.
 *
 * The chat engine itself is the shared {@link TeamSessionChat}; this component
 * frames it for a MEMBER: the header (name / owner / presence), the team
 * identity band (what it is responsible for here, and what is standing over it),
 * and the inline escalation panel.
 *
 * The panel belongs to the piece of work you opened it from, and the message you
 * type lands there — nowhere else. That binding is carried explicitly in the
 * `epochId` prop all the way down to the send; it is deliberately NOT a thing
 * you pick here, because you already picked it by walking in through that door.
 *
 * You can watch anyone's digital human at work. You cannot talk to one that is
 * not yours: it runs on someone else's machine, so the way to get it moving is
 * to ask your own digital human to talk to it.
 */

import { useMemo, useState } from 'react'
import { X, Star, Timer, ChevronRight, Settings } from 'lucide-react'
import { EscalationPanel } from './EscalationPanel'
import { MemberPresenceChip, OwnerLabel } from './MemberPresenceChip'
import { TeamSessionChat } from './TeamSessionChat'
import { useAppsStore } from '../../stores/apps.store'
import { useMemberPresence, useTeamStore, type MemberPresence } from '../../stores/team.store'
import { useTranslation } from '../../i18n'
import { describeRhythm } from './check-format'
import { awaitsOurDecision, checksForMember } from '../../../shared/apps/team-types'
import type { RosterMember, TeamCheckView, TeamMemberRuntimeStatus } from '../../../shared/apps/team-types'

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
  /** Bind a freshly-created conversation, staying on this member. */
  onBindEpoch?: (epochId: string) => void
  onOpenSettings?: () => void
}

function statusDot(status: TeamMemberRuntimeStatus): string {
  switch (status) {
    case 'working': return 'bg-emerald-500'
    case 'error': return 'bg-red-500'
    case 'waiting_user': return 'bg-amber-500'
    default: return 'bg-muted-foreground/40'
  }
}

export function TeamMemberChatView({
  member,
  teamId,
  epochId,
  isCurrentEpoch,
  onClose,
  onBindEpoch,
  onOpenSettings,
}: TeamMemberChatViewProps) {
  const { t } = useTranslation()
  const appId = member.appId
  const appSpaceId = useAppsStore(s => s.apps.find(a => a.id === appId)?.spaceId)
  const spaceId = appSpaceId ?? member.spaceId ?? ''

  const presence = useMemberPresence(teamId, appId)
  const showOwner = presence.isRemote
  const detailChecks = useTeamStore(s => s.detail?.checks)
  const checks = useMemo(
    () => checksForMember(detailChecks ?? [], appId, epochId),
    [detailChecks, appId, epochId]
  )

  const hasContext = !!epochId

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${statusDot(member.status)}`} />
        <div className="flex min-w-0 items-center gap-1.5">
          {member.isLead && <Star className="h-3.5 w-3.5 flex-shrink-0 fill-current text-amber-500" />}
          <span className="truncate text-sm font-medium text-foreground">{member.memberName}</span>
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

      <IdentityBand
        teamId={teamId}
        member={member}
        checks={checks}
        onOpenSettings={onOpenSettings}
      />

      {!hasContext ? (
        <NoContextGuide member={member} teamId={teamId} onOpened={onBindEpoch} />
      ) : (
        <TeamSessionChat
          appId={appId}
          spaceId={spaceId}
          teamId={teamId}
          epochId={epochId}
          isRemote={presence.isRemote}
          ownerName={presence.ownerName}
          reachability={presence.reachability}
          readonly={presence.isRemote}
          readonlyNotice={
            presence.isRemote
              ? t('To get it moving, tell your own digital human and let it do the asking.')
              : undefined
          }
          placeholder={t('Message {{name}}…', { name: member.memberName })}
          emptyTitle={t('No work yet in this team.')}
          emptyHint={t('Run the team, or send a message to this member.')}
        />
      )}

      {/* A pending decision belongs to the person whose digital human raised it.
          On its owner's machine that is an answerable question; anywhere else the
          question itself never left that machine, so the honest thing to show is
          who the office is waiting on. */}
      {member.status === 'waiting_user' && (
        awaitsOurDecision(member) ? (
          <div className="shrink-0 border-t border-amber-500/30 bg-amber-500/5 p-3">
            <EscalationPanel member={member} />
          </div>
        ) : (
          <div className="shrink-0 border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <OwnerDecisionNotice presence={presence} />
          </div>
        )
      )}
    </div>
  )
}

/**
 * Names the person the office is actually waiting on, and — when their machine
 * is away — says so, because that is the difference between "any moment now" and
 * "not until they are back".
 */
function OwnerDecisionNotice({ presence }: { presence: MemberPresence }) {
  const { t } = useTranslation()
  const owner = presence.ownerName || t('its owner')

  return presence.reachability === 'online'
    ? <>{t('{{owner}} needs to answer this one before it can move on.', { owner })}</>
    : <>{t('{{owner}}\u2019s computer is offline, so this decision has to wait for them.', { owner })}</>
}

/**
 * Who this member is inside the team, one line by default: the opening line of
 * its duty, plus a marker when something is standing over it. Expanded, it is
 * the full duty and every periodic check, each stoppable on the spot.
 */
function IdentityBand({ teamId, member, checks, onOpenSettings }: {
  teamId: string
  member: RosterMember
  checks: TeamCheckView[]
  onOpenSettings?: () => void
}) {
  const { t, i18n } = useTranslation()
  const cancelCheck = useTeamStore(s => s.cancelCheck)
  // Open by default when something is standing over this member: the marker on
  // the floor is what brought most people here, so show them what it is.
  const [open, setOpen] = useState(checks.length > 0)

  const duty = member.duty?.trim() ?? ''
  const firstLine = duty ? duty.split('\n')[0] : ''
  const summary = firstLine || t('No duty written yet')

  return (
    <div className="border-b border-border">
      <div className="flex items-center gap-2 px-4 py-1.5">
        <button
          onClick={() => setOpen(v => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className="truncate text-xs text-muted-foreground">{summary}</span>
          {checks.length > 0 && (
            <span className="flex flex-shrink-0 items-center gap-0.5 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <Timer className="h-3 w-3" />
              {checks.length}
            </span>
          )}
          <ChevronRight className={`h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
        </button>
        {onOpenSettings && (
          <button
            onClick={onOpenSettings}
            className="flex-shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            title={t('Settings')}
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div className="space-y-2 px-4 pb-2.5">
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
            {duty || t('Nothing written yet.')}
          </p>
          {checks.map(check => (
            <div key={check.id} className="flex items-start gap-2 rounded-md bg-secondary/50 px-2 py-1.5">
              <Timer className="mt-0.5 h-3 w-3 flex-shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-foreground">
                  {t('{{who}} has it look {{schedule}}: {{what}}', {
                    who: check.createdByMemberName,
                    schedule: describeRhythm(check.schedule, t, i18n.language),
                    what: check.instruction,
                  })}
                </p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {check.reachable
                    ? t('{{count}} rounds so far', { count: check.runCount })
                    : t('Not running: {{owner}}’s computer is offline', {
                        owner: check.targetOwner || t('its owner'),
                      })}
                </p>
              </div>
              <button
                onClick={() => void cancelCheck(teamId, check.id)}
                className="flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                {t('Stop')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Empty state: "Open a new session with them?" → creates a visible session. */
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
