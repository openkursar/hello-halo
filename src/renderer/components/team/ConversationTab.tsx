/**
 * ConversationTab — "talk to the team" (the default landing tab).
 *
 * Left: the active conversation, rendered by the shared {@link TeamSessionChat}.
 * Right: the office's conversation list ({@link TeamSessionPanel}), collapsible
 * on desktop and a full-screen drawer on mobile.
 *
 * Talking to the team starts with YOUR OWN digital human — the one you brought
 * in, which knows you and can go negotiate with the rest. You can hand the
 * conversation to a different one of yours from the header, and that choice
 * sticks. A member direct thread targets that teammate instead, and an IM chat
 * is read-only here (it is answered in the IM app).
 */

import { useEffect, useMemo, useState } from 'react'
import { PanelRight, Zap, MessageSquarePlus, Radar, Bot, ChevronDown, Check } from 'lucide-react'
import { useTeamStore, useMemberPresence } from '../../stores/team.store'
import { useDefaultChatTarget, useTeamViewPrefsStore } from '../../stores/team-view-prefs.store'
import { useAppsStore } from '../../stores/apps.store'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useTranslation } from '../../i18n'
import { TeamSessionChat } from './TeamSessionChat'
import { TeamSessionPanel } from './TeamSessionPanel'
import { conversationLabel } from './run-history'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/Popover'
import type { TeamDetail, TeamConversation, TeamMember } from '../../../shared/apps/team-types'
import { isRemoteMember } from '../../../shared/apps/team-types'

interface ConversationTabProps {
  detail: TeamDetail
  /** Jump to the Live tab focused on a specific event (the active-door card). */
  onOpenLive: (epochId: string) => void
}

/**
 * The digital humans this conversation can be handed to: the ones running on
 * THIS machine, still installed. The lead is no exception — it qualifies only
 * when it runs here; a teammate's answers to its own owner and is reached from
 * its own thread.
 *
 * The installed check matters because a member row can outlive its app
 * (uninstalled, profile reset), and pointing the chat at one of those produces a
 * send that fails silently.
 */
function useOwnChatTargets(detail: TeamDetail): TeamMember[] {
  const apps = useAppsStore(s => s.apps)
  return useMemo(() => {
    const installed = new Set(apps.map(a => a.id))
    return detail.members.filter(m => !isRemoteMember(m) && installed.has(m.appId))
  }, [apps, detail.members])
}

export function ConversationTab({ detail, onOpenLive }: ConversationTabProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const team = detail.team

  const conversations = useTeamStore(s => s.conversations)
  const selectedId = useTeamStore(s => s.selectedConversationId)
  const setDefaultMember = useTeamViewPrefsStore(s => s.setDefaultMember)

  const [panelOpen, setPanelOpen] = useState(!isMobile)

  const selected = useMemo<TeamConversation | null>(
    () => conversations.find(c => c.epochId === selectedId) ?? null,
    [conversations, selectedId]
  )

  const own = useOwnChatTargets(detail)
  const ownAppIds = useMemo(() => own.map(m => m.appId), [own])
  const defaultTarget = useDefaultChatTarget(team.id, ownAppIds)

  // A member thread is bound to its teammate; anything else goes to your pick.
  const boundTarget = selected?.kind === 'member' ? selected.memberAppId ?? null : null
  const targetAppId = boundTarget ?? defaultTarget
  const targetMember = detail.roster.find(m => m.appId === targetAppId) ?? null

  // Opening one of your own threads is also a way of choosing who you talk to.
  useEffect(() => {
    if (boundTarget && ownAppIds.includes(boundTarget)) setDefaultMember(team.id, boundTarget)
  }, [boundTarget, ownAppIds, team.id, setDefaultMember])

  return (
    <div className="flex h-full overflow-hidden">
      {/* Chat column */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-2 sm:px-4">
          <MessageSquarePlus className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {selected ? conversationLabel(selected, t) : t('Conversation')}
          </span>
          {!boundTarget && targetMember && (
            <TargetPicker
              own={own}
              currentAppId={targetAppId}
              currentName={targetMember.memberName}
              onPick={appId => setDefaultMember(team.id, appId)}
            />
          )}
          {/* Jump to the Live view — the team's canonical "watch them work" tab.
              Focused on this conversation when one is open, else the live run. */}
          <button
            onClick={() => onOpenLive(selected?.epochId ?? '')}
            className="flex flex-shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            title={t('Watch the team work on the floor')}
          >
            <Radar className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t('Live')}</span>
          </button>
          <button
            onClick={() => setPanelOpen(v => !v)}
            className={`flex-shrink-0 rounded-md p-1.5 transition-colors ${panelOpen ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary'}`}
            title={t('Conversations')}
          >
            <PanelRight className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          {/* Always a ready chat — no "click New session" gate. With nothing
              selected we render a DRAFT that creates the conversation on first
              send (parity with the space chat's type-first experience). */}
          <ConversationChat
            detail={detail}
            conversation={selected}
            targetAppId={targetAppId}
            targetMember={targetMember}
            onOpenLive={onOpenLive}
          />
        </div>
      </div>

      {/* Session sidebar */}
      {panelOpen && (
        <div className="fixed inset-0 z-50 bg-background sm:relative sm:inset-auto sm:z-auto sm:w-64 sm:flex-shrink-0 sm:border-l sm:border-border">
          <TeamSessionPanel teamId={team.id} onClose={() => setPanelOpen(false)} />
        </div>
      )}
    </div>
  )
}

/** Hand the conversation to a different digital human of yours. */
function TargetPicker({ own, currentAppId, currentName, onPick }: {
  own: TeamMember[]
  currentAppId: string | null
  currentName: string
  onPick: (appId: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  if (own.length < 2) return null

  const choose = (appId: string) => {
    onPick(appId)
    setOpen(false)
  }

  const row = (member: TeamMember) => (
    <button
      key={member.appId}
      onClick={() => choose(member.appId)}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-secondary"
    >
      <Check className={`h-3.5 w-3.5 flex-shrink-0 ${member.appId === currentAppId ? 'text-primary' : 'invisible'}`} />
      <span className="min-w-0 flex-1 truncate">{member.memberName}</span>
    </button>
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-secondary"
        title={t('Choose which of your digital humans to talk to')}
      >
        <Bot className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="max-w-[6rem] truncate sm:max-w-[10rem]">{currentName}</span>
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        {own.map(m => row(m))}
      </PopoverContent>
    </Popover>
  )
}

function ConversationChat({ detail, conversation, targetAppId, targetMember, onOpenLive }: {
  detail: TeamDetail
  /** null = a draft native session (lazily created on first send). */
  conversation: TeamConversation | null
  targetAppId: string | null
  targetMember: TeamDetail['roster'][number] | null
  onOpenLive: (epochId: string) => void
}) {
  const { t } = useTranslation()
  const apps = useAppsStore(s => s.apps)
  const openConversation = useTeamStore(s => s.openConversation)
  const presence = useMemberPresence(detail.team.id, targetAppId ?? '')

  const epochId = conversation?.epochId ?? null

  // Active-door card: how many teammates are working this very event.
  const busyCount = useMemo(
    () => epochId ? detail.roster.filter(m => (m.busy ?? []).some(b => b.epochId === epochId)).length : 0,
    [detail.roster, epochId]
  )

  if (!targetAppId || !targetMember) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {detail.members.some(m => !isRemoteMember(m))
          ? t('The digital humans in this office are no longer installed, so there is nobody here to answer. Add one in Settings.')
          : t('Bring one of your digital humans into this office to start talking.')}
      </div>
    )
  }

  const spaceId = apps.find(a => a.id === targetAppId)?.spaceId ?? targetMember.spaceId ?? ''

  const imNotice = conversation?.readonly ? (
    <div className="mb-3 rounded-lg border border-border bg-secondary/40 px-3 py-2">
      <p className="text-sm text-foreground">
        {t('This is {{who}}\u2019s chat with the team on IM — you can only watch.', { who: conversation.label || t('someone') })}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('The team answers on IM through the lead. To chime in, say it over there.')}
      </p>
    </div>
  ) : null

  const activeDoor = busyCount > 0 && epochId ? (
    <button
      onClick={() => onOpenLive(epochId)}
      className="mb-2 flex w-full items-center gap-2 rounded-lg border border-dashed border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-emerald-500/10"
    >
      <Zap className="h-3.5 w-3.5 flex-shrink-0 text-emerald-500" />
      <span className="flex-1">
        {t('{{count}} digital humans are working on this · view the floor →', { count: busyCount })}
      </span>
    </button>
  ) : null

  return (
    <TeamSessionChat
      appId={targetAppId}
      spaceId={spaceId}
      teamId={detail.team.id}
      epochId={epochId}
      isRemote={presence.isRemote}
      ownerName={presence.ownerName}
      reachability={presence.reachability}
      readonly={conversation?.readonly}
      placeholder={t('Message {{name}}…', { name: targetMember.memberName })}
      emptyTitle={t('Say what you need.')}
      emptyHint={t('{{name}} will bring in whoever else is needed.', { name: targetMember.memberName })}
      topSlot={imNotice}
      aboveInput={activeDoor}
      // Draft: create + select the conversation on the first message.
      ensureEpochId={epochId ? undefined : () => openConversation(detail.team.id)}
    />
  )
}
