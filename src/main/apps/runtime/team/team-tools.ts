/**
 * In-process MCP server exposing team coordination tools.
 * Topology violations return isError:true results so the LLM self-corrects.
 */

import { z } from 'zod'
import { createCollaborationServer, type CollaborationOperations, type CollaborationCallContext, type CollaborationResult } from '@hello-halo/agent-sdk/collaboration'
import type { ParticipantService, ParticipantSource } from '../../team'
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
import type { TeamFolderPaths, TeamFolders } from './team-folder'
import { renderMemberRecord, type ReadTeamMemberRecord } from './member-record'
import type { CollabMode, TaskStatus, TeamCheckSchedule, TeamRequestOrigin } from '../../../../shared/apps/team-types'

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
   * The caller's team folder for this piece of work — where its reviews and
   * notes go, and the other place a ref may be published from. Null/absent →
   * only working-directory files can be published.
   */
  callerTeamFolder?: TeamFolderPaths | null
  /** Resolves a task assignee's folder, so a lead can attach that member's file to its task. */
  teamFolders?: Pick<TeamFolders, 'ofTaskAssignee'>
  /**
   * Location-transparent read of a published team artifact. Absent → the tool is
   * still registered but reports the capability is unavailable (non-federated
   * test runtimes).
   */
  readArtifact?: ReadTeamArtifact
  /**
   * Location-transparent read of a member's record, for the lead. Absent → the
   * tool reports the capability is unavailable (non-federated test runtimes).
   */
  readMemberRecord?: ReadTeamMemberRecord
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
  /**
   * The turn these tools serve runs restricted for a request from outside.
   * Stamped onto every check it sets. A message carries only a guest's: the
   * owner's own digital humans asking each other is the owner's own work, but a
   * stranger's request must not become the owner's by being passed along.
   * Absent for a turn with the owner's full reach, which hands nothing on.
   */
  origin?: TeamRequestOrigin
  requestId?: string
  /**
   * The turn serves a guest of an IM chat this member fronts. Periodic checks
   * are standing instructions that keep spending the owner's model allowance
   * long after the request, so a guest neither sets nor stops them — a guest of
   * a digital human's own chat has no such tool either.
   */
  servesGuest?: boolean
  participants?: ParticipantService
  spawnSource?: () => ParticipantSource
  canSpawn?: () => boolean
  privateAssistants?: {
    spawn: NonNullable<CollaborationOperations['spawn_agent']>
    resolveHandle(handle: string, all?: boolean): TeamMcpContext | null
  }
  publicationRefusal?: (absolutePath: string) => string | null
}

/**
 * Where a tool call finds its team context. Reused member sessions resolve
 * their current turn's authority. A source conversation's tools are seeded before any collaboration
 * exists — its resolver looks the current collaboration up per call, so
 * the first `spawn_agent` and `team_send` work inside one turn, with no
 * session rebuild in between.
 */
export type ResolveTeamMcpContext = () => TeamMcpContext | null

const NO_TEAM_CONTEXT =
  'No collaborators have been created in this conversation. Use spawn_agent when independent work would help.'

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
 * The uniqueness check has the same shape: a working-directory ref is a path
 * inside the publisher's OWN working directory, so two members reach for one name
 * and the board holds a single indistinguishable string. Here is the last instant
 * they can be told apart, and the member holding the file is the one who can
 * rename it. A `team:` ref carries its producer's folder and so cannot collide
 * this way; it still passes through the check, which then costs nothing.
 */
function acceptRef(
  ctx: TeamMcpContext,
  ref: string,
  claim: PublishedRefClaim
): { ok: true; ref: string; receipt: string } | { ok: false; message: string } {
  const teamFolder = ctx.callerTeamFolder ?? null
  const claimantFolder =
    claim.kind === 'task' ? ctx.teamFolders?.ofTaskAssignee(ctx.teamId, ctx.epochId, claim.taskId) ?? null : null
  const resolved = resolveArtifactRef({ workDir: ctx.callerWorkDir, teamFolder, claimantFolder }, ref)
  if (!resolved.ok) {
    console.warn(
      `${LOG_TAG} rejected ref="${ref}" from=${ctx.callerAppId} workDir="${ctx.callerWorkDir}" ` +
        `teamFolder="${teamFolder?.self ?? ''}": ${resolved.reason}`
    )
    return {
      ok: false,
      message: explainArtifactRefRejection(resolved.reason, { ref, workDir: ctx.callerWorkDir, teamFolder }),
    }
  }
  const refusal = ctx.publicationRefusal?.(resolved.absPath)
  if (refusal) {
    console.warn(`${LOG_TAG} publication refused by caller policy: team=${ctx.teamId} epoch=${ctx.epochId} caller=${ctx.callerAppId}`)
    return { ok: false, message: refusal }
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

function buildSendOperation(resolve: ResolveTeamMcpContext): NonNullable<CollaborationOperations['team_send']> {
  return async (input) => {
    const ctx = resolve()
    if (!ctx) return textResult(NO_TEAM_CONTEXT, true)
    try {
      const toAppId = ctx.bus.resolveMemberAppId(ctx.teamId, input.to, ctx.epochId)
      ctx.bus.assertCanContact(ctx.teamId, ctx.callerAppId, toAppId, ctx.collabMode, ctx.epochId)
      const continuedRequest = ctx.participants?.continueTarget(ctx, toAppId)

      const result = await ctx.bus.send({
        teamId: ctx.teamId,
        epochId: ctx.epochId,
        fromAppId: ctx.callerAppId,
        to: toAppId,
        message: input.message,
        forwardDepth: ctx.forwardDepth,
        ...(ctx.origin ? { origin: ctx.origin } : {}),
        ...(typeof continuedRequest === 'string' ? { requestId: continuedRequest } : ctx.requestId ? { requestId: ctx.requestId } : {}),
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
      if (result.delivery === 'mid_turn') {
        // Worth telling apart from a plain hand-over: it says the teammate is
        // mid-task, so an answer is not the next thing they will do — and from
        // 'queued', which would have the sender wait for a turn to end that
        // this message has already reached inside.
        return textResult(
          `Message delivered to "${input.to}" (id: ${result.messageId}) while they were working — they ` +
            `see it at their next step, without being interrupted. They may be part-way through ` +
            `something, so give them room to react; if they answer while you work, it arrives after your current tool call.`
        )
      }
      if (result.remoteTarget) {
        // Never "delivered" for another machine: acceptance by their machine is
        // all this end can observe, and whether it woke the member is knowable
        // only there. Said plainly because the alternative is a lead that waits
        // indefinitely on a member that never ran, unable to tell the two apart.
        return textResult(
          `Message accepted for "${input.to}" (id: ${result.messageId}). They run on another machine, so ` +
            `this end cannot confirm they actually started — silence is NOT evidence they are working. ` +
            `Carry on with other work, and if nothing comes back, check whether they ever picked it up ` +
            `(team_read_board) rather than waiting longer.`
        )
      }
      return textResult(
        `Message delivered to "${input.to}" (id: ${result.messageId}). If they answer, it will arrive ` +
          `after your current tool call while you continue working.`
      )
    } catch (err) {
      return busErrorResult(err)
    }
  }
}

function buildPostTaskOperation(resolve: ResolveTeamMcpContext): NonNullable<CollaborationOperations['team_post_task']> {
  return async (input) => {
    const ctx = resolve()
    if (!ctx) return textResult(NO_TEAM_CONTEXT, true)

    try {
      const assigneeAppId = ctx.bus.resolveMemberAppId(ctx.teamId, input.assignee, ctx.epochId)
      ctx.bus.assertCanContact(ctx.teamId, ctx.callerAppId, assigneeAppId, ctx.collabMode, ctx.epochId)

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
}

function buildUpdateTaskOperation(resolve: ResolveTeamMcpContext): NonNullable<CollaborationOperations['team_update_task']> {
  return async (input) => {
    const ctx = resolve()
    if (!ctx) return textResult(NO_TEAM_CONTEXT, true)

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
}

function buildPostFindingOperation(resolve: ResolveTeamMcpContext): NonNullable<CollaborationOperations['team_post_finding']> {
  return async (input) => {
    const ctx = resolve()
    if (!ctx) return textResult(NO_TEAM_CONTEXT, true)
    if (!input.content && !input.ref) {
      return textResult('You must provide at least one of "content" or "ref".', true)
    }

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
}

function buildReadBoardOperation(resolve: ResolveTeamMcpContext): NonNullable<CollaborationOperations['team_read_board']> {
  return async (input) => {
    const ctx = resolve()
    if (!ctx) return textResult('No collaborators have been created in this conversation.')

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
}

function buildReadArtifactOperation(resolve: ResolveTeamMcpContext): NonNullable<CollaborationOperations['team_read_artifact']> {
  return async (input) => {
    const ctx = resolve()
    if (!ctx) return textResult(NO_TEAM_CONTEXT, true)

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
}

function buildReadMemberOperation(resolve: ResolveTeamMcpContext): NonNullable<CollaborationOperations['team_read_member']> {
  return async (input) => {
    const ctx = resolve()
    if (!ctx) return textResult(NO_TEAM_CONTEXT, true)
    if (ctx.origin) {
      return textResult(
        'A member\u2019s record is not available while serving a request from outside your owner\u2019s machine.',
        true
      )
    }

    if (!ctx.readMemberRecord) {
      return textResult('Reading a member\u2019s record is not available in this context.', true)
    }
    try {
      const memberAppId = ctx.bus.resolveMemberAppId(ctx.teamId, input.member, ctx.epochId)
      if (!(ctx.participants?.canRead(ctx, memberAppId) ?? ctx.selfIsLead)) {
        return textResult('This member record is not available to you. You may inspect collaborators you created or coordinate.', true)
      }
      if (memberAppId === ctx.callerAppId) {
        return textResult('That is you. This tool reads a teammate\u2019s record.', true)
      }
      const res = await ctx.readMemberRecord({
        teamId: ctx.teamId,
        epochId: ctx.epochId,
        memberAppId,
        ...(input.before !== undefined ? { before: input.before } : {}),
      })
      return res.ok ? textResult(renderMemberRecord(res)) : textResult(res.message, true)
    } catch (err) {
      return busErrorResult(err)
    }
  }
}

function buildScheduleTool(resolve: ResolveTeamMcpContext) {
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
      const ctx = resolve()
      if (!ctx) return textResult(NO_TEAM_CONTEXT, true)

      if (!ctx.checks) return textResult('Periodic checks are not available in this context.', true)
      try {
        ctx.participants?.capture(ctx)()
        const schedule = parseScheduleInput(input)
        const targetAppId = ctx.bus.resolveMemberAppId(ctx.teamId, input.to, ctx.epochId)
        ctx.bus.assertCanContact(ctx.teamId, ctx.callerAppId, targetAppId, ctx.collabMode, ctx.epochId)

        const check = ctx.checks.schedule({
          teamId: ctx.teamId,
          epochId: ctx.epochId,
          createdByAppId: ctx.callerAppId,
          targetAppId,
          instruction: input.instruction,
          // Same origin team_send stamps on messages: a standing instruction set
          // while serving an outside request stays that request's.
          ...(ctx.origin ? { origin: ctx.origin } : {}),
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

function buildUnscheduleTool(resolve: ResolveTeamMcpContext) {
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
      const ctx = resolve()
      if (!ctx) return textResult(NO_TEAM_CONTEXT, true)

      if (!ctx.checks) return textResult('Periodic checks are not available in this context.', true)
      try {
        ctx.participants?.capture(ctx)()
        const targetAppId = ctx.bus.resolveMemberAppId(ctx.teamId, input.to, ctx.epochId)
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


function guarded<T>(
  resolve: ResolveTeamMcpContext,
  factory: (scope: ResolveTeamMcpContext) => (input: T, context: CollaborationCallContext) => Promise<CollaborationResult>,
  mutating = false,
): (input: T, context: CollaborationCallContext) => Promise<CollaborationResult> {
  return async (input, context) => {
    const current = resolve()
    const check = mutating && current?.participants ? current.participants.capture(current, context.signal)
      : () => context.signal?.throwIfAborted()
    check()
    const scoped = current ? {
      ...current,
      bus: { ...current.bus, send: (request: Parameters<MessageBus['send']>[0]) => { check(); return current.bus.send(request) } },
      blackboard: {
        ...current.blackboard,
        postTask: (request: Parameters<Blackboard['postTask']>[0]) => { check(); return current.blackboard.postTask(request) },
        updateTask: (request: Parameters<Blackboard['updateTask']>[0]) => { check(); return current.blackboard.updateTask(request) },
        postFinding: (request: Parameters<Blackboard['postFinding']>[0]) => { check(); return current.blackboard.postFinding(request) },
        postActivity: (request: Parameters<Blackboard['postActivity']>[0]) => { check(); return current.blackboard.postActivity(request) },
      },
    } : null
    const result = await factory(() => scoped)(input, context)
    check()
    return result
  }
}

export function createCoordinationMcpServer(resolve: ResolveTeamMcpContext, options: {
  spawn?: CollaborationOperations['spawn_agent']
  readMember?: boolean
  checks?: boolean
  resolveHandle?: (handle: string, all?: boolean) => TeamMcpContext | null
} = {}): SdkMcpServer {
  const targetOperation = <T>(input: T, call: CollaborationCallContext, target: string,
    factory: (scope: ResolveTeamMcpContext) => (input: T, context: CollaborationCallContext) => Promise<CollaborationResult>, mutating = false) => {
    const privateContext = options.resolveHandle?.(target)
    const operationContext = privateContext && !mutating ? { ...privateContext, origin: undefined } : privateContext
    return guarded(operationContext ? () => operationContext : resolve, factory, mutating)(input, call)
  }
  const operations: CollaborationOperations = {
    ...(options.spawn ? { spawn_agent: options.spawn } : {}),
    team_send: (input, call) => targetOperation(input, call, input.to, buildSendOperation, true),
    team_post_task: guarded(resolve, buildPostTaskOperation, true),
    team_update_task: guarded(resolve, buildUpdateTaskOperation, true),
    team_post_finding: guarded(resolve, buildPostFindingOperation, true),
    team_read_board: guarded(resolve, buildReadBoardOperation),
    team_read_artifact: guarded(resolve, buildReadArtifactOperation),
    ...(options.readMember !== false ? { team_read_member: (input, call) => targetOperation(input, call, input.member, buildReadMemberOperation) } : {}),
    team_stop: async input => {
      const context = options.resolveHandle?.(input.to, input.to === 'all') ?? resolve()
      if (!context?.participants) return textResult('Stopping collaborators is unavailable in this work context.', true)
      try {
        return textResult(JSON.stringify(await context.participants.stop(context, input.to)))
      } catch (error) {
        if (error instanceof TeamBusError) return busErrorResult(error)
        throw error
      }
    },
  }
  const shared = createCollaborationServer(operations)
  if (!options.checks) return shared
  const checks = createSdkMcpServer({ name: TEAM_MCP_SERVER_NAME, tools: [buildScheduleTool(resolve), buildUnscheduleTool(resolve)] })
  return {
    type: 'sdk', name: TEAM_MCP_SERVER_NAME,
    instance: {
      name: TEAM_MCP_SERVER_NAME, version: shared.instance.version,
      listTools: () => [...shared.instance.listTools(), ...checks.instance.listTools()],
      callTool: async (name, input, context) => await shared.instance.callTool(name, input, context)
        ?? checks.instance.callTool(name, input, context),
    },
  }
}

export function createTeamMcpServer(context: TeamMcpContext, resolve: ResolveTeamMcpContext = () => context): SdkMcpServer {
  const spawn = context.privateAssistants && context.canSpawn?.() !== false ? async (
    input: Parameters<NonNullable<CollaborationOperations['spawn_agent']>>[0],
    call: CollaborationCallContext,
  ) => {
    const current = resolve()
    if (!current?.privateAssistants || current.canSpawn?.() === false) return textResult('Creating collaborators is not allowed in this context.', true)
    return current.privateAssistants.spawn(input, call)
  } : undefined
  return createCoordinationMcpServer(resolve, {
    spawn,
    resolveHandle: (handle, all) => resolve()?.privateAssistants?.resolveHandle(handle, all) ?? null,
    readMember: !!spawn || (!context.origin && context.selfIsLead),
    checks: !context.servesGuest && !!context.checks,
  })
}
