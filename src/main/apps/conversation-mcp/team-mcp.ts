/**
 * Space-facing Team MCP server — the space side of the `halo-team` toolset.
 *
 * Shares its name with the member-side server (`runtime/team/team-tools.ts`):
 * one capability, two packagings, and a session only ever receives one of them
 * (member turns build their MCP record in `app-chat.ts`, which never goes
 * through the toolset broker). The tool surfaces differ — that difference
 * belongs in the tool list, not in the server name.
 *
 * The space agent is a first-class team coordinator here, with two distinct
 * modes:
 *
 * - Temporary collaboration: `collab_start` assembles an ephemeral team whose
 *   coordinator IS this space conversation. The agent then drives members
 *   directly with the same coordination tools team members use (team_send,
 *   team_post_task, the board, artifacts) — member replies and turn-end
 *   notices arrive back in this conversation as new turns. `collab_save`
 *   keeps the team for later.
 *
 * - Delegation: `team_run` hands a brief to a SAVED team's own lead and
 *   returns; `team_status` reads its progress. The space agent stays the
 *   user's assistant, not that team's coordinator.
 *
 * The coordination tools resolve their team context PER CALL (the current
 * collaboration of this conversation), so `collab_start` and the first
 * `team_send` work inside one turn with no session rebuild.
 */

import { z } from 'zod'
import { tool, createSdkMcpServer } from '../../services/agent/resolved-sdk'
import { getTeamService } from '../team'
import { getActiveTeamRuntime } from '../runtime/team'
import { buildCoordinationTools } from '../runtime/team/team-tools'
import type { TeamMcpContext } from '../runtime/team/team-tools'
import {
  AI_MEMBER_HARD_LIMIT,
  SPACE_COORDINATOR_MEMBER_NAME,
  SPACE_TEAM_TOOL_NAMES,
  TEAM_MCP_SERVER_NAME,
  spaceCoordinatorAppId,
} from '../../../shared/apps/team-types'
import type { TeamListItem } from '../../../shared/apps/team-types'
import type { TeamService } from '../team'

type TeamMcpResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

const LOG_TAG = '[SpaceTeamMcp]'

/** System prompt appended while this toolset is enabled (registry usageGuide). */
export const TEAM_TOOLSET_GUIDE =
  'Team collaboration is enabled. You can assemble a temporary team of AI members and coordinate ' +
  'them yourself, or delegate work to a saved team.\n\n' +
  'Temporary collaboration (you are the coordinator):\n' +
  '- Use it only when the work benefits from parallel execution, distinct specialties, or ' +
  'independent review. For ordinary tasks, just do the work yourself.\n' +
  '- `collab_start` creates the team; then dispatch with `team_send` / `team_post_task`. Each ' +
  'dispatch must be self-contained: the member sees none of this conversation, so include the ' +
  'goal, the inputs, the success criteria and the expected output form.\n' +
  '- Sending a message is not completion. Members work in the background and their replies and ' +
  'turn-end notices arrive as new turns of yours; reconcile with `team_read_board` instead of ' +
  'guessing, and read deliverables with `team_read_artifact`.\n' +
  '- Never claim work is done that a member has not reported done. When the goal is met, call ' +
  '`team_complete` with a summary. If the user wants to keep the team, call `collab_save`.\n' +
  '- The user can watch the whole collaboration in the Team view (Content Canvas); mention it ' +
  'once when a collaboration starts.\n\n' +
  'Saved teams (delegation):\n' +
  '- `team_list` shows the saved teams of this space. Prefer reusing one over assembling a ' +
  'similar temporary team.\n' +
  '- `team_run` hands a run brief to the team\u2019s own lead and returns immediately; the team ' +
  'works autonomously. Do not poll — check `team_status` when the user asks how it is going.\n' +
  '- Creating or saving a persistent team is only done when the user explicitly asks for it.'

function textResult(text: string, isError = false): TeamMcpResult {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  }
}

const NOT_READY = 'Team services are still starting. Please try again in a moment.'

function describeMemberStatus(status: string): string {
  return status === 'working' ? 'working' : status === 'waiting_user' ? 'waiting for the user' : status
}

export interface SpaceTeamMcpScope {
  spaceId: string
  conversationId: string
  workDir: string
}

export function createSpaceTeamMcpServer(scope: SpaceTeamMcpScope) {
  const { spaceId, conversationId, workDir } = scope

  /**
   * The coordination tools' team context: the ACTIVE collaboration bound to
   * this conversation, looked up per call. Null before `collab_start` and
   * after `team_complete`.
   */
  function resolveCollabContext(): TeamMcpContext | null {
    const service = getTeamService()
    const runtime = getActiveTeamRuntime()
    if (!service || !runtime) return null
    const collab = service.getCollabForConversation(conversationId)
    if (!collab || !collab.active) return null
    const team = service.getTeam(collab.teamId)
    if (!team) return null
    return {
      teamId: collab.teamId,
      epochId: collab.epochId,
      callerAppId: spaceCoordinatorAppId(conversationId),
      collabMode: team.collabMode,
      selfIsLead: true,
      bus: runtime.bus,
      blackboard: runtime.blackboard,
      callerWorkDir: workDir,
      ...(runtime.readArtifact ? { readArtifact: runtime.readArtifact } : {}),
      digest: runtime.digest,
      archive: runtime.archive,
      requestComplete: (summary) => {
        void service.completeCollab(collab.teamId, summary).catch((err) => {
          console.error(`${LOG_TAG} completeCollab failed: team=${collab.teamId}`, err)
        })
      },
    }
  }

  const collab_start = tool(
    SPACE_TEAM_TOOL_NAMES.collabStart,
    'Assemble a temporary team for the current piece of work and become its coordinator. ' +
      'Members are AI agents created for this collaboration only (they do not appear in the ' +
      'people directory). After this succeeds, dispatch work with team_send or team_post_task ' +
      'in this same turn — replies arrive later as new turns of yours.\n\n' +
      'Use only when the task genuinely benefits from parallel roles. One collaboration per ' +
      'conversation: finish the current one (team_complete) before starting another.',
    {
      name: z.string().min(1).describe('Short human-readable name for this collaboration, in the user\u2019s language.'),
      goal: z.string().min(1).describe('The outcome this collaboration must deliver.'),
      members: z
        .array(
          z.object({
            memberName: z.string().min(1).describe('Short unique handle used for addressing (e.g. "researcher").'),
            role: z.string().min(1).describe('2-4 word role.'),
            responsibility: z.string().min(1).describe('One concise sentence: what this member is responsible for.'),
          })
        )
        .min(1)
        .max(AI_MEMBER_HARD_LIMIT)
        .describe(`Member roles (1-${AI_MEMBER_HARD_LIMIT}). Keep the team as small as the work allows.`),
    },
    async ({ name, goal, members }) => {
      const service = getTeamService()
      if (!service) return textResult(NOT_READY, true)
      try {
        const { team } = await service.createCollab({
          owningSpaceId: spaceId,
          conversationId,
          name,
          goal,
          members,
        })
        const roster = members
          .map((m) => `- ${m.memberName} (${m.role}) — ${m.responsibility}`)
          .join('\n')
        return textResult(
          `Collaboration "${team.name}" is ready (team id: ${team.id}). Members:\n${roster}\n\n` +
            `You are the coordinator ("${SPACE_COORDINATOR_MEMBER_NAME}"). Dispatch self-contained work with ` +
            'team_send or team_post_task now. Members reply asynchronously — their messages and turn-end ' +
            'notices arrive as new turns. Tell the user the team is working and that they can watch it in ' +
            'the Team view.'
        )
      } catch (error) {
        console.error(`${LOG_TAG} collab_start failed: conversation=${conversationId}`, error)
        return textResult(`Could not start the collaboration: ${(error as Error).message}`, true)
      }
    }
  )

  const collab_save = tool(
    SPACE_TEAM_TOOL_NAMES.collabSave,
    'Keep the current collaboration as a persistent team: its members, roles and history stay ' +
      'available in the Teams list, and it can be run again later with team_run. The current ' +
      'work continues uninterrupted. Call only when the user asks to keep the team.',
    {
      name: z.string().optional().describe('Optional new team name; defaults to the collaboration name.'),
    },
    async ({ name }) => {
      const service = getTeamService()
      if (!service) return textResult(NOT_READY, true)
      const collab = service.getCollabForConversation(conversationId)
      if (!collab) return textResult('There is no collaboration in this conversation to save.', true)
      if (collab.saved) return textResult(`This team is already saved ("${collab.name}").`)
      try {
        const team = service.saveCollab(collab.teamId, name)
        return textResult(
          `Saved as team "${team.name}" (id: ${team.id}). The current work continues; later the team ` +
            'can be run on new tasks with team_run.'
        )
      } catch (error) {
        console.error(`${LOG_TAG} collab_save failed: team=${collab.teamId}`, error)
        return textResult(`Could not save the team: ${(error as Error).message}`, true)
      }
    }
  )

  const persistentTeams = (service: TeamService): TeamListItem[] =>
    service.listTeamItems(spaceId).filter((team) => !team.ephemeral)

  const team_list = tool(
    SPACE_TEAM_TOOL_NAMES.list,
    'List the saved teams of this space (id, members, status). Check here before assembling a ' +
      'temporary team that duplicates an existing one.',
    {},
    async () => {
      const service = getTeamService()
      if (!service) return textResult(NOT_READY, true)
      try {
        const teams = persistentTeams(service)
        if (teams.length === 0) return textResult('No saved teams exist in this space yet.')
        return textResult(
          teams
            .map((team) => `- ${team.name} (id: ${team.id}) — ${team.memberCount} members, status: ${team.status}`)
            .join('\n')
        )
      } catch (error) {
        console.error(`${LOG_TAG} team_list failed: space=${spaceId}`, error)
        return textResult(`Could not list teams: ${(error as Error).message}`, true)
      }
    }
  )

  const team_run = tool(
    SPACE_TEAM_TOOL_NAMES.run,
    'Delegate a run to a saved team: its own lead receives the brief, dispatches the members and ' +
      'finishes autonomously. Returns as soon as the run starts — do not wait or poll; use ' +
      'team_status when the user asks for progress. Use team_list first when the user names a team.',
    {
      teamId: z.string().min(1).describe('The saved team id from team_list.'),
      instruction: z
        .string()
        .optional()
        .describe('This run\u2019s concrete brief: what to do, inputs, success criteria, expected output.'),
    },
    async ({ teamId, instruction }) => {
      const service = getTeamService()
      if (!service) return textResult(NOT_READY, true)
      const team = service.getTeam(teamId)
      if (!team || team.owningSpaceId !== spaceId) {
        return textResult('That team is not available in the current space.', true)
      }
      if (team.ephemeral) {
        return textResult(
          'That is the current temporary collaboration — you coordinate it directly with team_send; ' +
            'team_run is for saved teams.',
          true
        )
      }
      try {
        await service.runTeam(teamId, { type: 'manual' }, instruction)
        return textResult(
          `Delegated to "${team.name}" — its lead is briefing the members now. The run continues in the ` +
            'background; check team_status for progress. The user can watch it in the Team view.'
        )
      } catch (error) {
        console.error(`${LOG_TAG} team_run failed: team=${teamId}`, error)
        return textResult(`Could not start "${team.name}": ${(error as Error).message}`, true)
      }
    }
  )

  const team_status = tool(
    SPACE_TEAM_TOOL_NAMES.status,
    'Bounded progress snapshot of a saved team\u2019s latest run: member states, task counts, open ' +
      'tasks, latest findings and any decision waiting on the user.',
    {
      teamId: z.string().min(1).describe('The team id from team_list or team_run.'),
    },
    async ({ teamId }) => {
      const service = getTeamService()
      if (!service) return textResult(NOT_READY, true)
      const detail = service.getTeamDetail(teamId)
      if (!detail || detail.team.owningSpaceId !== spaceId) {
        return textResult('That team is not available in the current space.', true)
      }
      try {
        const lines: string[] = [`Team "${detail.team.name}" — status: ${detail.team.status}`]
        const members = detail.roster.filter((m) => !m.isLead)
        if (members.length > 0) {
          lines.push('Members:')
          for (const m of members) {
            const task = m.currentTaskTitle ? ` — on "${m.currentTaskTitle}"` : ''
            lines.push(`- ${m.memberName} (${m.role}): ${describeMemberStatus(m.status)}${task}`)
          }
        }
        const done = detail.tasks.filter((t) => t.status === 'done').length
        lines.push(`Tasks: ${done}/${detail.tasks.length} done`)
        const open = detail.tasks.filter((t) => t.status !== 'done' && t.status !== 'rejected').slice(0, 10)
        for (const t of open) lines.push(`- [${t.status}] ${t.title}`)
        const findings = detail.findings.slice(-3)
        if (findings.length > 0) {
          lines.push('Latest findings:')
          for (const f of findings) lines.push(`- ${f.body ?? f.ref ?? ''}`.slice(0, 200))
        }
        if (detail.pendingEscalations && detail.pendingEscalations.length > 0) {
          lines.push('Waiting on the user:')
          for (const e of detail.pendingEscalations.slice(0, 5)) {
            lines.push(`- ${e.memberName}: ${e.question}`.slice(0, 200))
          }
        }
        return textResult(lines.join('\n'))
      } catch (error) {
        console.error(`${LOG_TAG} team_status failed: team=${teamId}`, error)
        return textResult(`Could not read the team status: ${(error as Error).message}`, true)
      }
    }
  )

  return createSdkMcpServer({
    name: TEAM_MCP_SERVER_NAME,
    version: '1.0.0',
    tools: [
      collab_start,
      ...buildCoordinationTools(resolveCollabContext),
      collab_save,
      team_list,
      team_run,
      team_status,
    ],
  })
}
