/**
 * apps/runtime/prompt -- Team Awareness
 *
 * Tells a digital human which teams it belongs to and how to look into their
 * work through Halo's own API, so a person can ask it about team work from any
 * chat — its own chat in Halo, an IM chat bound to it, or a team-bound one —
 * without knowing how Halo separates those conversations.
 *
 * Only what is stable goes in: names, ids, roles and the conversation this chat
 * is. Live state (who is busy, what is open) is read on demand with the calls
 * listed here, so every turn of a session carries the same words. The paths are
 * this build's; `team-awareness.test.ts` keeps them exposed to AI.
 */

/** One team as the prompt shows it. */
export interface TeamAwarenessTeam {
  teamId: string
  name: string
  role: string
  isLead: boolean
  /** Joined from another computer: what this one holds is a synced copy. */
  hostedElsewhere: boolean
}

/** The team conversation this chat is, when it is one. */
export interface TeamAwarenessCurrent {
  teamName: string
  epochId: string
  viaIm: boolean
}

export interface TeamAwarenessInput {
  teams: TeamAwarenessTeam[]
  current?: TeamAwarenessCurrent
  /**
   * This chat also holds the tools a person uses to start a collaboration from
   * it (team_send, team_read_board, team_run), whose names say "team" too.
   */
  collaborationToolsHere?: boolean
}

/**
 * Teams listed by name; the rest are one read away. Each line carries a full
 * team id, so the list is bounded rather than the person's whole office.
 */
export const TEAM_AWARENESS_LIST_LIMIT = 10

/** The Operate Halo calls the guidance names, exactly as the manual lists them. */
export const TEAM_AWARENESS_PATHS = [
  'GET /api/teams/:teamId/conversations',
  'GET /api/teams/:teamId/epochs/:epochId/board',
  'GET /api/teams/:teamId/chat-messages',
  'POST /api/teams/:teamId/members/:appId/send',
] as const

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function teamLine(team: TeamAwarenessTeam): string {
  const role = oneLine(team.role, 40) || 'member'
  const copy = team.hostedElsewhere ? '; on another computer, reads may be a synced copy' : ''
  return `- ${oneLine(team.name, 60)} [id ${team.teamId}] — your role: ${role}${team.isLead ? ' (lead)' : ''}${copy}`
}

function currentLine(current: TeamAwarenessCurrent | undefined, collaborationToolsHere: boolean): string {
  if (!current) {
    return 'This chat is your own conversation, outside them.' + (collaborationToolsHere
      ? ' Here team_send and team_read_board reach only a collaboration started in this chat, and team_run and team_status start and ' +
        'follow new work you hand a whole saved team; to tell one member of the teams above something, send it into their conversation ' +
        'with the call below.'
      : '')
  }
  const kind = current.viaIm ? 'an IM conversation' : 'one conversation'
  return `This chat is ${kind} of ${oneLine(current.teamName, 60)} (epochId ${current.epochId}): ` +
    'for it use your team tools (team_send, team_read_board); the calls below are for the team\'s other conversations. ' +
    'If a teammate woke you, stay with this conversation: use the calls below only to read, and ask that teammate, not the person.'
}

/**
 * The fragment, or null when the digital human is in no team. Callers decide
 * whether this turn may operate Halo at all; the guidance names calls that need it.
 */
export function buildTeamAwarenessPrompt(input: TeamAwarenessInput): string | null {
  if (input.teams.length === 0) return null
  const shown = [...input.teams]
    .sort((a, b) => a.name.localeCompare(b.name) || a.teamId.localeCompare(b.teamId))
    .slice(0, TEAM_AWARENESS_LIST_LIMIT)
  const hidden = input.teams.length - shown.length
  return [
    '## Your teams',
    ...shown.map(teamLine),
    ...(hidden > 0 ? [`- …${hidden} more: read_digital_human_context, section "teams", lists them all`] : []),
    `A team works in conversations (tasks, IM chats, one-to-one member chats), each with its own context. ${currentLine(input.current, !!input.collaborationToolsHere)}`,
    '',
    'Look into a team only when the request concerns its work, then read its current state before answering; memory is a lead, not a fact. ' +
      'Operate Halo paths (current for this build, no lookup needed):',
    '- GET /api/teams/<teamId>/conversations — epochId, label, kind, active, completed',
    '- GET /api/teams/<teamId>/epochs/<epochId>/board — tasks, findings, members',
    '- GET /api/teams/<teamId>/chat-messages?appId=<memberAppId>&epochId=<epochId> — a member\'s messages; read the end (| tail -c 4000)',
    '- POST /api/teams/<teamId>/members/<appId>/send {"message","epochId"} — message a member in that conversation. It waits for the reply, ' +
      'which can take minutes: give the command a long timeout (600000 ms); if it still times out, read chat-messages there before deciding, never resend blindly.',
    'More: halo_api_ref, group "team".',
    'Choose the conversation whose label or board matches the request. If none clearly does, or several do, ask the person, naming the labels; ' +
      'never pick one because it is newest or active, and never ask for ids. completed: true has ended, so ask before sending there. ' +
      'A relayed message says who you are and whose words it carries; then tell the person where it went and whether it was delivered, queued or not. ' +
      'A failed or stale read means "can\'t reach it now", not "doesn\'t exist" or "not my team".',
  ].join('\n')
}
