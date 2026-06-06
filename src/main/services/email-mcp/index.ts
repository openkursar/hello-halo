/**
 * Email MCP Server — Entry Point
 *
 * Creates an SDK MCP server providing email and calendar tools.
 * Uses the same pattern as report-tool.ts, notify-tool.ts, and web-search/mcp-server.ts.
 *
 * Architecture:
 * - IMAP (imapflow): receive, search, manage emails — lazy connection per-run
 * - SMTP (nodemailer): send emails — stateless per-send, same as notify-channels/email.ts
 * - CalDAV (fetch): calendar operations — stateless HTTP per-request (when caldavUrl is configured)
 *
 * All protocols share credentials from config.notificationChannels.email.
 * Enterprise builds pre-populate TLS ciphers and CalDAV URL via product.json serviceDefaults.
 *
 * Lifecycle:
 * - Created per executeRun() when email permission is granted
 * - IMAP connection is lazy (established on first tool call)
 * - Cleaned up when the run ends (session.close() releases MCP server)
 */

import { createSdkMcpServer } from '../agent/resolved-sdk'
import type { EmailChannelConfig } from '../../../shared/types/notification-channels'
import { getServiceDefaults } from '../../foundation/product-config'
import { ImapClient } from './imap-client'
import { SmtpClient } from './smtp-client'
import { CalDavClient } from './caldav-client'

// Tool factories
import { createEmailListTool } from './tools/email-list'
import { createEmailReadTool } from './tools/email-read'
import { createEmailSearchTool } from './tools/email-search'
import { createEmailSendTool } from './tools/email-send'
import { createEmailReplyTool } from './tools/email-reply'
import { createEmailForwardTool } from './tools/email-forward'
import { createEmailMoveTool } from './tools/email-move'
import { createEmailMarkTool } from './tools/email-mark'
import { createEmailDeleteTool } from './tools/email-delete'
import { createEmailFoldersTool } from './tools/email-folders'
import { createEmailAttachmentTool } from './tools/email-attachment'
import { createCalendarListTool } from './tools/calendar-list'
import { createCalendarCreateTool } from './tools/calendar-create'
import { createCalendarDeleteTool } from './tools/calendar-delete'

// ============================================
// Types
// ============================================

type SdkMcpServer = ReturnType<typeof createSdkMcpServer>

// ============================================
// Factory
// ============================================

/**
 * Merge product.json serviceDefaults.email into user config.
 * User-provided values always take precedence over defaults.
 */
function mergeEmailDefaults(userConfig: EmailChannelConfig): EmailChannelConfig {
  const defaults = getServiceDefaults()?.email
  if (!defaults) return userConfig

  return {
    ...defaults,
    ...userConfig,
    smtp: {
      ...defaults.smtp,
      ...userConfig.smtp,
    },
    // Prefer user-set values; fall back to serviceDefaults
    caldavUrl: userConfig.caldavUrl ?? defaults.caldavUrl,
    tlsCiphers: userConfig.tlsCiphers ?? defaults.tlsCiphers,
  } as EmailChannelConfig
}

/**
 * Create the Email MCP server with email and (optionally) calendar tools.
 *
 * All protocols derive from the same EmailChannelConfig:
 * - IMAP: host = config.smtp.host, port = 993, user/pass from smtp config
 * - SMTP: direct from config (same as notify-channels/email.ts)
 * - CalDAV: only registered when config.caldavUrl is set
 *
 * Enterprise builds pre-populate defaults via product.json serviceDefaults —
 * internal users get working config out of the box.
 *
 * @param rawConfig - Email channel config from config.notificationChannels.email
 * @returns An SDK MCP server instance
 */
export function createEmailMcpServer(rawConfig: EmailChannelConfig): SdkMcpServer {
  const config = mergeEmailDefaults(rawConfig)
  const userEmail = config.smtp.user

  // Create protocol clients
  const imap = new ImapClient(config)
  const smtp = new SmtpClient(config)
  const caldav = new CalDavClient(config)

  console.log(`[EmailMCP] Creating server: host=${config.smtp.host}, user=${userEmail}, caldav=${caldav.available ? 'enabled' : 'disabled'}`)

  // Email operations (11 tools — always available)
  const tools = [
    createEmailListTool(imap),
    createEmailReadTool(imap),
    createEmailSearchTool(imap),
    createEmailSendTool(smtp),
    createEmailReplyTool(imap, smtp, userEmail),
    createEmailForwardTool(imap, smtp),
    createEmailMoveTool(imap),
    createEmailMarkTool(imap),
    createEmailDeleteTool(imap),
    createEmailFoldersTool(imap),
    createEmailAttachmentTool(imap),
  ]

  // Calendar operations (3 tools — only when caldavUrl is configured)
  if (caldav.available) {
    tools.push(
      createCalendarListTool(caldav),
      createCalendarCreateTool(caldav),
      createCalendarDeleteTool(caldav),
    )
  }

  return createSdkMcpServer({
    name: 'halo-email',
    version: '1.0.0',
    tools,
  })
}
