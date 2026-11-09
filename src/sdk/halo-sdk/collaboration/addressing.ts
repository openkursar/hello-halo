export const SELF_NODE_ID = 'SELF'
export const TEAM_LEAD_ADDRESS = 'lead'

/** The lead has a reserved address; a same-named teammate remains reachable by ID. */
export function teamMemberAddress(member: { appId: string; memberName: string; isLead?: boolean }): string {
  return member.isLead ? TEAM_LEAD_ADDRESS : member.memberName === TEAM_LEAD_ADDRESS ? member.appId : member.memberName
}

export function buildTeamSessionKey(appId: string, teamId: string, epochId: string): string {
  return `app-chat:${appId}:team:${teamId}:${epochId}`
}

export function isTeamSessionKey(conversationId: string): boolean {
  if (!conversationId.startsWith('app-chat:')) return false
  const parts = conversationId.split(':')
  return parts.length === 5 && parts[2] === 'team'
}

export function parseTeamSessionKey(
  conversationId: string
): { appId: string; teamId: string; epochId: string } | null {
  if (!isTeamSessionKey(conversationId)) return null
  const parts = conversationId.split(':')
  return { appId: parts[1], teamId: parts[3], epochId: parts[4] }
}

const SPACE_COORDINATOR_APP_PREFIX = 'space-conv-'

/**
 * Sentinel appId representing a space conversation acting as a team
 * coordinator. Filename-safe (rides in team session keys) and parseable so the
 * bus can route deliveries for it away from app-chat.
 */
export function spaceCoordinatorAppId(conversationId: string): string {
  return `${SPACE_COORDINATOR_APP_PREFIX}${conversationId}`
}

/** The conversationId behind a coordinator sentinel appId, or null. */
export function parseSpaceCoordinatorAppId(appId: string): string | null {
  return appId.startsWith(SPACE_COORDINATOR_APP_PREFIX)
    ? appId.slice(SPACE_COORDINATOR_APP_PREFIX.length)
    : null
}


export function isRemoteMember(member: {
  origin?: 'local' | 'remote'
  ownerNodeId?: string
}): boolean {
  return member.origin === 'remote' && member.ownerNodeId !== SELF_NODE_ID
}
