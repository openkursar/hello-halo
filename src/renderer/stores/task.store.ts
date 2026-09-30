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
import i18n, { getCurrentLanguage } from '../i18n'
import { usePulseItems } from './chat.store'
import { useAppsStore, useAutomationTaskItems } from './apps.store'
import { resolveSpecI18n } from '../utils/spec-i18n'
import { useSpaceNameResolver } from './space.store'
import { useTeamStore } from './team.store'
import type { PulseItem, TaskItem, TaskItemStatus } from '../types'
import type { InstalledApp } from '../../shared/apps/app-types'
import type { TeamListItem } from '../../shared/apps/team-types'

function conversationToTaskItem(item: PulseItem, apps: InstalledApp[]): TaskItem {
  if (item.appId) return digitalHumanConversationToTaskItem(item, item.appId, apps)
  return {
    key: `conv:${item.conversationId}`,
    source: 'conversation',
    status: item.status === 'generating' ? 'running' : item.status,
    title: item.title,
    // Automation items get a purpose-built detail from apps.store; a
    // conversation's closest equivalent is what was last said in it.
    detail: item.preview ?? '',
    spaceId: item.spaceId,
    spaceName: '',
    updatedAt: new Date(item.updatedAt).getTime(),
    conversationId: item.conversationId,
    starred: item.starred,
    readAt: item.readAt,
    kept: item.kept,
  }
}

/**
 * A digital-human conversation: named and placed by its app, since the chat
 * store only knows the session. Its space is the app's home space (null for a
 * global digital human), which is also where opening it lands.
 */
function digitalHumanConversationToTaskItem(item: PulseItem, appId: string, apps: InstalledApp[]): TaskItem {
  const app = apps.find(a => a.id === appId)
  const name = app ? resolveSpecI18n(app.spec, getCurrentLanguage()).name || app.spec.name : appId
  return {
    key: `conv:${item.conversationId}`,
    source: 'conversation',
    status: item.status === 'generating' ? 'running' : item.status,
    title: name,
    detail: '',
    spaceId: app ? app.spaceId ?? null : item.spaceId || null,
    spaceName: '',
    updatedAt: new Date(item.updatedAt).getTime(),
    conversationId: item.conversationId,
    readAt: item.readAt,
    kept: item.kept,
    appId,
    appName: name,
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
  const apps = useAppsStore(state => state.apps)
  const hasFullAppList = useAppsStore(state => state.hasFullList)
  const teams = useTeamStore(state => state.teams)
  const spaceName = useSpaceNameResolver()

  return useMemo(() => {
    const resolveSpaceName = (spaceId: string | null): string =>
      spaceId === null ? i18n.t('Global') : spaceName(spaceId)

    // A deleted or uninstalled digital human has no chat left to open. Absence
    // only proves deletion once the full (not space-filtered) list is loaded.
    const isGoneApp = (appId: string): boolean => {
      const app = apps.find(a => a.id === appId)
      return app ? app.status === 'uninstalled' : hasFullAppList
    }

    const items: TaskItem[] = [
      ...pulseItems
        .filter(item => !item.appId || !isGoneApp(item.appId))
        .map(item => {
          const task = conversationToTaskItem(item, apps)
          return { ...task, spaceName: resolveSpaceName(task.spaceId) }
        }),
      ...automationItems.map(item => ({ ...item, spaceName: resolveSpaceName(item.spaceId) })),
      ...teams.filter(team => !team.ephemeral && team.hasWaitingUser).map(teamToTaskItem),
    ]

    return items.sort((a, b) => {
      const priorityDiff = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]
      return priorityDiff !== 0 ? priorityDiff : b.updatedAt - a.updatedAt
    })
  }, [pulseItems, automationItems, apps, hasFullAppList, teams, spaceName])
}

export interface TaskItemCounts {
  /** Needing the user: waiting, error, or an unseen completion. */
  continueCount: number
  runningCount: number
  /** Kept in the list with nothing pending. */
  pinnedCount: number
}

export function countTaskItems(items: TaskItem[]): TaskItemCounts {
  const counts: TaskItemCounts = { continueCount: 0, runningCount: 0, pinnedCount: 0 }
  for (const item of items) {
    switch (item.status) {
      case 'waiting':
      case 'error':
      case 'completed-unseen':
        counts.continueCount++
        break
      case 'running':
        counts.runningCount++
        break
      case 'idle':
        counts.pinnedCount++
        break
    }
  }
  return counts
}

/** Tasks in the panel, whatever their state. Pinned idle conversations are not tasks. */
export function useTaskCount(): number {
  const items = useTaskItems()
  return useMemo(() => items.filter(item => item.status !== 'idle').length, [items])
}
