/**
 * Task Store — merges conversation, automation-app and team items into the
 * single task-panel list.
 *
 * chat.store (conversations), apps.store (automation apps) and team.store
 * (teams) each derive their own task-relevant items without depending on each
 * other — no domain needs to know the others exist. This module is the only
 * place they are combined; task-panel UI should read from here rather than
 * reaching into a domain store directly.
 */
import { useMemo } from 'react'
import i18n from '../i18n'
import { usePulseItems } from './chat.store'
import { useAutomationTaskItems } from './apps.store'
import { useSpaceStore } from './space.store'
import { useTeamStore } from './team.store'
import type { PulseItem, TaskItem, TaskItemStatus } from '../types'
import type { TeamListItem } from '../../shared/apps/team-types'

function conversationToTaskItem(item: PulseItem): TaskItem {
  return {
    key: `conv:${item.conversationId}`,
    source: 'conversation',
    status: item.status === 'generating' ? 'running' : item.status,
    title: item.title,
    // Automation items get a purpose-built detail from apps.store; a
    // conversation's closest equivalent is what was last said in it.
    detail: item.preview ?? '',
    spaceId: item.spaceId,
    spaceName: item.spaceName,
    updatedAt: new Date(item.updatedAt).getTime(),
    conversationId: item.conversationId,
    starred: item.starred,
    readAt: item.readAt,
    kept: item.kept,
  }
}

/**
 * A team that owes the user a decision. Teams are not space-scoped, so the
 * space name stays empty and the panel renders no workspace pill for them.
 */
function teamToTaskItem(team: TeamListItem): TaskItem {
  return {
    key: `team:${team.id}`,
    source: 'team',
    status: 'waiting',
    title: team.name,
    detail: i18n.t('Waiting for your decision'),
    spaceId: null,
    spaceName: '',
    updatedAt: team.updatedAt,
    teamId: team.id,
  }
}

// Urgency order within the flat list: things needing the user outrank
// things merely running, and among those needing the user, an error or an
// explicit wait outranks a completion the user hasn't looked at yet.
const STATUS_PRIORITY: Record<TaskItemStatus, number> = {
  waiting: 0,
  error: 1,
  'completed-unseen': 2,
  running: 3,
  idle: 4,
}

/**
 * All task-panel items — conversations and automation apps combined, space
 * names resolved, sorted by urgency then recency.
 */
export function useTaskItems(): TaskItem[] {
  const pulseItems = usePulseItems()
  const automationItems = useAutomationTaskItems()
  const teams = useTeamStore(state => state.teams)
  const haloSpace = useSpaceStore(state => state.haloSpace)
  const spaces = useSpaceStore(state => state.spaces)

  return useMemo(() => {
    const resolveSpaceName = (spaceId: string | null): string => {
      if (spaceId === null) return i18n.t('Global')
      if (haloSpace?.id === spaceId) return haloSpace.isTemp ? 'Halo' : haloSpace.name
      const space = spaces.find(s => s.id === spaceId)
      return space ? (space.isTemp ? 'Halo' : space.name) : spaceId
    }

    const items: TaskItem[] = [
      ...pulseItems.map(conversationToTaskItem),
      ...automationItems.map(item => ({ ...item, spaceName: resolveSpaceName(item.spaceId) })),
      ...teams.filter(team => team.hasWaitingUser).map(teamToTaskItem),
    ]

    return items.sort((a, b) => {
      const priorityDiff = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]
      return priorityDiff !== 0 ? priorityDiff : b.updatedAt - a.updatedAt
    })
  }, [pulseItems, automationItems, teams, haloSpace, spaces])
}

/** Count of items needing the user's attention (waiting, error, or an unseen completion). */
export function useTaskCount(): number {
  const items = useTaskItems()
  return useMemo(
    () => items.filter(i => i.status === 'waiting' || i.status === 'error' || i.status === 'completed-unseen').length,
    [items]
  )
}

/**
 * The single most urgent status across all items — drives the nav rail's
 * badge color and spinning-ring indicator.
 */
export function useTaskBeacon(): TaskItemStatus | null {
  const items = useTaskItems()
  return useMemo(() => {
    if (items.some(i => i.status === 'waiting')) return 'waiting'
    if (items.some(i => i.status === 'completed-unseen')) return 'completed-unseen'
    if (items.some(i => i.status === 'running')) return 'running'
    if (items.some(i => i.status === 'error')) return 'error'
    return null
  }, [items])
}
