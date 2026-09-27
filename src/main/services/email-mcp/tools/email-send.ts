/**
 * email_send — Send a new email.
 */

import { z } from 'zod'
import { tool } from '../../agent/resolved-sdk'
import type { SmtpClient } from '../smtp-client'
import { textResult } from '../helpers'

/**
 * @param refuseAttachment - Why a local file may not be attached, or null;
 *   read at send time (the caller's turn decides).
 */
export function createEmailSendTool(smtp: SmtpClient, refuseAttachment?: (filePath: string) => string | null) {
  return tool(
    'email_send',
    'Send a new email from the configured account. Supports plain text and HTML content, CC/BCC, and file attachments.\n\n' +
    'IMPORTANT: This is a destructive action — the email will be sent immediately and cannot be recalled.\n' +
    'Example: { "to": "alice@example.com", "subject": "Meeting Notes", "body": "Here are the notes..." }',
    {
      to: z.string().describe(
        'Recipient email address(es). Multiple addresses separated by commas. Example: "alice@example.com, bob@example.com"'
      ),
      subject: z.string().describe(
        'Email subject line.'
      ),
      body: z.string().describe(
        'Email body content. Plain text by default. Set is_html=true for HTML content.'
      ),
      cc: z.string().optional().describe(
        'CC recipient(s). Multiple addresses separated by commas.'
      ),
      bcc: z.string().optional().describe(
        'BCC recipient(s). Multiple addresses separated by commas.'
      ),
      is_html: z.boolean().default(false).describe(
        'If true, body is treated as HTML content. Default: false (plain text).'
      ),
      attachments: z.array(z.string()).optional().describe(
        'List of local file paths to attach. Example: ["/path/to/file.pdf"]'
      ),
    },
    async (input) => {
      for (const filePath of input.attachments ?? []) {
        const refusal = refuseAttachment?.(filePath)
        if (refusal) return textResult(`Failed to send email: cannot attach "${filePath}". ${refusal}`, true)
      }
      try {
        const result = await smtp.send({
          to: input.to,
          subject: input.subject,
          body: input.body,
          cc: input.cc,
          bcc: input.bcc,
          isHtml: input.is_html,
          attachments: input.attachments,
        })
        return textResult(JSON.stringify({
          success: true,
          message_id: result.messageId,
          sent_to: result.sentTo,
          sent_at: result.sentAt,
        }, null, 2))
      } catch (err) {
        return textResult(`Failed to send email: ${err instanceof Error ? err.message : String(err)}`, true)
      }
    }
  )
}
