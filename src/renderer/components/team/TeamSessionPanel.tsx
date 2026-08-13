/**
 * TeamSessionPanel — the office's conversation list (spec §6.2 right rail).
 *
 * Mirrors the digital-human `ImSessionPanel` pattern: a scrollable list of
 * sessions with a "New session" action on top. The list is office-shared — the
 * same conversations appear on every node — and mixes native team sessions, IM
 * chats (read-only, badged), and member direct threads. Order: waiting for a
 * decision > actively working > most recent.
 */

import { useState, useCallback } from 'react'
import { Plus, MessageSquare, Users, User, Eraser, Check, X, Pencil } from 'lucide-react'
import { useTeamStore } from '../../stores/team.store'
import { useTranslation } from '../../i18n'
import { conversationLabel } from './run-history'
import type { TeamConversation } from '../../../shared/apps/team-types'

interface TeamSessionPanelProps {
  teamId: string
  onClose?: () => void
}

/**
 * Order: waiting for a decision first, then active, then most recently used.
 * A thread lives for weeks, so creation time buries the one talked to five
 * minutes ago under threads opened long before it.
 */
function sortConversations(list: TeamConversation[]): TeamConversation[] {
  const rank = (c: TeamConversation): number => (c.waitingUser ? 0 : c.active ? 1 : 2)
  return [...list].sort((a, b) => {
    const ra = rank(a), rb = rank(b)
    if (ra !== rb) return ra - rb
    return (b.lastActivityAt || b.startedAt) - (a.lastActivityAt || a.startedAt)
  })
}

export function TeamSessionPanel({ teamId, onClose }: TeamSessionPanelProps) {
  const { t } = useTranslation()
  const conversations = useTeamStore(s => s.conversations)
  const selectedId = useTeamStore(s => s.selectedConversationId)
  const selectConversation = useTeamStore(s => s.selectConversation)
  const openConversation = useTeamStore(s => s.openConversation)

  const sorted = sortConversations(conversations)

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-3 py-2.5">
        <span className="text-sm font-medium">{t('Conversations')}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void openConversation(teamId)}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-secondary"
            title={t('Start a brand-new conversation, separate from the others.')}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('New session')}
          </button>
          {onClose && (
            <button onClick={onClose} className="rounded p-1 transition-colors hover:bg-secondary sm:hidden">
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <p className="text-xs text-muted-foreground/60">
              {t('No conversations yet. Start one to talk to the team.')}
            </p>
          </div>
        ) : (
          sorted.map(c => (
            <ConversationItem
              key={c.epochId}
              conversation={c}
              teamId={teamId}
              isSelected={c.epochId === selectedId}
              onClick={() => selectConversation(c.epochId)}
              label={conversationLabel(c, t)}
            />
          ))
        )}
      </div>
    </div>
  )
}

function ConversationItem({ conversation, teamId, isSelected, onClick, label }: {
  conversation: TeamConversation
  teamId: string
  isSelected: boolean
  onClick: () => void
  label: string
}) {
  const { t } = useTranslation()
  const renameConversation = useTeamStore(s => s.renameConversation)
  const archiveConversation = useTeamStore(s => s.archiveConversation)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(label)
  const [confirmArchive, setConfirmArchive] = useState(false)

  const Icon = conversation.kind === 'im'
    ? (conversation.channel ? Users : MessageSquare)
    : conversation.kind === 'member' ? User : MessageSquare

  const commitRename = useCallback(() => {
    const next = draft.trim()
    setEditing(false)
    if (next && next !== label) void renameConversation(teamId, conversation.epochId, next)
  }, [draft, label, renameConversation, teamId, conversation.epochId])

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick() }}
      className={`group w-full cursor-pointer px-3 py-2.5 text-left transition-colors ${
        isSelected ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
      }`}
    >
      <div className="flex items-center gap-2">
        {/* Live/waiting indicator */}
        {conversation.waitingUser ? (
          <span className="h-2 w-2 flex-shrink-0 rounded-full bg-amber-500" title={t('Waiting for your decision')} />
        ) : conversation.active ? (
          <span className="h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-emerald-500" title={t('Working now')} />
        ) : (
          <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        )}

        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') { setEditing(false); setDraft(label) }
              }}
              className="w-full rounded border border-border bg-background px-1.5 py-0.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">{label}</span>
              {conversation.kind === 'im' && (
                <span className="flex-shrink-0 rounded bg-secondary px-1 py-0.5 text-[9px] uppercase text-muted-foreground">{t('IM')}</span>
              )}
            </div>
          )}
          {conversation.readonly && !editing && (
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground/60">{t('View only')}</p>
          )}
        </div>

        {/* Hover actions (native / member sessions are manageable; IM is read-only). */}
        {!editing && !confirmArchive && !conversation.readonly && (
          <div className="flex flex-shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              onClick={(e) => { e.stopPropagation(); setDraft(label); setEditing(true) }}
              className="rounded p-0.5 hover:bg-secondary"
              title={t('Rename')}
            >
              <Pencil className="h-3 w-3 text-muted-foreground/60 hover:text-foreground" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmArchive(true) }}
              className="rounded p-0.5 hover:bg-secondary"
              title={t('Clear conversation')}
            >
              <Eraser className="h-3 w-3 text-muted-foreground/60 hover:text-destructive" />
            </button>
          </div>
        )}

        {confirmArchive && (
          <div className="flex flex-shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => { void archiveConversation(teamId, conversation.epochId); setConfirmArchive(false) }}
              className="rounded p-0.5 text-destructive hover:bg-destructive/10"
              title={t('Confirm')}
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setConfirmArchive(false)}
              className="rounded p-0.5 text-muted-foreground hover:bg-secondary"
              title={t('Cancel')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
