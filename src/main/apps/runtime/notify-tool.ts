/**
 * apps/runtime -- AI Notification MCP Tools
 *
 * Creates an SDK MCP server providing two AI-driven notification tools:
 *
 * - `notify_channel`: Send notifications to external channels (email, webhook, etc.)
 *   Only registered when channels are configured and enabled.
 *
 * - `notify_bot`: Send messages/files to IM contacts (WeCom Bot groups, users, etc.)
 *   Only registered when the `im-push` permission is granted AND contacts exist.
 *
 * Design decisions:
 * - Dynamic enums: `notify_channel` builds its channel enum from currently-enabled channels,
 *   so the AI only sees channels it can actually use. No need for a separate "list channels" tool.
 * - Contact directory: `notify_bot` embeds the full contact directory in its tool description,
 *   so the AI can match natural language ("notify marketing group") to the correct target.
 * - Conditional registration: Tools are only added when they can succeed. If no channels are
 *   configured and no IM sessions exist, the MCP server is created with zero tools.
 *
 * Uses the same tool() + createSdkMcpServer() pattern as report-tool.ts and file-send-mcp.ts.
 */

import { z } from 'zod'
import { tool, createSdkMcpServer } from '../../services/agent/resolved-sdk'
import { sendToChannel, getEnabledChannels } from '../../services/notify-channels'
import { getConfig } from '../../foundation/config.service'
import { getActiveImChannelManager } from './im-channels'
import { FileExportGate, FileExportDeniedError } from './file-export-gate'
import type { NotificationChannelType } from '../../../shared/types/notification-channels'
import type { ImSessionRecord } from '../../../shared/types/im-channel'

// ============================================
// Types
// ============================================

type SdkMcpServer = ReturnType<typeof createSdkMcpServer>

/** Context for the notify tool (passed when creating the server) */
export interface NotifyToolContext {
  appId: string
  appName: string
  runId: string
  /** IM sessions available for notify_bot (all sessions for this app) */
  imSessions?: ImSessionRecord[]
  /** Whether the im-push permission is granted for this app */
  usesImPush: boolean
  /** FileExportGate for validating outbound file paths (scoped to space + tmpdir) */
  exportGate: FileExportGate
}

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
// Contact Directory Builder
// ============================================

/**
 * Build a human-readable contact directory for the AI from IM session records.
 * Each entry includes the display name, chat type, source channel, and the
 * composite ID the AI must use in the `to` parameter.
 */
function buildContactDirectory(sessions: ImSessionRecord[]): string {
  if (sessions.length === 0) return ''

  const lines = sessions.map((s) => {
    const name = s.customName || s.displayName || s.chatId
    const type = s.chatType === 'group' ? 'Group' : 'Direct'
    const id = `${s.instanceId}:${s.chatId}`
    return `- "${name}" (${type}) via ${s.channel} — ID: ${id}`
  })

  return 'Available contacts:\n' + lines.join('\n')
}

// ============================================
// Tool Builders
// ============================================

/**
 * Build the notify_channel tool if any channels are configured and enabled.
 * Returns null when no channels are available.
 */
function buildNotifyChannelTool(context: NotifyToolContext) {
  let enabledChannels: NotificationChannelType[]
  try {
    const config = getConfig()
    enabledChannels = config.notificationChannels
      ? getEnabledChannels(config.notificationChannels)
      : []
  } catch {
    enabledChannels = []
  }

  if (enabledChannels.length === 0) return null

  // z.enum requires at least one value — guaranteed by the length check above
  const channelEnum = z.enum(enabledChannels as [NotificationChannelType, ...NotificationChannelType[]])

  return tool(
    'notify_channel',
    'Send a notification to an external channel. ' +
    `Available channels: ${enabledChannels.join(', ')}.\n\n` +
    'Use this when you discover something important the user should know about immediately ' +
    'via an external platform (email alert, webhook event, etc.).\n\n' +
    'Example: { "channel": "email", "title": "Price Alert", "message": "AirPods Pro price dropped to ¥1199" }',
    {
      channel: channelEnum.describe(
        'Target notification channel. Only configured and enabled channels are listed.'
      ),
      title: z.string().describe(
        'Notification title. Keep it short and descriptive (e.g. "Price Alert", "Report Ready").'
      ),
      message: z.string().describe(
        'Notification body. The main content to deliver. Write for humans — clear and direct.'
      ),
    },
    async (input) => {
      const runTag = context.runId.slice(0, 8)
      console.log(
        `[Runtime][${runTag}] notify_channel called: channel=${input.channel}, title="${input.title}"`
      )

      // Re-read config at send time for latest credentials
      let config
      try {
        config = getConfig()
      } catch {
        return textResult('Failed to read notification configuration.', true)
      }

      const channelsConfig = config.notificationChannels
      if (!channelsConfig) {
        return textResult('No notification channels configured.', true)
      }

      const channelType = input.channel as NotificationChannelType
      const channelConfig = channelsConfig[channelType]
      if (!channelConfig?.enabled) {
        return textResult(
          `The "${input.channel}" channel is no longer enabled. It may have been disabled since this run started.`,
          true
        )
      }

      try {
        const result = await sendToChannel(channelType, channelsConfig, {
          title: input.title,
          body: input.message,
          appId: context.appId,
          appName: context.appName,
          timestamp: Date.now(),
        })

        if (result.success) {
          console.log(`[Runtime][${runTag}] Notification sent successfully via ${input.channel}`)
          return textResult(`Notification sent successfully via ${input.channel}.`)
        } else {
          console.warn(`[Runtime][${runTag}] Notification failed via ${input.channel}: ${result.error}`)
          return textResult(`Failed to send notification via ${input.channel}: ${result.error}`, true)
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[Runtime][${runTag}] Notification error:`, err)
        return textResult(`Error sending notification via ${input.channel}: ${errMsg}`, true)
      }
    }
  )
}

/**
 * Build the notify_bot tool if im-push is enabled and contacts exist.
 * Returns null when the tool should not be available.
 */
function buildNotifyBotTool(context: NotifyToolContext) {
  if (!context.usesImPush || !context.imSessions || context.imSessions.length === 0) {
    return null
  }

  const directory = buildContactDirectory(context.imSessions)

  return tool(
    'notify_bot',
    'Send a message or file to an IM contact (person or group) via Bot.\n\n' +
    'Use this to proactively notify specific contacts about important information, ' +
    'deliver generated reports/files, or relay messages across conversations.\n\n' +
    directory + '\n\n' +
    'You MUST provide at least one of "message" or "file".\n\n' +
    'Example (text): { "to": "inst_abc:oc_xyz", "message": "Meeting reminder: tomorrow 3pm" }\n' +
    'Example (file): { "to": "inst_abc:oc_xyz", "file": "/tmp/report.pdf", "filename": "Monthly Report.pdf" }',
    {
      to: z.string().describe(
        'Target contact ID in the format "instanceId:chatId". ' +
        'See the contact directory above for available targets.'
      ),
      message: z.string().optional().describe(
        'Text message content (Markdown supported). Required if "file" is not provided.'
      ),
      file: z.string().optional().describe(
        'Absolute path to a local file to send. Required if "message" is not provided.'
      ),
      filename: z.string().optional().describe(
        'Display name for the file (e.g. "Report.pdf"). Defaults to the file\'s basename.'
      ),
    },
    async (input) => {
      const runTag = context.runId.slice(0, 8)
      console.log(
        `[Runtime][${runTag}] notify_bot called: to="${input.to}", ` +
        `hasMessage=${!!input.message}, hasFile=${!!input.file}`
      )

      // Validate: at least one of message/file
      if (!input.message && !input.file) {
        return textResult('You must provide at least one of "message" or "file".', true)
      }

      // Parse the composite "to" parameter
      const colonIndex = input.to.indexOf(':')
      if (colonIndex === -1) {
        return textResult(
          `Invalid "to" format: "${input.to}". Expected "instanceId:chatId". ` +
          'Use the exact ID from the contact directory.',
          true
        )
      }
      const instanceId = input.to.slice(0, colonIndex)
      const chatId = input.to.slice(colonIndex + 1)

      // Find the matching session to get chatType
      const session = context.imSessions!.find(
        s => s.instanceId === instanceId && s.chatId === chatId
      )
      if (!session) {
        return textResult(
          `Contact not found: "${input.to}". The contact may have been removed. ` +
          'Check the available contacts in the tool description.',
          true
        )
      }

      // Get the IM channel instance
      const manager = getActiveImChannelManager()
      if (!manager) {
        return textResult('IM channel manager is not available.', true)
      }

      const instance = manager.getInstance(instanceId)
      if (!instance) {
        return textResult(
          `IM channel instance "${instanceId}" not found. The Bot may have been reconfigured.`,
          true
        )
      }

      if (!instance.isConnected()) {
        return textResult(
          `IM channel "${instanceId}" is currently disconnected. The message cannot be delivered.`,
          true
        )
      }

      const results: string[] = []

      // Helper: build error result that preserves prior successes.
      // When message was already sent but file fails, the AI must know
      // the message went through to avoid duplicate sends on retry.
      const errorWithContext = (errorMsg: string) => {
        if (results.length > 0) {
          return textResult(`${results.join(' ')} However, ${errorMsg}`, true)
        }
        return textResult(errorMsg, true)
      }

      // Send text message
      if (input.message) {
        try {
          const sent = instance.pushToChat(chatId, input.message, session.chatType)
          if (sent) {
            const contactName = session.customName || session.displayName || chatId
            console.log(`[Runtime][${runTag}] Bot message sent to "${contactName}" (${chatId})`)
            results.push(`Message sent to "${contactName}".`)
          } else {
            console.warn(`[Runtime][${runTag}] Bot message failed to "${chatId}"`)
            return textResult(`Failed to send message to "${chatId}". The channel returned false.`, true)
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          console.error(`[Runtime][${runTag}] Bot message error:`, err)
          return textResult(`Error sending message: ${errMsg}`, true)
        }
      }

      // Send file
      if (input.file) {
        // Validate file path through the export gate (space sandbox + tmpdir)
        let sanctioned
        try {
          sanctioned = context.exportGate.sanction(input.file)
        } catch (err) {
          if (err instanceof FileExportDeniedError) {
            console.warn(`[Runtime][${runTag}] File export denied: "${input.file}"`)
            return errorWithContext(
              `file export denied: "${input.file}" is outside the allowed directory. ` +
              'Only files within the app workspace or temp directory can be sent.'
            )
          }
          // File not found or other sanction error
          const errMsg = err instanceof Error ? err.message : String(err)
          return errorWithContext(errMsg)
        }

        if (!instance.fileCapability) {
          return errorWithContext(
            `this IM channel does not support file sending. Send the content as a text message instead.`
          )
        }

        // Override display name if caller provided an explicit filename
        const file = input.filename
          ? { ...sanctioned, displayName: input.filename }
          : sanctioned
        try {
          const sent = await instance.fileCapability.sendFile(
            chatId, file, session.chatType
          )
          if (sent) {
            const contactName = session.customName || session.displayName || chatId
            console.log(`[Runtime][${runTag}] Bot file sent to "${contactName}": ${file.displayName}`)
            results.push(`File "${file.displayName}" sent to "${contactName}".`)
          } else {
            console.warn(`[Runtime][${runTag}] Bot file send failed to "${chatId}"`)
            return errorWithContext(`failed to send file to "${chatId}". The channel returned false.`)
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          console.error(`[Runtime][${runTag}] Bot file send error:`, err)
          return errorWithContext(`error sending file: ${errMsg}`)
        }
      }

      return textResult(results.join(' '))
    }
  )
}

// ============================================
// Tool Factory
// ============================================

/**
 * Create the halo-notify MCP server with AI-driven notification tools.
 *
 * Tools are conditionally registered based on what's available:
 * - `notify_channel`: only when external channels are configured
 * - `notify_bot`: only when im-push permission is granted AND contacts exist
 *
 * If neither tool is available, the server is created with zero tools
 * (it will simply be invisible to the AI).
 *
 * @param context - The current run's identity and IM context
 * @returns An SDK MCP server instance
 */
export function createNotifyToolServer(context: NotifyToolContext): SdkMcpServer {
  const tools: ReturnType<typeof tool>[] = []

  const notifyChannel = buildNotifyChannelTool(context)
  if (notifyChannel) tools.push(notifyChannel)

  const notifyBot = buildNotifyBotTool(context)
  if (notifyBot) tools.push(notifyBot)

  if (tools.length > 0) {
    console.log(
      `[Runtime] halo-notify created: tools=[${tools.map(t => t.name).join(', ')}], ` +
      `app=${context.appId}, imSessions=${context.imSessions?.length ?? 0}`
    )
  }

  return createSdkMcpServer({
    name: 'halo-notify',
    version: '2.0.0',
    tools,
  })
}
