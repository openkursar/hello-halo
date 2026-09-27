/**
 * PulseList - Shared presentational component for rendering task-panel items
 *
 * Pure list rendering of active tasks, unseen completions, and pinned
 * conversations, aggregated across conversations and automation apps
 * (stores/task.store.ts). Used by TaskPanel.
 *
 * Responsibilities:
 * - Renders grouped items: "Continue" (waiting / completed-unseen / error —
 *   needs the user) and "Running", each with a header + count, then pinned
 *   idle conversations last
 * - Source-specific identity: MessageSquare icon for conversations,
 *   AutomationAvatar for digital humans — never a generic status dot
 * - Pin/unpin toggle and grace-period "seen" Keep/Remove — conversation
 *   items only; automation items never enter the seen/auto-remove flow
 *   (see task.store.ts's docstring for why)
 * - Cross-space navigation on click (conversations) / Apps-page navigation
 *   with optional escalation deep-link (automation)
 * - Empty state
 *
 * Does NOT handle: positioning, open/close, collapse/expand, or responsive logic.
 */

import { useCallback, useEffect, useState } from 'react'
import { Pin, SquareCheckBig, ChevronRight, MessageSquare, Users } from 'lucide-react'
import { useChatStore } from '../../stores/chat.store'
import { useTaskItems } from '../../stores/task.store'
import { useTeamStore } from '../../stores/team.store'
import { useAppStore } from '../../stores/app.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { navigateToConversation } from '../../utils/conversation-navigation'
import { AutomationAvatar } from '../apps/AutomationAvatar'
import { useTranslation } from '../../i18n'
import { cn } from '../../lib/utils'
import type { TaskItem, TaskItemStatus } from '../../types'

/** mm:ss for under an hour, h:mm:ss past that — running tasks rarely run long. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

// Fallback for an item with no `detail` — a conversation whose last message
// hasn't been previewed yet (brand new, or an index written before previews).
// Status stays legible regardless: it drives the detail line's color, and the
// section the item is grouped under.
const STATUS_LABEL: Partial<Record<TaskItemStatus, string>> = {
  'running': 'Generating...',
  'waiting': 'Waiting for your input',
  'completed-unseen': 'Completed',
  'error': 'Error',
  'idle': 'Pinned',
}

const STATUS_TEXT_CLASS: Record<TaskItemStatus, string> = {
  'running': 'text-primary',
  'waiting': 'text-halo-warning',
  'completed-unseen': 'text-halo-success',
  'error': 'text-halo-error',
  'idle': 'text-muted-foreground',
}

/** Open a team's workbench, which lives on the Apps page under the Teams tab. */
function navigateToTeam(teamId: string) {
  useTeamStore.getState().selectTeam(teamId)
  useAppsPageStore.getState().setCurrentTab('team')
  useAppStore.getState().navigate('apps')
}

/**
 * Navigate to a digital human's activity thread. Every automation status
 * lands here (including 'running', which already surfaces a live "Working…"
 * card with its own link into session detail) — a `waiting` item additionally
 * deep-links to its EscalationCard when one is pending.
 */
function navigateToAutomation(item: TaskItem) {
  if (!item.appId) return
  useAppsPageStore.getState().setCurrentTab('my-digital-humans')
  if (item.status === 'waiting' && item.escalationId) {
    useAppsPageStore.getState().openActivityThreadAt(item.appId, item.escalationId)
  } else {
    useAppsPageStore.getState().openActivityThread(item.appId)
  }
  useAppStore.getState().navigate('apps')
}

interface PulseListProps {
  /** Max height for the scrollable area (CSS value) */
  maxHeight?: string
  /** Callback after an item is clicked (e.g. to close a panel) */
  onItemClick?: () => void
  /** Whether to show compact items (smaller padding) */
  compact?: boolean
}

export function PulseList({ maxHeight, onItemClick, compact = false }: PulseListProps) {
  const { t } = useTranslation()
  const items = useTaskItems()

  // "Selected" = the item whose content is currently showing on the right,
  // independent of read/seen state — stays highlighted even once a
  // conversation item has faded into its seen/countdown look (prototype:
  // `.tk.sel`, `.tk.seen.sel{opacity:1}`).
  const currentSpaceId = useChatStore(state => state.currentSpaceId)
  const currentConversationId = useChatStore(state =>
    state.currentSpaceId ? state.spaceStates.get(state.currentSpaceId)?.currentConversationId ?? null : null
  )
  const selectedAppId = useAppsPageStore(state => state.selectedAppId)
  const selectedTeamId = useTeamStore(state => state.currentTeamId)
  const appView = useAppStore(state => state.view)

  // Drives the elapsed-time text for running items. Only ticks while at
  // least one item is running, so idle panels don't re-render every second.
  const [, forceTick] = useState(0)
  const hasRunning = items.some(i => i.status === 'running')
  useEffect(() => {
    if (!hasRunning) return
    const id = setInterval(() => forceTick(n => n + 1), 1000)
    return () => clearInterval(id)
  }, [hasRunning])

  const handleItemClick = useCallback((item: TaskItem) => {
    if (item.source === 'conversation' && item.conversationId) {
      navigateToConversation(item.spaceId!, item.conversationId)
    } else if (item.source === 'team' && item.teamId) {
      navigateToTeam(item.teamId)
    } else {
      navigateToAutomation(item)
    }
    onItemClick?.()
  }, [onItemClick])

  // Pin/Unpin: UI uses "Pin" terminology, backend API uses "Star" (starred field).
  // The mapping is: Pin = starred:true, Unpin = starred:false. Conversation-only.
  const handleTogglePin = useCallback((e: React.MouseEvent, item: TaskItem) => {
    e.stopPropagation()
    if (!item.conversationId) return
    useChatStore.getState().toggleStarConversation(item.spaceId!, item.conversationId, !item.starred)
  }, [])

  const handleKeep = useCallback((e: React.MouseEvent, item: TaskItem) => {
    e.stopPropagation()
    if (item.conversationId) useChatStore.getState().keepPulseItem(item.conversationId)
  }, [])

  const handleRemove = useCallback((e: React.MouseEvent, item: TaskItem) => {
    e.stopPropagation()
    if (item.conversationId) useChatStore.getState().removePulseItem(item.conversationId)
  }, [])

  // "Continue" = needs the user (waiting for input, done but unseen, or
  // errored) — conversations and digital humans both land here. "Running"
  // covers both actively-generating conversations and running/queued apps.
  const continueItems = items.filter(i => i.status === 'waiting' || i.status === 'completed-unseen' || i.status === 'error')
  const runningItems = items.filter(i => i.status === 'running')
  const pinnedIdleItems = items.filter(i => i.status === 'idle')

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center px-3 py-8 text-center">
        <SquareCheckBig className="w-[26px] h-[26px] mb-2 text-subtle-foreground" strokeWidth={1.5} />
        <p className="text-xs text-subtle-foreground">{t('No active tasks')}</p>
        <p className="text-xs text-subtle-foreground mt-1">
          {t('Tasks and pinned conversations appear here')}
        </p>
      </div>
    )
  }

  const py = compact ? 'py-1.5' : 'py-[11px]'
  const px = 'px-3'

  const renderSectionHeader = (label: string, count: number, indicator: 'ready' | 'running' | 'idle') => (
    <div className={`${px} first:mt-1 mt-4 mb-2 flex items-center gap-[7px]`}>
      {indicator === 'running' ? (
        <span className="w-[11px] h-[11px] rounded-full border-2 border-primary border-t-transparent animate-spin" />
      ) : indicator === 'idle' ? (
        <Pin className="w-[11px] h-[11px] text-subtle-foreground" strokeWidth={2} />
      ) : (
        <span className="w-[7px] h-[7px] rounded-full bg-primary" />
      )}
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <span className="ml-auto text-xs font-medium text-subtle-foreground/60 tabular-nums">{count}</span>
    </div>
  )

  const renderItem = (item: TaskItem) => {
    const isConversation = item.source === 'conversation'
    const isTeam = item.source === 'team'
    // Grace-period item: user already looked at it, counting down to
    // auto-hide (chat.store `pulseReadAt`, 60s) unless kept. Automation
    // items never carry readAt, so this is always false for them.
    const isSeen = isConversation && !!item.readAt && !item.kept
    const isReady = item.status === 'waiting' || item.status === 'completed-unseen' || item.status === 'error'
    const isRunning = item.status === 'running'
    const isQueued = !isConversation && item.status === 'running' && !item.startedAt
    const elapsedMs = item.readAt ? Date.now() - item.readAt : 0
    const runningElapsedMs = isRunning && item.startedAt ? Date.now() - item.startedAt : 0
    // Gated on the current top-level view too — chat.store keeps the last
    // selected conversation around even while the user is on the Apps page
    // (and vice versa for apps-page.store), so without this guard both a
    // conversation and a digital human could show as selected at once.
    const isSelected = isConversation
      ? appView === 'space' && item.spaceId === currentSpaceId && item.conversationId === currentConversationId
      : appView === 'apps' && (isTeam ? item.teamId === selectedTeamId : item.appId === selectedAppId)

    return (
      <div
        key={item.key}
        onClick={() => handleItemClick(item)}
        className={cn(
          'group/tk flex items-center gap-[11px] rounded-lg border cursor-pointer transition-colors ease-halo mx-2 mb-1.5',
          px, py,
          isSelected
            ? 'border-blue-500 bg-blue-500/[0.12]'
            : cn(
                'border-border',
                isSeen
                  ? 'opacity-[.62] hover:opacity-100 hover:bg-secondary'
                  : isReady
                    ? isConversation
                      ? 'bg-secondary hover:bg-surface-hover'
                      : 'bg-card hover:bg-surface-hover'
                    : 'bg-transparent hover:bg-secondary'
              )
        )}
      >
        {/* Identity icon — MessageSquare for a conversation, Users for a team,
            the digital human's own generated face for automation. Never a
            status dot: status is conveyed by the section and elapsed text. */}
        {isConversation || isTeam ? (
          <div className={cn(
            'w-[30px] h-[30px] flex-shrink-0 rounded-sm flex items-center justify-center',
            isReady && !isSeen ? 'bg-primary/[0.12] text-accent-on-dark' : 'bg-secondary text-subtle-foreground'
          )}>
            {isTeam
              ? <Users className="w-4 h-4" strokeWidth={1.8} />
              : <MessageSquare className="w-4 h-4" strokeWidth={1.8} />}
          </div>
        ) : (
          <div className="w-[30px] h-[30px] flex-shrink-0 rounded-sm overflow-hidden">
            <AutomationAvatar name={item.appName || item.title} size={30} />
          </div>
        )}

        {/* Content — no source badge next to the title: the identity icon
            above already says conversation vs digital human, and the room it
            frees goes to the title and the status line, which is what the
            user actually scans this panel for. */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-[6px]">
            <p className="text-[13px] font-semibold truncate text-foreground">
              {item.title}
            </p>
            {/* Space rides beside the title as a muted pill, same treatment as
                AutomationCard's — it's context for where clicking lands you,
                not something to scan for. Native `title` rather than the
                Tooltip component: its bubble is absolutely positioned and
                `whitespace-nowrap`, which overflows this 340px panel's
                scroll box sideways. */}
            {/* Teams span workspaces, so they carry no workspace pill. */}
            {!isTeam && (
              <span
                title={item.spaceId
                  ? t('Workspace: {{name}}', { name: item.spaceName })
                  : t('Global — runs outside any workspace')}
                className="flex-shrink-0 max-w-[45%] truncate text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-secondary/70"
              >
                {item.spaceName}
              </span>
            )}
            {isRunning && (
              <span className="ml-auto flex items-center flex-shrink-0 text-[11px] text-subtle-foreground tabular-nums">
                {isQueued ? (
                  t('Queued')
                ) : (
                  <>
                    <span className="inline-block w-2.5 h-2.5 rounded-full border-[1.5px] border-subtle-foreground border-t-transparent opacity-70 mr-[5px] animate-spin" />
                    {formatElapsed(runningElapsedMs)}
                  </>
                )}
              </span>
            )}
          </div>
          <div className="mt-0.5">
            <span className={cn('block text-[11px] truncate', STATUS_TEXT_CLASS[item.status])}>
              {item.detail || t(STATUS_LABEL[item.status] ?? '')}
            </span>
          </div>

          {/* Removal countdown — only while actively counting down (not kept) */}
          {isSeen && (
            <div className="h-[3px] rounded-[2px] bg-secondary mt-[9px] overflow-hidden">
              <div
                className="h-full bg-subtle-foreground animate-countdown"
                style={{ animationDelay: `-${elapsedMs}ms` }}
              />
            </div>
          )}
        </div>

        {/* Trailing actions — conversation-only (Pin, or Keep/Remove once
            counting down); automation items get just the chevron. */}
        {isConversation && isSeen ? (
          <div className="hidden group-hover/tk:flex items-center gap-[5px] flex-shrink-0">
            <span className="animate-fadehint mr-1 text-[11px] text-subtle-foreground">
              {t('Removing soon')}
            </span>
            <button
              onClick={(e) => handleKeep(e, item)}
              className="h-[26px] px-[9px] rounded-sm border border-primary/[0.18] text-[11px] text-accent-on-dark transition-colors ease-halo hover:bg-primary/[0.12] hover:border-primary"
            >
              {t('Keep')}
            </button>
            <button
              onClick={(e) => handleRemove(e, item)}
              className="h-[26px] px-[9px] rounded-sm border border-border bg-card text-[11px] text-muted-foreground transition-colors ease-halo hover:bg-surface-hover hover:text-foreground"
            >
              {t('Remove')}
            </button>
          </div>
        ) : isConversation ? (
          <>
            <button
              onClick={(e) => handleTogglePin(e, item)}
              className={cn(
                'w-[22px] h-[22px] flex-shrink-0 rounded-[6px] flex items-center justify-center transition-colors',
                item.starred
                  ? 'text-blue-500'
                  : 'hidden group-hover/tk:flex text-subtle-foreground hover:bg-surface-hover hover:text-foreground'
              )}
              title={item.starred ? t('Unpin') : t('Pin')}
              aria-pressed={item.starred}
            >
              <Pin className="w-[13px] h-[13px]" strokeWidth={1.8} />
            </button>
            {/* A kept item has no countdown left to end it, so Remove stays reachable. */}
            {item.kept && !!item.readAt && (
              <button
                onClick={(e) => handleRemove(e, item)}
                className="hidden group-hover/tk:block h-[26px] px-[9px] flex-shrink-0 rounded-sm border border-border bg-card text-[11px] text-muted-foreground transition-colors ease-halo hover:bg-surface-hover hover:text-foreground"
              >
                {t('Remove')}
              </button>
            )}
          </>
        ) : null}

        <ChevronRight
          className={cn(
            'w-4 h-4 flex-shrink-0 transition-[transform,color] ease-halo',
            'text-subtle-foreground group-hover/tk:translate-x-0.5 group-hover/tk:text-foreground',
            isReady && !isSeen && 'text-accent-on-dark'
          )}
        />
      </div>
    )
  }

  return (
    <div className="overflow-auto scrollbar-thin pt-2" style={maxHeight ? { maxHeight } : undefined}>
      {/* Continue: waiting for input, done but unseen, or errored */}
      {continueItems.length > 0 && (
        <div className="pb-1">
          {renderSectionHeader(t('Continue'), continueItems.length, 'ready')}
          {continueItems.map(renderItem)}
        </div>
      )}

      {continueItems.length > 0 && (runningItems.length > 0 || pinnedIdleItems.length > 0) && (
        <div className="mx-4 my-3 border-t border-border/30" />
      )}

      {/* Running: actively generating (conversations) or running/queued (apps) */}
      {runningItems.length > 0 && (
        <div className="pb-1">
          {renderSectionHeader(t('Running'), runningItems.length, 'running')}
          {runningItems.map(renderItem)}
        </div>
      )}

      {runningItems.length > 0 && pinnedIdleItems.length > 0 && (
        <div className="mx-4 my-3 border-t border-border/30" />
      )}

      {/* Pinned idle items */}
      {pinnedIdleItems.length > 0 && (
        <div className="pb-1">
          {renderSectionHeader(t('Pinned'), pinnedIdleItems.length, 'idle')}
          {pinnedIdleItems.map(renderItem)}
        </div>
      )}
    </div>
  )
}
