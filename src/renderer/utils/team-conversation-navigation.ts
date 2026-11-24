import { useAppStore } from '../stores/app.store'
import { useChatStore, type TeamChatTarget } from '../stores/chat.store'
import { useSpaceStore } from '../stores/space.store'
import { useTeamChatHiddenStore } from '../stores/team-chat-hidden.store'
import { teamTaskKey } from '../stores/team-chat-pins.store'
import type { TeamDetail } from '../../shared/apps/team-types'

/** Opens a task without creating it or changing its execution context. */
export function openTeamConversation(spaceId: string, target: TeamChatTarget): boolean {
  const spaces = useSpaceStore.getState()
  const space = spaces.currentSpace?.id === spaceId ? spaces.currentSpace
    : spaces.haloSpace?.id === spaceId ? spaces.haloSpace
      : spaces.spaces.find(item => item.id === spaceId)
  if (!space) {
    console.warn('[TeamNavigation] Local space unavailable', { spaceId, teamId: target.teamId })
    return false
  }
  if (target.epochId) useTeamChatHiddenStore.getState().restore(spaceId, teamTaskKey(target.teamId, target.epochId))
  useChatStore.getState().selectTeamConversation(spaceId, target)
  spaces.setCurrentSpace(space)
  useAppStore.getState().navigate('space')
  return true
}

export function localTeamSpace(detail: TeamDetail): string | null {
  if (!detail.team.hostNodeId) return detail.team.owningSpaceId
  const spaces = useSpaceStore.getState()
  const local = detail.roster.filter(member => member.sameMachine !== false && member.spaceId)
  return local.find(member => member.spaceId === spaces.currentSpace?.id)?.spaceId ?? local[0]?.spaceId ?? null
}
