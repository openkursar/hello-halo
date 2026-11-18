/**
 * The bond between a temporary collaboration and the conversation that
 * coordinates it: whether a report still belongs to that conversation, and
 * what happens to the collaboration when the conversation goes away.
 */

import { buildRunSenderKey, nativeChatAppId, parseRunSenderKey } from '../../../shared/apps/im-keys'
import type { TeamStore } from './store'
import type { TeamService } from './service'

const LOG_TAG = '[TeamCollabBinding]'

/**
 * Whether a report to `conversationId` is still about work that conversation
 * started. The optional execution fence also revalidates queued reports after
 * a stop, including when a later human request has already resumed the chat.
 */
export function collabReportOwnership(
  store: Pick<TeamStore, 'getTeamById'>,
  teamId: string,
  conversationId: string,
  current?: () => boolean,
): (() => boolean) {
  return () => store.getTeamById(teamId)?.coordinatorConversationId === conversationId && (current?.() ?? true)
}

/** A gone conversation dissolves its ephemeral collaboration and unbinds a saved one. */
export function releaseCollaboration(
  store: Pick<TeamStore, 'getCollabTeamByConversation' | 'setCoordinatorConversation'>,
  service: Pick<TeamService, 'dissolveTeam'>,
  conversationId: string,
): void {
  try {
    const collabTeam = store.getCollabTeamByConversation(conversationId)
    if (!collabTeam) return
    if (collabTeam.ephemeral) {
      console.log(`${LOG_TAG} conversation gone → dissolving collaboration team=${collabTeam.id}`)
      void service.dissolveTeam(collabTeam.id).catch((err) =>
        console.error(`${LOG_TAG} collaboration cleanup failed:`, err)
      )
    } else {
      store.setCoordinatorConversation(collabTeam.id, null)
    }
  } catch (err) {
    console.error(`${LOG_TAG} collaboration cleanup failed:`, err)
  }
}

/** A run's collaboration has no conversation to delete: it ends when the run's record is retired. */
export function releaseRunCollaboration(
  store: Pick<TeamStore, 'getCollabTeamByConversation' | 'setCoordinatorConversation'>,
  service: Pick<TeamService, 'dissolveTeam'>,
  appId: string,
  runId: string,
): void {
  releaseCollaboration(store, service, buildRunSenderKey(appId, runId))
}

/** Collaborations coordinated from any chat or run of an uninstalled digital human end with it. */
export function releaseCollaborationsOfApp(
  store: Pick<TeamStore, 'listTeamsBySpace' | 'getCollabTeamByConversation' | 'setCoordinatorConversation'>,
  service: Pick<TeamService, 'dissolveTeam'>,
  app: { id: string; spaceId: string | null },
): void {
  if (!app.spaceId) return
  for (const team of store.listTeamsBySpace(app.spaceId)) {
    const coordinator = team.coordinatorConversationId
    if (!coordinator) continue
    if (nativeChatAppId(coordinator) === app.id || parseRunSenderKey(coordinator)?.appId === app.id) {
      releaseCollaboration(store, service, coordinator)
    }
  }
}
