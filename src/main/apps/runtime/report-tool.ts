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

      // Send system desktop notification based on notification level
      const level = runContext.notificationLevel ?? 'important'
      const shouldNotify =
        level === 'all' ||
        (level === 'important' && (safeType === 'escalation' || safeType === 'milestone' || safeType === 'output'))
      if (shouldNotify) {
        notifyAppEvent(runContext.appName, safeSummary, {
          appId: runContext.appId,
          // External channels are now AI-driven via notify_channel tool
        })
      }

      // Handle escalation
      if (safeType === 'escalation') {
        if (onEscalation) {
          onEscalation(entryId)
        }

        // Broadcast escalation event for real-time UI update
        broadcastToAll('app:escalation:new', {
          appId: runContext.appId,
          entryId,
          question: input.question ?? content.summary,
          choices: input.choices ?? [],
        })
        sendToRenderer('app:escalation:new', {
          appId: runContext.appId,
          entryId,
          question: input.question ?? content.summary,
          choices: input.choices ?? [],
        })

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
