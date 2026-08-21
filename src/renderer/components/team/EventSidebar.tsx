/**
 * EventSidebar — the list of things ("units of work") on the right of the Live tab.
 *
 * Symmetric with the Conversation tab's session sidebar: pick an item here, watch
 * it on the left. Two sections, and only two, because "is it moving right now" is
 * the only distinction worth a heading here:
 *   · Busy now: whatever is running this moment — the live run, and conversations
 *     members are actively working. Click to watch it stream.
 *   · Earlier: everything else, newest ACTIVITY first — past runs and quiet
 *     conversations side by side. A conversation is a standing thing, so between
 *     messages it moves down here rather than vanishing; otherwise its board (and
 *     every task raised in it) becomes unreachable the moment nobody is typing.
 *
 * This replaces the old standalone History tab: selecting + viewing now happen in
 * one place, and a past run opens as the same topology visualization as a live one.
 */

import { useMemo, useState } from 'react'
import { Zap, MessageSquare, ChevronRight, AlertTriangle } from 'lucide-react'
import type { TeamDetail, TeamConversation, TeamEpochSummary } from '../../../shared/apps/team-types'
import { awaitsOurDecision } from '../../../shared/apps/team-types'
import { useTranslation } from '../../i18n'
import { runOutcome, outcomeMeta, triggerLabel, formatRunTime, runEventTitle, groupHistory, conversationLabel, epochLabel, lastActivityOf, type HistoryRow } from './run-history'

interface EventSidebarProps {
  detail: TeamDetail
  conversations: TeamConversation[]
  epochs: TeamEpochSummary[]
  selectedEpochId: string | null
  onSelect: (epochId: string) => void
  onClose?: () => void
}

export function EventSidebar({ detail, conversations, epochs, selectedEpochId, onSelect, onClose }: EventSidebarProps) {
  const { t } = useTranslation()
  const liveRunId = detail.team.currentEpochId
  const liveStatus = detail.team.status
  // The run's warning mark is a call to action, so it only lights up when the
  // decision holding the run is one of ours to make (a joined office mirrors the
  // host's 'waiting_user' regardless of whose member raised it).
  const runWaitsOnUs = useMemo(
    () => liveStatus === 'waiting_user' && detail.roster.some(awaitsOurDecision),
    [liveStatus, detail.roster]
  )
  // The live run keeps its stable time · trigger identity (never "in progress" —
  // that's the pulse's job), so its title doesn't mutate when it seals.
  const liveRunEpoch = useMemo(() => epochs.find(e => e.id === liveRunId), [epochs, liveRunId])

  // Busy now: the live run + conversations someone is actively working right now.
  const activeConversations = useMemo(() => conversations.filter(c => c.active || c.waitingUser), [conversations])
  const hasBusy = !!liveRunId || activeConversations.length > 0

  // Earlier: everything not in Busy now, runs and conversations together.
  const busyIds = useMemo(
    () => new Set([liveRunId, ...activeConversations.map(c => c.epochId)].filter((id): id is string => !!id)),
    [liveRunId, activeConversations]
  )
  const { rows } = useMemo(
    () => groupHistory(epochs.filter(e => !busyIds.has(e.id))),
    [epochs, busyIds]
  )

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-11 flex-shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-sm font-medium">{t('Events')}</span>
        {onClose && (
          <button onClick={onClose} className="rounded p-1 transition-colors hover:bg-secondary sm:hidden">
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* ── Busy now ── */}
        {hasBusy && (
          <div className="px-2 pt-2">
            <SectionLabel>{t('Busy now')}</SectionLabel>
            {liveRunId && (
              <EventRow
                selected={selectedEpochId === liveRunId}
                onClick={() => onSelect(liveRunId)}
                icon={<Zap className="h-3.5 w-3.5 flex-shrink-0 text-emerald-500" />}
                title={runEventTitle(liveRunEpoch, t)}
                live={liveStatus === 'running'}
                waiting={runWaitsOnUs}
              />
            )}
            {activeConversations.map(c => (
              <EventRow
                key={c.epochId}
                selected={selectedEpochId === c.epochId}
                onClick={() => onSelect(c.epochId)}
                icon={<MessageSquare className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />}
                title={conversationLabel(c, t)}
                live={!!c.active}
                waiting={!!c.waitingUser}
              />
            ))}
          </div>
        )}

        {/* ── Earlier ── */}
        {/* During the first run there is nothing earlier yet, and the Run
            button has already turned into Pause, so the empty line would point
            at a button that is not on screen. Drop the whole section: the busy
            list above is already saying what is happening. */}
        {(rows.length > 0 || !hasBusy) && (
          <div className="px-2 pb-3 pt-2">
            <SectionLabel>{t('Earlier')}</SectionLabel>
            {rows.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground/60">
                {t('Nothing yet. Talk to the team, or press Run.')}
              </p>
            ) : (
              rows.map(row => {
                if (row.kind === 'group') {
                  return <NoActionGroup key={row.key} group={row} selectedEpochId={selectedEpochId} onSelect={onSelect} />
                }
                if (row.kind === 'conversation') {
                  return (
                    <ConversationRow
                      key={row.epoch.id}
                      epoch={row.epoch}
                      selected={selectedEpochId === row.epoch.id}
                      onClick={() => onSelect(row.epoch.id)}
                    />
                  )
                }
                return <RunRow key={row.epoch.id} epoch={row.epoch} selected={selectedEpochId === row.epoch.id} onClick={() => onSelect(row.epoch.id)} />
              })
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">{children}</div>
}

/** A live-event row (run / active conversation). */
function EventRow({ selected, onClick, icon, title, live, waiting }: {
  selected: boolean
  onClick: () => void
  icon: React.ReactNode
  title: string
  live?: boolean
  waiting?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors ${
        selected ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
      }`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {waiting
        ? <AlertTriangle className="h-3 w-3 flex-shrink-0 text-amber-500" />
        : live ? <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-emerald-500" /> : null}
    </button>
  )
}

/**
 * A quiet conversation row: its NAME, plus when it last moved. A conversation is
 * a thing you go back to by name, so time is the subtitle here — the inverse of
 * a run row, where the time IS the identity.
 */
function ConversationRow({ epoch, selected, onClick }: { epoch: TeamEpochSummary; selected: boolean; onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors ${
        selected ? 'bg-secondary' : 'hover:bg-secondary/50'
      }`}
    >
      <MessageSquare className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-foreground">{epochLabel(epoch, t)}</div>
        <span className="text-[11px] text-muted-foreground/60">{formatRunTime(lastActivityOf(epoch))}</span>
      </div>
    </button>
  )
}

/** A past-run row: time · trigger · outcome (a run is placed by when it ran). */
function RunRow({ epoch, selected, onClick, compact }: { epoch: TeamEpochSummary; selected: boolean; onClick: () => void; compact?: boolean }) {
  const { t } = useTranslation()
  const outcome = runOutcome(epoch)
  const { Icon, cls, label } = outcomeMeta(outcome, epoch, t)
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-start gap-2 rounded-lg py-2 text-left transition-colors ${
        compact ? 'px-2' : 'px-2'
      } ${selected ? 'bg-secondary' : 'hover:bg-secondary/50'}`}
    >
      <Icon className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${cls}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs text-foreground">{formatRunTime(epoch.startedAt)}</span>
          <span className="flex-shrink-0 text-[10px] text-muted-foreground/60">· {triggerLabel(epoch.triggerType, t)}</span>
        </div>
        <span className={`text-[11px] ${cls}`}>{label}</span>
      </div>
    </button>
  )
}

function NoActionGroup({ group, selectedEpochId, onSelect }: {
  group: Extract<HistoryRow, { kind: 'group' }>
  selectedEpochId: string | null
  onSelect: (epochId: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-secondary/50"
      >
        <ChevronRight className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="min-w-0 flex-1 truncate">{t('{{count}} runs · no action needed', { count: group.count })}</span>
      </button>
      {open && (
        <div className="pl-3">
          {group.epochs.map(e => (
            <RunRow key={e.id} epoch={e} selected={selectedEpochId === e.id} onClick={() => onSelect(e.id)} compact />
          ))}
        </div>
      )}
    </div>
  )
}
