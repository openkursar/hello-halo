/**
 * In-process MCP server exposing team coordination tools.
 * Topology violations return isError:true results so the LLM self-corrects.
 */

import { z } from 'zod'
import { tool, createSdkMcpServer } from '../../../services/agent/resolved-sdk'
import { TEAM_MCP_SERVER_NAME, TEAM_TOOL_NAMES } from '../../../../shared/apps/team-types'
import { TeamBusError } from './message-bus'
import type { MessageBus } from './message-bus'
import type { Blackboard } from './blackboard'
import type { CollabMode, TaskStatus } from '../../../../shared/apps/team-types'

const LOG_TAG = '[TeamTools]'

type SdkMcpServer = ReturnType<typeof createSdkMcpServer>

export interface TeamMcpContext {
  teamId: string
  epochId: string
  callerAppId: string
  collabMode: CollabMode
  selfIsLead: boolean
  bus: MessageBus
  blackboard: Blackboard
  /** Deferred: applied after the lead's turn ends, never aborts mid-turn. */
  requestComplete: (summary: string) => void
}

const TASK_STATUS_VALUES = ['pending', 'in_progress', 'done', 'rejected', 'blocked'] as const

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  }
}

function busErrorResult(err: unknown) {
  if (err instanceof TeamBusError) return textResult(err.message, true)
  const message = err instanceof Error ? err.message : String(err)
  return textResult(`Team operation failed: ${message}`, true)
}

function buildSendTool(ctx: TeamMcpContext) {
  return tool(
    TEAM_TOOL_NAMES.send,
    'Send a directed message to a teammate. The message becomes the input of ' +
      "the teammate's next turn.\n\n" +
      'Set wait=false (default) for async: you get a messageId now and the reply ' +
      'arrives later as a new turn. Set wait=true to block until the teammate ' +
      'reports back (use sparingly — only when you truly need just this one reply).\n\n' +
      'Put large outputs on disk and pass the path in the board, not in the message.\n\n' +
      'Example: { "to": "researcher", "message": "Do task T1, details on the board", "wait": false }',
    {
      to: z.string().describe('Target teammate name (member name within this team).'),
      message: z.string().describe('Message body. Keep it directive and self-contained.'),
      wait: z
        .boolean()
        .optional()
        .describe('Block until the teammate reports back. Defaults to false (async).'),
    },
    async (input) => {
      console.log(
        `${LOG_TAG} ${TEAM_TOOL_NAMES.send}: team=${ctx.teamId} from=${ctx.callerAppId} ` +
          `to="${input.to}" wait=${input.wait ?? false}`
      )
      try {
        const toAppId = ctx.bus.resolveMemberAppId(ctx.teamId, input.to)
        ctx.bus.assertCanContact(ctx.teamId, ctx.callerAppId, toAppId, ctx.collabMode)

        const result = await ctx.bus.send({
          teamId: ctx.teamId,
          epochId: ctx.epochId,
          fromAppId: ctx.callerAppId,
          to: input.to,
          message: input.message,
          wait: input.wait ?? false,
        })

        if ('messageId' in result) {
          return textResult(
            `Message sent (id: ${result.messageId}). The reply will arrive later as a new turn.`
          )
        }
        if (result.status === 'timeout') {
          return textResult(
            `No reply from "${result.from}" within the time limit. Proceed without it or follow up.`
          )
        }
        return textResult(`Reply from "${result.from}": ${result.message}`)
      } catch (err) {
        return busErrorResult(err)
      }
    }
  )
}

function buildPostTaskTool(ctx: TeamMcpContext) {
  return tool(
    TEAM_TOOL_NAMES.postTask,
    'Create a blackboard task and assign it to a teammate. Tasks should be ' +
      'self-contained — a member must be able to execute one without the global ' +
      'context.\n\n' +
      'Example: { "title": "Scrape competitors", "assignee": "researcher" }',
    {
      title: z.string().describe('Short, self-contained task title.'),
      assignee: z.string().describe('Teammate name to assign the task to.'),
      parentId: z.string().optional().describe('Optional parent task id for subtasks.'),
    },
    async (input) => {
      console.log(
        `${LOG_TAG} ${TEAM_TOOL_NAMES.postTask}: team=${ctx.teamId} assignee="${input.assignee}" ` +
          `title="${input.title.slice(0, 60)}"`
      )
      try {
        const assigneeAppId = ctx.bus.resolveMemberAppId(ctx.teamId, input.assignee)
        ctx.bus.assertCanContact(ctx.teamId, ctx.callerAppId, assigneeAppId, ctx.collabMode)

        const { taskId } = ctx.blackboard.postTask({
          teamId: ctx.teamId,
          epochId: ctx.epochId,
          callerAppId: ctx.callerAppId,
          title: input.title,
          assigneeAppId,
          parentId: input.parentId,
        })
        return textResult(`Task created (id: ${taskId}), assigned to "${input.assignee}".`)
      } catch (err) {
        return busErrorResult(err)
      }
    }
  )
}

function buildUpdateTaskTool(ctx: TeamMcpContext) {
  return tool(
    TEAM_TOOL_NAMES.updateTask,
    'Update a blackboard task: set its status, attach a result reference (file ' +
      'path), or add a note. Update your own task when you finish it; the lead ' +
      'may update any task.\n\n' +
      'Example: { "taskId": "...", "status": "done", "resultRef": "competitors.md" }',
    {
      taskId: z.string().describe('Id of the task to update.'),
      status: z
        .enum(TASK_STATUS_VALUES)
        .describe('New task status: pending | in_progress | done | rejected | blocked.'),
      resultRef: z.string().optional().describe('Reference to a produced artifact (file path).'),
      note: z.string().optional().describe('Short note (e.g. rejection reason or blocker).'),
    },
    async (input) => {
      console.log(
        `${LOG_TAG} ${TEAM_TOOL_NAMES.updateTask}: team=${ctx.teamId} task=${input.taskId} ` +
          `status=${input.status}`
      )
      try {
        ctx.blackboard.updateTask({
          teamId: ctx.teamId,
          epochId: ctx.epochId,
          taskId: input.taskId,
          status: input.status as TaskStatus,
          resultRef: input.resultRef,
          note: input.note,
        })
        return textResult(`Task ${input.taskId} updated to "${input.status}".`)
      } catch (err) {
        return busErrorResult(err)
      }
    }
  )
}

function buildPostFindingTool(ctx: TeamMcpContext) {
  return tool(
    TEAM_TOOL_NAMES.postFinding,
    'Append a shared finding to the blackboard (append-only; any member may ' +
      'add). Use it to share an observation or a produced artifact with the ' +
      'whole team.\n\n' +
      'Provide at least one of content or ref.\n\n' +
      'Example: { "content": "Competitor X dropped prices 20%", "ref": "notes.md" }',
    {
      content: z.string().optional().describe('Free-text finding. Required if ref is omitted.'),
      ref: z.string().optional().describe('Reference to a file/artifact. Required if content is omitted.'),
    },
    async (input) => {
      if (!input.content && !input.ref) {
        return textResult('You must provide at least one of "content" or "ref".', true)
      }
      console.log(`${LOG_TAG} ${TEAM_TOOL_NAMES.postFinding}: team=${ctx.teamId} from=${ctx.callerAppId}`)
      try {
        const { findingId } = ctx.blackboard.postFinding({
          teamId: ctx.teamId,
          epochId: ctx.epochId,
          callerAppId: ctx.callerAppId,
          content: input.content,
          ref: input.ref,
        })
        return textResult(`Finding posted (id: ${findingId}).`)
      } catch (err) {
        return busErrorResult(err)
      }
    }
  )
}

function buildReadBoardTool(ctx: TeamMcpContext) {
  return tool(
    TEAM_TOOL_NAMES.readBoard,
    'Read the team blackboard: tasks, findings, and the member roster. Use this ' +
      'to reconcile state instead of relying on your own (compactable) context.\n\n' +
      'Optional filters: { "mine": true } for tasks assigned to you, ' +
      '{ "status": "pending" } for tasks in a given state.',
    {
      mine: z.boolean().optional().describe('Only tasks assigned to you.'),
      status: z
        .enum(TASK_STATUS_VALUES)
        .optional()
        .describe('Only tasks in this status.'),
    },
    async (input) => {
      console.log(
        `${LOG_TAG} ${TEAM_TOOL_NAMES.readBoard}: team=${ctx.teamId} epoch=${ctx.epochId} ` +
          `mine=${input.mine ?? false} status=${input.status ?? 'any'}`
      )
      try {
        const snapshot = ctx.blackboard.readBoard(ctx.teamId, ctx.epochId, ctx.callerAppId, {
          mine: input.mine,
          status: input.status as TaskStatus | undefined,
        })
        return textResult(JSON.stringify(snapshot))
      } catch (err) {
        return busErrorResult(err)
      }
    }
  )
}

function buildCompleteTool(ctx: TeamMcpContext) {
  return tool(
    TEAM_TOOL_NAMES.complete,
    'End the team run. Call this ONLY when the whole goal is achieved and every ' +
      'required task is verified done. Provide a concise summary of what the team ' +
      'produced and where the artifacts are. Only the team lead may call this.\n\n' +
      'Example: { "summary": "Daily competitor brief produced at brief.md" }',
    {
      summary: z.string().describe('Concise summary of the completed run.'),
    },
    async (input) => {
      if (!ctx.selfIsLead) {
        return textResult('Only the team lead can end the run (team_complete).', true)
      }
      console.log(`${LOG_TAG} ${TEAM_TOOL_NAMES.complete}: team=${ctx.teamId} epoch=${ctx.epochId}`)
      try {
        ctx.requestComplete(input.summary)
        return textResult(
          'Run will be sealed after this turn ends. The epoch and all member ' +
            'transcripts are preserved as history. End your turn now.'
        )
      } catch (err) {
        return busErrorResult(err)
      }
    }
  )
}

export function createTeamMcpServer(context: TeamMcpContext): SdkMcpServer {
  const tools = [
    buildSendTool(context),
    buildPostTaskTool(context),
    buildUpdateTaskTool(context),
    buildPostFindingTool(context),
    buildReadBoardTool(context),
    buildCompleteTool(context),
  ]

  console.log(
    `${LOG_TAG} ${TEAM_MCP_SERVER_NAME} created: team=${context.teamId} ` +
      `caller=${context.callerAppId} collabMode=${context.collabMode}`
  )

  return createSdkMcpServer({
    name: TEAM_MCP_SERVER_NAME,
    version: '1.0.0',
    tools,
  })
}
