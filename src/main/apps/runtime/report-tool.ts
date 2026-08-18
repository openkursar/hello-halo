/**
 * apps/runtime -- report_to_user MCP Tool
 *
 * Creates an SDK MCP server providing the `report_to_user` tool.
 * This tool allows the AI to write activity entries to the Activity Thread,
 * enabling structured communication between the AI and the user.
 *
 * Uses the same tool() + createSdkMcpServer() pattern as platform/memory/tools.ts.
 */

import { z } from 'zod'
import { randomUUID } from 'crypto'
import { tool, createSdkMcpServer } from '../../services/agent/resolved-sdk'
import type { ActivityStore } from './store'
import type { ActivityEntry, ActivityEntryType, ActivityEntryContent } from './types'
import { broadcastToAll } from '../../http/websocket'
import { sendToRenderer } from '../../foundation/window.service'
import { notifyAppEvent } from '../../services/notification.service'
import { getActiveTeamRuntime } from './team'
import { oneLineExcerpt } from './text-truncate'
import type { TeamTriggerContext } from '../../../shared/apps/team-types'

// ============================================
// Types
// ============================================

type SdkMcpServer = ReturnType<typeof createSdkMcpServer>

/** Context for a specific run (passed when creating the tool) */
export interface ReportToolContext {
  appId: string
  appName: string
  runId: string
  sessionKey: string
  /** Notification level: 'all' | 'important' | 'none'. Defaults to 'important'. */
  notificationLevel?: 'all' | 'important' | 'none'
  /** Absolute path to the plans directory for file-based data_path guidance */
  plansDir?: string
  /** Drives team-specific report routing when present. */
  teamContext?: TeamTriggerContext
}

/** Callback invoked when an escalation entry is created */
export type OnEscalation = (entryId: string) => void

// ============================================
// Tool Text Helper
// ============================================

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  }
}

const OPEN_QUESTION_EXCERPT = 80

/**
 * A solo run really is suspended on the answer; a team turn is not — teammate
 * messages and periodic checks keep waking the member while its question sits
 * unanswered, and a member told otherwise reads the next unrelated wake as the
 * answer it was promised.
 */
function resumeExpectation(inTeamTurn: boolean): string {
  return inTeamTurn
    ? 'End this turn now. The question stays open until the user answers it; ' +
      'you may still be woken for other work meanwhile, and the answer will ' +
      'arrive as its own wake quoting the question it belongs to.'
    : 'The user has been notified. End this run now — you will be ' +
      'resumed with the user\'s response once they reply.'
}

/**
 * People answer in their own order, so a new question does not replace an
 * earlier one. Naming what is still outstanding lets the model fold the new ask
 * into an old one, or say plainly that it supersedes it.
 */
function describeOpenQuestions(store: ActivityStore, appId: string, exceptEntryId: string): string {
  const others = store
    .getAllPendingEscalations()
    .filter((e) => e.appId === appId && e.id !== exceptEntryId)
  if (others.length === 0) return ''

  const quoted = others
    .map((e) => `"${oneLineExcerpt(e.content.question || e.content.summary, OPEN_QUESTION_EXCERPT)}"`)
    .join('; ')
  return ` You also have ${others.length} earlier question(s) still unanswered: ${quoted}.` +
    ' If this new one replaces or absorbs any of them, say so in it.'
}

// ============================================
// Tool Factory
// ============================================

/**
 * Create an MCP server with the `report_to_user` tool.
 *
 * @param store          - ActivityStore for persisting entries
 * @param runContext     - The current run's identity
 * @param onEscalation  - Callback when an escalation is created
 * @param emitEntry     - Insert + broadcast an activity entry (falls back to store.insertEntry)
 * @returns An SDK MCP server instance
 */
export function createReportToolServer(
  store: ActivityStore,
  runContext: ReportToolContext,
  onEscalation?: OnEscalation,
  emitEntry?: (entry: ActivityEntry) => void
): SdkMcpServer {
  // Build tool description with optional plans directory guidance
  const baseDescription =
    'Write an entry to the Activity Thread so the user knows what happened. ' +
    'ALWAYS call this at the end of every execution.\n\n' +
    '`message` is what the user reads — plain markdown, written for a human.\n' +
    'For an escalation, `message` IS the question: one concrete thing to decide.\n' +
    'Add `choices` when the answers are obvious. End your turn after the call.\n\n' +
    'type:\n' +
    '- run_complete — the run finished and needs nothing from the user. ' +
    'Errors count too: say what broke.\n' +
    '- run_skipped — there was nothing to run this time.\n' +
    '- milestone — notifies the user of an important event; the run continues.\n' +
    '- escalation — a human decision or approval is required. ' +
    'Ends the run; it resumes when the user answers.\n' +
    '- output — a file or report was produced; say what it is and where.\n\n' +
    'App instructions that say to alert or notify the user about something mean ' +
    'a milestone or an escalation, not a line in the final report.\n\n' +
    'Plans, proposals and long reports go in a .md file: pass its absolute path ' +
    'as `data_path` and Edit that file to revise.'

  // Inject the concrete plans directory path so the AI knows exactly where to write
  const plansDirGuidance = runContext.plansDir
    ? `\nBy default, write files to: ${runContext.plansDir}`
    : ''

  const reportTool = tool(
    'report_to_user',
    baseDescription + plansDirGuidance,
    {
      type: z.enum([
        'run_complete',
        'run_skipped',
        'milestone',
        'escalation',
        'output',
      ]).describe(
        'Entry type. Use "run_complete" for normal task completion, or pick by ' +
        'what the entry needs from the user. The five values are described in ' +
        'the tool description.'
      ),
      // Optional in the schema so a missing value reaches the handler, which can
      // answer with an instruction the model acts on rather than a schema dump.
      // The requirement itself is carried by the description.
      message: z.string().optional().describe(
        'REQUIRED. Briefly tell the user what happened in clear markdown. ' +
        'Example: "💧 Drink water reminder: Stay hydrated! It\'s been 1 hour since your last reminder." ' +
        'Do not include raw JSON or code blocks — unless the user explicitly requires it.'
      ),
      data: z.string().optional().describe(
        'Optional short inline markdown. For long content, use data_path instead.'
      ),
      data_path: z.string().optional().describe(
        'Absolute path to a markdown file you have already written. ' +
        'Use this instead of "data" for detailed plans, proposals, or long reports. ' +
        'To revise content later, Edit the file and re-escalate with the same path.'
      ),
      choices: z.array(z.string()).optional().describe(
        'Only for escalation: preset answer choices (user can also type freely).'
      ),
    },
    async (input) => {
      const entryId = randomUUID()
      const now = Date.now()
      const runTag = runContext.runId.slice(0, 8)

      // `message` is optional in the schema so that its absence lands here
      // instead of being rejected upstream as a schema dump the model cannot
      // act on. Nothing is written: the run has not been reported yet, and a
      // placeholder entry would spend the user's attention on nothing.
      if (!input.message) {
        return textResult(
          'No message was sent. `message` is what the user reads in the ' +
          'Activity Thread — required on every call. Call again with it.',
          true
        )
      }

      // Non-Anthropic models occasionally send a type outside the enum.
      const VALID_TYPES = ['run_complete', 'run_skipped', 'milestone', 'escalation', 'output'] as const
      const safeType = (VALID_TYPES as readonly string[]).includes(input.type)
        ? input.type
        : 'run_complete'

      console.log(
        `[Runtime][${runTag}] report_to_user called: type=${safeType}${input.type !== safeType ? ` (original: ${input.type})` : ''}, ` +
        `message="${input.message.slice(0, 80)}"` +
        (input.data_path ? `, data_path="${input.data_path}"` : '') +
        (input.choices ? `, choices=${input.choices.length}` : '')
      )

      // Build content
      const content: ActivityEntryContent = {
        summary: input.message,
      }

      // Map type to status
      if (safeType === 'run_complete') {
        content.status = 'ok'
      } else if (safeType === 'run_skipped') {
        content.status = 'skipped'
      }

      // Optional fields
      if (input.data) content.data = input.data
      if (input.data_path) content.dataPath = input.data_path
      if (input.choices) content.choices = input.choices

      // ── Team-channel routing ────────────────────────────────────────────────
      // In a team turn, report_to_user keeps its ORIGINAL purpose: escalation
      // (human decision) + optional audit entries. It does NOT carry the result —
      // the result is the turn's FINAL MESSAGE, captured by the runtime (onReply).
      //
      // A member asking for a human decision always reaches the human. The team's
      // escalation preference shapes the prompt (take it to the lead first), it
      // does not intercept here: silently redirecting a member that asked for a
      // person left the question answered in two places at once, while the member
      // itself had already stopped waiting for either answer.
      const team = runContext.teamContext
      if (team && safeType === 'escalation') {
        const reportText = input.data ? `${input.message}\n\n${input.data}` : input.message
        // Tag the escalation entry so the team view aggregates it.
        content.teamContext = {
          teamId: team.teamId,
          epochId: team.epochId,
          ...(team.taskId ? { taskId: team.taskId } : {}),
        }
        getActiveTeamRuntime()?.captureReport(team.correlationId, {
          kind: 'escalation',
          content: reportText,
        })
      }
      // Non-escalation reports in a team turn fall through to the normal path:
      // they write an ordinary (audit) activity entry and do NOT affect the team
      // result (which is the turn's final message).

      // Persist + broadcast the entry
      const entry: ActivityEntry = {
        id: entryId,
        appId: runContext.appId,
        runId: runContext.runId,
        type: safeType as ActivityEntryType,
        ts: now,
        sessionKey: runContext.sessionKey,
        content,
      }
      try {
        if (emitEntry) {
          // Automation path: the entry is also how the user receives the report,
          // so a failure here is a real delivery failure — surface it.
          emitEntry(entry)
        } else {
          // Chat/team path: this is an audit copy only, delivered via the turn's
          // final message / team capture / desktop notification below. Never
          // abort the turn on a persistence error here (previously left a stuck
          // member believing escalation was broken).
          store.insertEntry(entry)
        }
      } catch (err) {
        console.error('[Runtime] Failed to insert activity entry:', err)
        if (emitEntry) {
          return textResult(`Failed to save report: ${err instanceof Error ? err.message : String(err)}`, true)
        }
      }

      console.log(`[Runtime][${runTag}] Activity entry created: type=${safeType}, app=${runContext.appId}, entry=${entryId}`)

      // Send system desktop notification based on notification level.
      const level = runContext.notificationLevel ?? 'important'
      const shouldNotify =
        level === 'all' ||
        (level === 'important' && (safeType === 'escalation' || safeType === 'milestone' || safeType === 'output'))
      if (shouldNotify) {
        notifyAppEvent(runContext.appName, input.message, {
          appId: runContext.appId,
          // External channels are now AI-driven via notify_channel tool
        })
      }

      // Handle escalation
      if (safeType === 'escalation') {
        if (onEscalation) {
          onEscalation(entryId)
        }

        // Broadcast escalation event for real-time UI update. Carry team context
        // when this is a team escalation so team-aware consumers can attribute it
        // (the team view also reacts via the team:updated status change).
        const escalationEvent = {
          appId: runContext.appId,
          entryId,
          question: content.summary,
          choices: input.choices ?? [],
          ...(content.teamContext
            ? { teamId: content.teamContext.teamId, epochId: content.teamContext.epochId }
            : {}),
        }
        broadcastToAll('app:escalation:new', escalationEvent)
        sendToRenderer('app:escalation:new', escalationEvent)

        return textResult(
          `Escalation sent to user (entry: ${entryId}). ` +
          resumeExpectation(!!team) +
          describeOpenQuestions(store, runContext.appId, entryId)
        )
      }

      return textResult(`Report saved (entry: ${entryId}).`)
    }
  )

  return createSdkMcpServer({
    name: 'halo-report',
    version: '1.0.0',
    tools: [reportTool],
  })
}
