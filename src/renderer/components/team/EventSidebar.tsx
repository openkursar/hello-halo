/**
 * EventSidebar — the list of things ("units of work") on the right of the Live tab.
 *
 * Symmetric with the Conversation tab's session sidebar: pick an item here, watch
 * it on the left. Two sections:
 *   · Busy now: the live run + conversations members are actively working
 *     — click to watch it stream.
 *   · Ran before: past runs, identified by time · trigger · outcome (a run
 *     is an event, not a named thing), grouped so a busy scheduler doesn't flood
 *     the list. Click to replay it on the left.
 *
 * This replaces the old standalone History tab: selecting + viewing now happen in
 * one place, and a past run opens as the same topology visualization as a live one.
 */

import { useMemo, useState } from 'react'
import { Zap, MessageSquare, ChevronRight, AlertTriangle } from 'lucide-react'
import type { TeamDetail, TeamConversation, TeamEpochSummary } from '../../../shared/apps/team-types'
import { useTranslation } from '../../i18n'
import { runOutcome, outcomeMeta, triggerLabel, formatRunTime, runEventTitle, groupHistory, conversationLabel, type HistoryRow } from './run-history'

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
  // The live run keeps its stable time · trigger identity (never "in progress" —
  // that's the pulse's job), so its title doesn't mutate when it seals.
  const liveRunEpoch = useMemo(() => epochs.find(e => e.id === liveRunId), [epochs, liveRunId])

  // Busy now: the live run + conversations someone is actively working right now.
  const activeConversations = useMemo(() => conversations.filter(c => c.active || c.waitingUser), [conversations])
  const hasBusy = !!liveRunId || activeConversations.length > 0

  // Ran before: past runs only — the currently-live run stays in Busy now,
  // conversations belong to the Conversation tab, so both are filtered out here.
  const { rows } = useMemo(
    () => groupHistory(epochs.filter(e => e.id !== liveRunId)),
    [epochs, liveRunId]
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
                waiting={liveStatus === 'waiting_user'}
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

        {/* ── Ran before ── */}
        <div className="px-2 pb-3 pt-2">
          <SectionLabel>{t('Ran before')}</SectionLabel>
          {rows.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground/60">
              {t('No runs yet. Press Run to start the first one.')}
            </p>
          ) : (
            rows.map(row => (
              row.kind === 'group'
                ? <NoActionGroup key={row.key} group={row} selectedEpochId={selectedEpochId} onSelect={onSelect} />
                : <RunRow key={row.epoch.id} epoch={row.epoch} selected={selectedEpochId === row.epoch.id} onClick={() => onSelect(row.epoch.id)} />
            ))
          )}
        </div>
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
