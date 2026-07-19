/**
 * ConversationTab — "talk to the team" (spec §6.1/§6.2, the default landing tab).
 *
 * Left: the active conversation, rendered by the shared {@link TeamSessionChat}.
 * Right: the office's conversation list ({@link TeamSessionPanel}), collapsible
 * on desktop and a full-screen drawer on mobile.
 *
 * "Talking to the team" = talking to the LEAD (front desk): the lead answers and
 * dispatches internally. A member direct thread targets that teammate instead.
 * IM chats are read-only here (they are answered in the IM app).
 */

import { useMemo, useState } from 'react'
import { PanelRight, Zap, MessageSquarePlus, Radar } from 'lucide-react'
import { useTeamStore, useMemberPresence } from '../../stores/team.store'
import { useAppsStore } from '../../stores/apps.store'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useTranslation } from '../../i18n'
import { TeamSessionChat } from './TeamSessionChat'
import { TeamSessionPanel } from './TeamSessionPanel'
import { conversationLabel } from './run-history'
import type { TeamDetail, TeamConversation } from '../../../shared/apps/team-types'

interface ConversationTabProps {
  detail: TeamDetail
  /** Jump to the Live tab focused on a specific event (the active-door card). */
  onOpenLive: (epochId: string) => void
}

export function ConversationTab({ detail, onOpenLive }: ConversationTabProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const team = detail.team

  const conversations = useTeamStore(s => s.conversations)
  const selectedId = useTeamStore(s => s.selectedConversationId)

  const [panelOpen, setPanelOpen] = useState(!isMobile)

  const selected = useMemo<TeamConversation | null>(
    () => conversations.find(c => c.epochId === selectedId) ?? null,
    [conversations, selectedId]
  )

  return (
    <div className="flex h-full overflow-hidden">
      {/* Chat column */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-2 sm:px-4">
          <MessageSquarePlus className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {selected ? conversationLabel(selected, t) : t('Conversation')}
          </span>
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
          <ConversationChat detail={detail} conversation={selected} onOpenLive={onOpenLive} />
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

function ConversationChat({ detail, conversation, onOpenLive }: {
  detail: TeamDetail
  /** null = a draft native session (lazily created on first send). */
  conversation: TeamConversation | null
  onOpenLive: (epochId: string) => void
}) {
  const { t } = useTranslation()
  const apps = useAppsStore(s => s.apps)
  const openConversation = useTeamStore(s => s.openConversation)

  // Target: a member thread speaks to that teammate; a draft or any other
  // conversation speaks to the LEAD (the front desk that answers + dispatches).
  const targetAppId = conversation?.kind === 'member' && conversation.memberAppId
    ? conversation.memberAppId
    : detail.team.leadAppId
  const targetMember = detail.roster.find(m => m.appId === targetAppId) ?? null
  const presence = useMemberPresence(detail.team.id, targetAppId ?? '')

  const spaceId = apps.find(a => a.id === targetAppId)?.spaceId ?? targetMember?.spaceId ?? ''
  const epochId = conversation?.epochId ?? null

  // Active-door card (C3): how many teammates are working this very event.
  const busyCount = useMemo(
    () => epochId ? detail.roster.filter(m => (m.busy ?? []).some(b => b.epochId === epochId)).length : 0,
    [detail.roster, epochId]
  )

  if (!targetAppId || !targetMember) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {t('This office needs a lead before you can talk to the team.')}
      </div>
    )
  }

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
      placeholder={t('Message the team…')}
      emptyTitle={t('Say something to the team.')}
      emptyHint={t('The lead will line up digital humans to do it.')}
      topSlot={imNotice}
      aboveInput={activeDoor}
      // Draft: create + select the conversation on the first message.
      ensureEpochId={epochId ? undefined : () => openConversation(detail.team.id)}
    />
  )
}
