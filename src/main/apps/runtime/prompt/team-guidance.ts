/**
 * apps/runtime/prompt -- Team Guidance
 *
 * One section for everything a digital human is told about teams: the two kinds
 * (an agent team it spins up for a job, a standing team it belongs to), how to
 * run the first, and how to look into the second through Halo's own API so a
 * person can ask about team work from any chat — its own chat in Halo, an IM
 * chat bound to it, or a team-bound one.
 *
 * Only what is stable goes in: names, ids, roles and the conversation this chat
 * is. Live state (who is busy, what is open) is read on demand with the calls
 * listed here, so every turn of a session carries the same words. The paths are
 * this build's; `team-guidance.test.ts` keeps them exposed to AI.
 */

/** One standing team as the prompt shows it. */
export interface StandingTeam {
  teamId: string
  name: string
  role: string
  isLead: boolean
  /** Joined from another computer: what this one holds is a synced copy. */
  hostedElsewhere: boolean
}

/** The team conversation this chat is, when it is one. */
export interface CurrentTeamConversation {
  teamName: string
  epochId: string
  viaIm: boolean
}

export interface TeamGuidanceInput {
  /**
   * The usage guide of the agent-team tools, present only when this chat holds
   * them. It already defines both kinds of team, so the standing-team part
   * continues it instead of defining them again.
   */
  agentTeamGuide?: string
  teams: StandingTeam[]
  current?: CurrentTeamConversation
}

/**
 * Teams listed by name; the rest are one read away. Each line carries a full
 * team id, so the list is bounded rather than the person's whole office.
 */
export const STANDING_TEAM_LIST_LIMIT = 10

/**
 * The Operate Halo calls the guidance names, exactly as the manual lists them.
 * Reads only: messaging a member is left to the manual, which carries the rules
 * for it.
 */
export const STANDING_TEAM_PATHS = [
  'GET /api/teams/:teamId/conversations',
  'GET /api/teams/:teamId/epochs/:epochId/board',
  'GET /api/teams/:teamId/chat-messages',
] as const

const STANDING_TEAM_DEFINITION =
  'A standing team is a lasting group of digital humans in Halo, each with a role, pursuing its own goal over time.'

const AUTH = '-H "Authorization: Bearer $HALO_API_TOKEN"'

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function teamLine(team: StandingTeam): string {
  const role = oneLine(team.role, 40) || 'member'
  const copy = team.hostedElsewhere ? '; on another computer, reads may be a synced copy' : ''
  return `- ${oneLine(team.name, 60)} (teamId ${team.teamId}) — your role: ${role}${team.isLead ? ' (lead)' : ''}${copy}`
}

function currentLine(current: CurrentTeamConversation | undefined): string {
  if (!current) return 'This chat is your own, outside all of them. When the person says "the team" without naming one and you have not started an agent team here, they mean one of these.'
  const kind = current.viaIm ? 'an IM conversation' : 'one conversation'
  return `This chat is ${kind} of ${oneLine(current.teamName, 60)} (epochId ${current.epochId}): your team tools act on it, and the calls below are for the team's other conversations. ` +
    'If a teammate woke you, stay with this conversation and ask that teammate, not the person.'
}

function standingSection(input: TeamGuidanceInput): string[] {
  const shown = [...input.teams]
    .sort((a, b) => a.name.localeCompare(b.name) || a.teamId.localeCompare(b.teamId))
    .slice(0, STANDING_TEAM_LIST_LIMIT)
  const hidden = input.teams.length - shown.length
  return [
    input.agentTeamGuide ? '### Your standing teams' : `## Your standing teams\n${STANDING_TEAM_DEFINITION}`,
    'You belong to these and are the same person in each:',
    ...shown.map(teamLine),
    ...(hidden > 0 ? [`- …${hidden} more: GET $HALO_API_URL/api/teams lists them all; yours are the ones whose localMembers include you`] : []),
    currentLine(input.current),
    '',
    'A standing team\'s work happens in its conversations: a task, an IM chat, a one-to-one chat with a member. Each has its own board and messages. ' +
      'Turn to a standing team only when the request concerns its work, and read its current state before you answer; memory is only a hint. ' +
      'Run these with Bash, as written, and use only what the request needs:',
    '',
    '- List a team\'s conversations (each has an epochId, a label, and whether it is active or completed):',
    `  curl -s "$HALO_API_URL/api/teams/<teamId>/conversations" ${AUTH}`,
    '- Read one conversation\'s tasks, findings and members (each member has an appId):',
    `  curl -s "$HALO_API_URL/api/teams/<teamId>/epochs/<epochId>/board" ${AUTH}`,
    '- Read a member\'s latest messages in a conversation:',
    `  curl -s "$HALO_API_URL/api/teams/<teamId>/chat-messages?appId=<appId>&epochId=<epochId>" ${AUTH} | tail -c 4000`,
    '',
    'The last two need an epochId from the list. Pick the conversation by its label. If none fits or several do, ask, naming the labels. ' +
      'Never default to the newest or the active one, and never ask for ids. ' +
      'A failed read means you can\'t reach the team right now, not that it doesn\'t exist. ' +
      'For anything else about a team, such as messaging a member: halo_api_ref, group "team".',
  ]
}

/**
 * The section, or null when this chat has neither agent-team tools nor a
 * standing team. Callers decide whether this turn may operate Halo at all; the
 * standing-team calls need it.
 */
export function buildTeamGuidance(input: TeamGuidanceInput): string | null {
  const parts: string[] = []
  if (input.agentTeamGuide) parts.push(input.agentTeamGuide)
  if (input.teams.length > 0) parts.push(standingSection(input).join('\n'))
  return parts.length > 0 ? parts.join('\n\n') : null
}
