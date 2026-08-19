/**
 * In-process MCP server exposing team coordination tools.
 * Topology violations return isError:true results so the LLM self-corrects.
 */

import { z } from 'zod'
import { tool, createSdkMcpServer } from '../../../services/agent/resolved-sdk'
import { TEAM_MCP_SERVER_NAME, TEAM_TOOL_NAMES, toActivitySubject } from '../../../../shared/apps/team-types'
import { TeamBusError } from './message-bus'
import { TeamCheckError, describeSchedule } from './checks'
import { resolveArtifactRef, explainArtifactRefRejection, formatArtifactSize } from './artifact-path'
import { renderBoardMarkdown } from './board-render'
import type { MessageBus } from './message-bus'
import type { Blackboard, PostActivityInput, PublishedRefClaim } from './blackboard'
import type { TeamChecks } from './checks'
import type { BoardDigest } from './board-digest'
import type { BoardArchive } from './board-archive'
import type { ReadTeamArtifact } from './index'
import type { CollabMode, TaskStatus, TeamCheckSchedule } from '../../../../shared/apps/team-types'

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
  /**
   * The caller's working directory — the same one its agent runs in. Published
   * refs are resolved against it, which is why the value must come from the turn
   * that owns the agent rather than be looked up here.
   */
  callerWorkDir: string
  /**
   * Location-transparent read of a published team artifact. Absent → the tool is
   * still registered but reports the capability is unavailable (non-federated
   * test runtimes).
   */
  readArtifact?: ReadTeamArtifact
  /**
   * Periodic checks on teammates. Absent → the tools report the capability is
   * unavailable rather than silently doing nothing (non-federated test runtimes).
   */
  checks?: TeamChecks
  /**
   * What this member has missed. Appended to a board read so the nudge lands at
   * the moment the member is already thinking about coordination. Absent → the
   * read returns the snapshot alone.
   */
  digest?: BoardDigest
  /**
   * Exports the acts a board read leaves out, so the reader can reach them. Absent
   * → a long history is still reported as partial, but with nowhere to go for the
   * rest (test runtimes).
   */
  archive?: BoardArchive
  /**
   * Forward depth of the turn these tools serve. A `team_send` inherits it so the
   * circuit breaker sees one chain across hops instead of a fresh chain per
   * member. Absent → the caller's turn had no chain behind it (depth 0).
   */
  forwardDepth?: number
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

/**
 * Record an act that changed the board. Messages are NOT recorded here — the bus
 * records those, because it is the one point every message path passes through.
 *
 * `subject` carries the CONTENT (a task title, an instruction), never a composed
 * sentence: the feed is rendered in the user's language and the digest phrases
 * itself for an agent, so each surface writes its own wording around the kind.
 *
 * Bookkeeping never breaks the act: the write already succeeded when we get here.
 */
function record(ctx: TeamMcpContext, input: Omit<PostActivityInput, 'teamId' | 'epochId' | 'actorAppId'>): void {
  try {
    ctx.blackboard.postActivity({
      teamId: ctx.teamId,
      epochId: ctx.epochId,
      actorAppId: ctx.callerAppId,
      ...input,
    })
  } catch (err) {
    console.error(`${LOG_TAG} failed to record ${input.kind} (the write itself stands):`, err)
  }
}

/**
 * A ref is checked the moment it is published, not the moment someone tries to
 * read it. Publishing something unreadable used to succeed here and fail hours
 * later on another machine, leaving the publisher believing it had shared the
 * file and the reader believing it had never been sent — neither holding enough
 * of the truth to fix it. The stored form is the portable one this returns.
 *
 * The uniqueness check has the same shape: a ref is a path inside the publisher's
 * OWN working directory, so two members reach for one name and the board holds a
 * single indistinguishable string. Here is the last instant they can be told
 * apart, and the member holding the file is the one who can rename it.
 */
function acceptRef(
  ctx: TeamMcpContext,
  ref: string,
  claim: PublishedRefClaim
): { ok: true; ref: string; receipt: string } | { ok: false; message: string } {
  const resolved = resolveArtifactRef(ctx.callerWorkDir, ref)
  if (!resolved.ok) {
    console.warn(
      `${LOG_TAG} rejected ref="${ref}" from=${ctx.callerAppId} workDir="${ctx.callerWorkDir}": ${resolved.reason}`
    )
    return {
      ok: false,
      message: explainArtifactRefRejection(resolved.reason, { ref, workDir: ctx.callerWorkDir }),
    }
  }
  // Compared in the STORED form: two refs collide as the board holds them, not
  // as they were typed.
  const conflict = ctx.blackboard.findPublishedRefConflict({
    teamId: ctx.teamId,
    epochId: ctx.epochId,
    ref: resolved.ref,
    claim,
  })
  if (conflict) {
    console.warn(
      `${LOG_TAG} rejected ref="${resolved.ref}" from=${ctx.callerAppId}: already published by ${conflict.memberName}`
    )
    return {
      ok: false,
      message:
        `${conflict.memberName} has already published "${resolved.ref}" in this piece of work, and ` +
        'a published name must belong to one member only — otherwise a teammate opening it cannot ' +
        'tell whose file they are reading. Rename your file to a name that is yours alone (adding ' +
        'your member name to it works), then use that reference instead.',
    }
  }
  return {
    ok: true,
    ref: resolved.ref,
    // Echo the stored form: an absolute path the member passed in was folded to
    // a relative one, and it must see the ref teammates will actually use.
    receipt: `"${resolved.ref}" (${formatArtifactSize(resolved.bytes)})`,
  }
}

function busErrorResult(err: unknown) {
  if (err instanceof TeamBusError || err instanceof TeamCheckError) return textResult(err.message, true)
  const message = err instanceof Error ? err.message : String(err)
  return textResult(`Team operation failed: ${message}`, true)
}

function buildSendTool(ctx: TeamMcpContext) {
  return tool(
    TEAM_TOOL_NAMES.send,
    'Send a message to a teammate. This is the ONLY way to reach one — your own ' +
      'output is not shown to teammates, so anything you do not send here, they ' +
      'never see.\n\n' +
      "The message becomes the input of the teammate's next turn. This call " +
      'returns as soon as the message is handed over; if they answer, it arrives ' +
      'later as a new turn of yours — so do not sit and wait for it.\n\n' +
      'Put large outputs on disk and share the path, not the text.\n\n' +
      'Example: { "to": "researcher", "message": "Do task T1, details on the board" }',
    {
      to: z.string().describe('Target teammate name (member name within this team).'),
      message: z.string().describe('Message body. Keep it directive and self-contained.'),
    },
    async (input) => {
      console.log(
        `${LOG_TAG} ${TEAM_TOOL_NAMES.send}: team=${ctx.teamId} from=${ctx.callerAppId} to="${input.to}"`
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
          forwardDepth: ctx.forwardDepth,
        })
        // A teammate send is always async; the sync receipt shape is unreachable
        // from here (only a person's 1:1 chat asks for one).
        if (!('messageId' in result)) {
          return textResult(`Message sent to "${input.to}".`)
        }

        if (result.delivery === 'undelivered') {
          // Do NOT report success: the teammate's owner is offline/unreachable and
          // there is no offline queue, so this will not arrive later.
          return textResult(
            `"${input.to}" is offline right now — this message was NOT delivered and will not be queued. ` +
              `Reassign the work, or wait until they are back online and send again.`
          )
        }
        if (result.delivery === 'queued') {
          return textResult(
            `Message queued for "${input.to}" (id: ${result.messageId}). They are busy with another turn ` +
              `right now; it will be delivered the moment that turn ends. If this is urgent, consider ` +
              `another teammate.`
          )
        }
        return textResult(
          `Message delivered to "${input.to}" (id: ${result.messageId}). If they answer, it will arrive ` +
            `later as a new turn — carry on with other work.`
        )
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
        record(ctx, {
          kind: 'task_post',
          targetAppId: assigneeAppId,
          subject: toActivitySubject(input.title),
          refId: taskId,
          status: 'pending',
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
    'Update a blackboard task: set its status, attach the file it produced, or ' +
      'add a note. Update your own task when you finish it; the lead ' +
      'may update any task.\n\n' +
      'Example: { "taskId": "...", "status": "done", "resultRef": "competitors.md" }',
    {
      taskId: z.string().describe('Id of the task to update.'),
      status: z
        .enum(TASK_STATUS_VALUES)
        .describe('New task status: pending | in_progress | done | rejected | blocked.'),
      resultRef: z
        .string()
        .optional()
        .describe(
          'The file this task produced, as a path relative to your working directory (e.g. ' +
            '"docs/design.md"). It must already exist, and its name must be unused by other ' +
            'teammates — the update is refused otherwise. ' +
            'Omit this when the task produced no file; put the outcome in note instead.'
        ),
      note: z.string().optional().describe('Short note (e.g. rejection reason or blocker).'),
    },
    async (input) => {
      console.log(
        `${LOG_TAG} ${TEAM_TOOL_NAMES.updateTask}: team=${ctx.teamId} task=${input.taskId} ` +
          `status=${input.status}`
      )
      let resultRef: string | undefined
      let receipt = ''
      if (input.resultRef) {
        const accepted = acceptRef(ctx, input.resultRef, { kind: 'task', taskId: input.taskId })
        if (!accepted.ok) {
          // Refused whole rather than applied without the ref: a task shown done
          // with its deliverable silently dropped is the same false success this
          // gate exists to end.
          return textResult(`The task was NOT updated. ${accepted.message}`, true)
        }
        resultRef = accepted.ref
        receipt = ` Attached ${accepted.receipt}.`
      }
      try {
        ctx.blackboard.updateTask({
          teamId: ctx.teamId,
          epochId: ctx.epochId,
          taskId: input.taskId,
          status: input.status as TaskStatus,
          resultRef,
          note: input.note,
          callerAppId: ctx.callerAppId,
        })
        // The task row keeps only its latest state, so without this act the fact
        // that someone moved it — and when — is gone the moment it moves again.
        record(ctx, {
          kind: 'task_update',
          subject: toActivitySubject(input.note ?? ''),
          refId: input.taskId,
          status: input.status as TaskStatus,
        })
        return textResult(`Task ${input.taskId} updated to "${input.status}".${receipt}`)
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
      ref: z
        .string()
        .optional()
        .describe(
          'A file inside your working directory, as a path relative to it (e.g. "docs/design.md"). ' +
            'The file must already exist — it is checked now, and publishing fails if it is not ' +
            'there or is outside your working directory. The name must also be unused by other ' +
            'teammates, so prefer one that is clearly yours. Required if content is omitted.'
        ),
    },
    async (input) => {
      if (!input.content && !input.ref) {
        return textResult('You must provide at least one of "content" or "ref".', true)
      }
      console.log(`${LOG_TAG} ${TEAM_TOOL_NAMES.postFinding}: team=${ctx.teamId} from=${ctx.callerAppId}`)
      let ref: string | undefined
      let receipt = ''
      if (input.ref) {
        const accepted = acceptRef(ctx, input.ref, { kind: 'finding', authorAppId: ctx.callerAppId })
        if (!accepted.ok) return textResult(`Nothing was published. ${accepted.message}`, true)
        ref = accepted.ref
        receipt = ` Published ${accepted.receipt} — teammates read it with ` +
          `${TEAM_TOOL_NAMES.readArtifact}(ref: "${accepted.ref}").`
      }
      try {
        const { findingId } = ctx.blackboard.postFinding({
          teamId: ctx.teamId,
          epochId: ctx.epochId,
          callerAppId: ctx.callerAppId,
          content: input.content,
          ref,
        })
        record(ctx, {
          kind: 'finding',
          subject: toActivitySubject(ref ?? input.content ?? ''),
          refId: findingId,
        })
        return textResult(`Finding posted (id: ${findingId}).${receipt}`)
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
      'Each roster member also reports: `presence` ("online" | "offline" — check ' +
      'this before dispatching so you skip/reassign offline teammates), `owner` ' +
      '(who brought this teammate; null = runs on your machine), and `sameMachine` ' +
      '(false = runs on a teammate\u2019s machine, so file paths from there are not ' +
      'readable here — use team_read_artifact for their outputs).\n\n' +
      '`checks` lists the periodic checks running in this piece of work: who set ' +
      'each one, who it wakes, what it says and how many rounds it has run. Read ' +
      'it before setting one (so you do not duplicate) and to find the one to stop.\n\n' +
      'Recent activity is a bounded window. When there is more, the result says so ' +
      'and gives you a file holding the complete record — Read or Grep that file ' +
      'before deciding that something was never done.\n\n' +
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
        // Only what the snapshot could not carry gets exported, and only then:
        // a board whose history fits needs no file and writes none.
        const history = ctx.archive?.materialize(ctx.teamId, ctx.epochId, snapshot.activities.length) ?? null
        const board = renderBoardMarkdown(snapshot, { now: Date.now(), history })
        // The same lines the turn's input carries, offered again at the moment
        // the member has actually chosen to think about the board — which is
        // when it is most likely to act on them.
        const digest = ctx.digest?.render({
          teamId: ctx.teamId,
          epochId: ctx.epochId,
          viewerAppId: ctx.callerAppId,
        })
        return textResult(digest ? `${board}\n\n${digest}` : board)
      } catch (err) {
        return busErrorResult(err)
      }
    }
  )
}

function buildReadArtifactTool(ctx: TeamMcpContext) {
  return tool(
    TEAM_TOOL_NAMES.readArtifact,
    'Read a teammate\u2019s published artifact by its reference, wherever it was ' +
      'produced. Use this to open a deliverable a teammate shared — a finding\u2019s ' +
      '`ref` or a task\u2019s `resultRef` from team_read_board.\n\n' +
      'It fetches the file even when the teammate runs on another machine (where a ' +
      'raw file path would be unreadable). If the owner is offline you get a clear ' +
      'message instead of a hang — ask them to share the content, or retry later.\n\n' +
      'Example: { "ref": "competitors.md" }',
    {
      ref: z
        .string()
        .describe(
          'The artifact reference exactly as the board shows it (a finding ref or a task ' +
            'resultRef). It is the producer\u2019s path, not yours — do not rewrite it.'
        ),
    },
    async (input) => {
      console.log(
        `${LOG_TAG} ${TEAM_TOOL_NAMES.readArtifact}: team=${ctx.teamId} epoch=${ctx.epochId} ref="${input.ref}"`
      )
      if (!ctx.readArtifact) {
        return textResult('Reading team artifacts is not available in this context.', true)
      }
      try {
        const res = await ctx.readArtifact({
          teamId: ctx.teamId,
          epochId: ctx.epochId,
          ref: input.ref,
        })
        if (!res.ok) {
          return textResult(res.message ?? `Could not read artifact "${input.ref}".`, true)
        }
        // The reader asked for a ref; this is where it learns whose file it got.
        const ownerLabel = res.producer
          ? ` (produced by ${res.producer}${res.owner ? `, on ${res.owner}\u2019s machine` : ''})`
          : res.owner
            ? ` (produced on ${res.owner}\u2019s machine)`
            : ''
        const truncNote = res.truncated
          ? `\n\n[Truncated: showing the first part of a ${res.bytes ?? 0}-byte file.]`
          : ''
        return textResult(`Artifact "${input.ref}"${ownerLabel}:\n\n${res.content ?? ''}${truncNote}`)
      } catch (err) {
        return busErrorResult(err)
      }
    }
  )
}

function buildScheduleTool(ctx: TeamMcpContext) {
  return tool(
    TEAM_TOOL_NAMES.schedule,
    'Have a teammate (or yourself) wake up on a rhythm and act on a standing ' +
      'instruction — the way you would say "from now on check every half hour, ' +
      'and tell me when it is ready".\n\n' +
      'Use it when the thing you are waiting for happens outside the team and ' +
      'you cannot know when: an external system finishing, a bug getting fixed, ' +
      'a report appearing. Do NOT use it to poll a teammate who will message you ' +
      'back anyway.\n\n' +
      'Write the instruction as if the reader has forgotten everything: what to ' +
      'look at, what counts as ready, what to do then, and when to stop. They see ' +
      'exactly these words each time, plus who set it and which round it is.\n\n' +
      'Pick one of every / cron / once. It lasts until someone calls ' +
      'team_unschedule, and ends automatically when this piece of work does.\n\n' +
      'Example: { "to": "bugfixer", "every": "30m", "instruction": "Check the ' +
      '2026-08 release plan for open bugs. Fix and self-test any you find, then ' +
      'tell the test lead. When there are none left, stop this check." }',
    {
      to: z.string().describe('Teammate to wake (member name within this team). Use your own name for a self-check.'),
      instruction: z
        .string()
        .describe('The standing instruction, delivered verbatim on every wake. Make it self-contained.'),
      every: z.string().optional().describe('Interval such as "30m", "2h", "1d". Minimum 10 seconds.'),
      cron: z.string().optional().describe('Cron expression (5- or 6-part), e.g. "0 9 * * *".'),
      once: z
        .string()
        .optional()
        .describe('A single future moment as an ISO-8601 timestamp, e.g. "2026-08-11T09:00:00Z".'),
    },
    async (input) => {
      console.log(
        `${LOG_TAG} ${TEAM_TOOL_NAMES.schedule}: team=${ctx.teamId} epoch=${ctx.epochId} ` +
          `from=${ctx.callerAppId} to="${input.to}"`
      )
      if (!ctx.checks) return textResult('Periodic checks are not available in this context.', true)
      try {
        const schedule = parseScheduleInput(input)
        const targetAppId = ctx.bus.resolveMemberAppId(ctx.teamId, input.to)
        ctx.bus.assertCanContact(ctx.teamId, ctx.callerAppId, targetAppId, ctx.collabMode)

        const check = ctx.checks.schedule({
          teamId: ctx.teamId,
          epochId: ctx.epochId,
          createdByAppId: ctx.callerAppId,
          targetAppId,
          instruction: input.instruction,
          schedule,
        })
        record(ctx, {
          kind: 'check_set',
          targetAppId,
          subject: toActivitySubject(input.instruction),
          body: input.instruction,
          refId: check.id,
        })
        return textResult(
          `"${input.to}" will now wake ${describeSchedule(check.schedule)} with your instruction ` +
            `(check id: ${check.id}). Call team_unschedule when it is no longer needed.`
        )
      } catch (err) {
        return busErrorResult(err)
      }
    }
  )
}

function buildUnscheduleTool(ctx: TeamMcpContext) {
  return tool(
    TEAM_TOOL_NAMES.unschedule,
    'Stop a periodic check. Name the teammate to stop everything running on ' +
      'them, or add a checkId to stop just that one. Read team_read_board first ' +
      'to see which checks exist and who set them — you may stop one you did not ' +
      'set.\n\n' +
      'Example: { "to": "bugfixer" }',
    {
      to: z.string().describe('Teammate whose periodic checks should stop (member name).'),
      checkId: z.string().optional().describe('Stop only this check. Omit to stop all of theirs.'),
    },
    async (input) => {
      console.log(
        `${LOG_TAG} ${TEAM_TOOL_NAMES.unschedule}: team=${ctx.teamId} epoch=${ctx.epochId} to="${input.to}"`
      )
      if (!ctx.checks) return textResult('Periodic checks are not available in this context.', true)
      try {
        const targetAppId = ctx.bus.resolveMemberAppId(ctx.teamId, input.to)
        const stopped = ctx.checks.cancel({
          teamId: ctx.teamId,
          epochId: ctx.epochId,
          targetAppId,
          ...(input.checkId ? { checkId: input.checkId } : {}),
        })
        if (stopped.length === 0) {
          return textResult(`"${input.to}" has no periodic check running here, so there was nothing to stop.`)
        }
        for (const check of stopped) {
          record(ctx, {
            kind: 'check_stop',
            targetAppId,
            subject: toActivitySubject(check.instruction),
            refId: check.id,
          })
        }
        return textResult(
          `Stopped ${stopped.length} periodic check${stopped.length === 1 ? '' : 's'} on "${input.to}".`
        )
      } catch (err) {
        return busErrorResult(err)
      }
    }
  )
}

/** Exactly one of every / cron / once, validated before anything is written. */
function parseScheduleInput(input: { every?: string; cron?: string; once?: string }): TeamCheckSchedule {
  const given = [input.every, input.cron, input.once].filter((v) => v !== undefined && v !== '')
  if (given.length === 0) {
    throw new TeamCheckError('Give one of "every", "cron" or "once" so the check knows when to run.')
  }
  if (given.length > 1) {
    throw new TeamCheckError('Give only one of "every", "cron" or "once".')
  }
  if (input.every) return { kind: 'every', every: input.every }
  if (input.cron) return { kind: 'cron', cron: input.cron }
  const at = Date.parse(input.once as string)
  if (Number.isNaN(at)) {
    throw new TeamCheckError(`"${input.once}" is not a readable timestamp. Use ISO-8601, e.g. "2026-08-11T09:00:00Z".`)
  }
  return { kind: 'once', once: at }
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
        // Recorded before the seal: sealEpoch clears the epoch's live state, and
        // this act has to land inside the epoch it ends.
        record(ctx, { kind: 'run_end', subject: toActivitySubject(input.summary), body: input.summary })
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
    buildReadArtifactTool(context),
    buildScheduleTool(context),
    buildUnscheduleTool(context),
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
