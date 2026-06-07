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
    'Example call: { "type": "run_complete", "summary": "💧 Time to drink water! Stay hydrated." }\n\n' +
    'type values:\n' +
    '- "run_complete": Task finished (use this most of the time)\n' +
    '- "run_skipped": Nothing to do this time\n' +
    '- "milestone": Important finding mid-task\n' +
    '- "escalation": Need user decision before continuing\n' +
    '- "output": Produced a file or report\n\n' +
    'For escalation: also provide "question" field. After escalation, stop execution.\n\n' +
    'For detailed content (plans, proposals, long reports):\n' +
    '1. Write content to a .md file first (use Write tool)\n' +
    '2. Pass the absolute file path as data_path\n' +
    'This keeps the tool call lightweight and lets you Edit the file for revisions.'

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
        'Entry type. Use "run_complete" for normal task completion. REQUIRED — must be one of the listed values.'
      ),
      summary: z.string().describe(
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
      question: z.string().optional().describe(
        'Only for escalation: the question to ask the user.'
      ),
      choices: z.array(z.string()).optional().describe(
        'Only for escalation: preset answer choices (user can also type freely).'
      ),
    },
    async (input) => {
      const entryId = randomUUID()
      const now = Date.now()
      const runTag = runContext.runId.slice(0, 8)

      // DEBUG: dump raw input to diagnose SDK tool input delivery
      console.log(
        `[Runtime][${runTag}] report_to_user RAW input: ${JSON.stringify(input)}`
      )

      // Defensive defaults: SDK tool() does not enforce Zod at runtime,
      // non-Anthropic models may omit required fields.
      const VALID_TYPES = ['run_complete', 'run_skipped', 'milestone', 'escalation', 'output'] as const
      const safeType = (VALID_TYPES as readonly string[]).includes(input.type)
        ? input.type
        : 'run_complete'
      const safeSummary = input.summary ?? 'Task completed.'

      const summaryPreview = safeSummary.slice(0, 80)
      console.log(
        `[Runtime][${runTag}] report_to_user called: type=${safeType}${input.type !== safeType ? ` (original: ${input.type})` : ''}, ` +
        `summary="${summaryPreview}"` +
        (input.data_path ? `, data_path="${input.data_path}"` : '') +
        (input.question ? `, question="${input.question.slice(0, 60)}"` : '') +
        (input.choices ? `, choices=${input.choices.length}` : '')
      )

      // Build content
      const content: ActivityEntryContent = {
        summary: safeSummary,
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
      if (input.question) content.question = input.question
      if (input.choices) content.choices = input.choices

      // ── Team-channel routing ────────────────────────────────────────────────
      // In a team turn, report_to_user keeps its ORIGINAL purpose: escalation
      // (human decision) + optional audit entries. It does NOT carry the result —
      // the result is the turn's FINAL MESSAGE, captured by the runtime (onReply).
      // Lead-routed escalations reach the user via the lead's mailbox, so the
      // user-facing emission is suppressed below to avoid a double-send (the
      // audit entry is still persisted in both cases).
      let suppressUserEscalation = false
      const team = runContext.teamContext
      if (team && safeType === 'escalation') {
        const runtime = getActiveTeamRuntime()
        const reportText = input.data ? `${safeSummary}\n\n${input.data}` : safeSummary
        // Tag the escalation entry so the team view aggregates it, and
        // capture it so orchestration routes per escalationRouting.
        content.teamContext = {
          teamId: team.teamId,
          epochId: team.epochId,
          ...(team.taskId ? { taskId: team.taskId } : {}),
        }
        runtime?.captureReport(team.correlationId, {
          kind: 'escalation',
          content: reportText,
        })
        // Suppress the user-facing escalation ONLY for a MEMBER under 'lead'
        // routing — that escalation is forwarded to the lead to resolve first.
        // The LEAD's own upward escalation must always reach the user, otherwise
        // it would be silently lost (the lead is the last resort before the user).
        const teamPrompt = runtime?.buildPromptContext(team, runContext.appId)
        suppressUserEscalation =
          teamPrompt?.escalationRouting === 'lead' && teamPrompt?.selfIsLead === false
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
        emitEntry ? emitEntry(entry) : store.insertEntry(entry)
      } catch (err) {
        console.error('[Runtime] Failed to insert activity entry:', err)
        return textResult(`Failed to save report: ${err instanceof Error ? err.message : String(err)}`, true)
      }

      console.log(`[Runtime][${runTag}] Activity entry created: type=${safeType}, app=${runContext.appId}, entry=${entryId}`)

      // Send system desktop notification based on notification level. A
      // lead-routed team escalation never reaches the user, so it must not raise
      // a desktop notification either.
      const level = runContext.notificationLevel ?? 'important'
      const shouldNotify =
        !suppressUserEscalation &&
        (level === 'all' ||
          (level === 'important' && (safeType === 'escalation' || safeType === 'milestone' || safeType === 'output')))
      if (shouldNotify) {
        notifyAppEvent(runContext.appName, safeSummary, {
          appId: runContext.appId,
          // External channels are now AI-driven via notify_channel tool
        })
      }

      // Handle escalation
      if (safeType === 'escalation') {
        // Lead-routed team escalation: the runtime already delivered it to the
        // lead. Do not prompt the user as well.
        if (suppressUserEscalation) {
          return textResult(
            `Escalation routed to the team lead (entry: ${entryId}). ` +
            'End your turn now — the lead will respond via the team.'
          )
        }

        if (onEscalation) {
          onEscalation(entryId)
        }

        // Broadcast escalation event for real-time UI update. Carry team context
        // when this is a team escalation so team-aware consumers can attribute it
        // (the team view also reacts via the team:updated status change).
        const escalationEvent = {
          appId: runContext.appId,
          entryId,
          question: input.question ?? content.summary,
          choices: input.choices ?? [],
          ...(content.teamContext
            ? { teamId: content.teamContext.teamId, epochId: content.teamContext.epochId }
            : {}),
        }
        broadcastToAll('app:escalation:new', escalationEvent)
        sendToRenderer('app:escalation:new', escalationEvent)

        return textResult(
          `Escalation sent to user (entry: ${entryId}). ` +
          'The user has been notified. End this run now — you will be ' +
          'resumed with the user\'s response once they reply.'
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
