/** Stable membership facts and on-demand access to other team conversations. */

export interface StandingTeam {
  teamId: string
  name: string
  role: string
  isLead: boolean
  hostedElsewhere: boolean
}

export interface CurrentTeamConversation {
  teamId?: string
  teamName: string
  epochId: string
  viaIm: boolean
  temporary?: boolean
}

export interface TeamGuidanceInput {
  /** Undefined means membership was not supplied, not that there are no teams. */
  teams: readonly StandingTeam[] | undefined
  current?: CurrentTeamConversation
  collaborationAvailable?: boolean
}

export const STANDING_TEAM_LIST_LIMIT = 10

/** Read routes exposed by Operate Halo; other operations stay in its manual. */
export const STANDING_TEAM_PATHS = [
  'GET /api/teams/:teamId/conversations',
  'GET /api/teams/:teamId/epochs/:epochId/board',
  'GET /api/teams/:teamId/chat-messages',
] as const

const AUTH = '-H "Authorization: Bearer $HALO_API_TOKEN"'

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function teamLine(team: StandingTeam, current?: CurrentTeamConversation): string {
  const role = oneLine(team.role, 40) || 'member'
  const here = current?.teamId === team.teamId ? '; this conversation' : ''
  const copy = team.hostedElsewhere ? '; on another computer, reads may be a synced copy' : ''
  return `- ${oneLine(team.name, 60)} (teamId ${team.teamId}) — role: ${role}${team.isLead ? ' (lead)' : ''}${here}${copy}`
}

export function buildTeamGuidance(input: TeamGuidanceInput): string | null {
  if (!input.teams?.length) return null
  const shown = [...input.teams]
    .sort((a, b) => a.name.localeCompare(b.name) || a.teamId.localeCompare(b.teamId))
    .slice(0, STANDING_TEAM_LIST_LIMIT)
  const hidden = input.teams.length - shown.length
  const scope = input.current
    ? 'The team tools reach teammates in this conversation. The calls below read other standing-team conversations. '
    : input.collaborationAvailable
      ? 'The collaboration tools work in this chat, not in the standing-team conversations listed above. '
      : ''
  return [
    '## Teams',
    '',
    'A standing team is a lasting group of digital humans in Halo with saved membership and roles.',
    'You are the same person in every team you belong to:',
    ...shown.map(team => teamLine(team, input.current)),
    ...(hidden > 0 ? [`- …${hidden} more: GET $HALO_API_URL/api/teams lists them all; yours are the ones whose localMembers include you`] : []),
    '',
    scope + 'Use these management APIs only when the person explicitly refers to an existing standing team or its work. Otherwise continue in this conversation. ' +
      'Read the named team’s current state before answering; memory is only a hint. ' +
      'Run these with your command tool, as written, and use only what the request needs:',
    '',
    '- List a team\'s conversations (each has an epochId, a label, and whether it is open or archived):',
    `  curl -s "$HALO_API_URL/api/teams/<teamId>/conversations" ${AUTH}`,
    '- Read one conversation\'s tasks, findings and members (each member has an appId):',
    `  curl -s "$HALO_API_URL/api/teams/<teamId>/epochs/<epochId>/board" ${AUTH}`,
    '- Read a member\'s latest messages in a conversation:',
    `  curl -s "$HALO_API_URL/api/teams/<teamId>/chat-messages?appId=<appId>&epochId=<epochId>" ${AUTH} | tail -c 4000`,
    '',
    'The last two need an epochId from the list. Pick the conversation by its label. If none fits or several do, ask, naming the labels. ' +
      'Never default to the newest or the active one, and never ask for ids. ' +
      'A failed read means you can\'t reach the team right now, not that it doesn\'t exist. ' +
      'For operations on another standing-team conversation, including messaging a member there, use halo_api_ref, group "team".',
  ].join('\n')
}
