/**
 * Minimal types for mailparser, which ships none: the parts email-mcp reads.
 */
declare module 'mailparser' {
  export interface ParsedAttachment {
    filename?: string
    contentType: string
    contentId?: string
    checksum: string
    size: number
    content: Buffer
  }

  export interface ParsedMail {
    text?: string
    html: string | false
    attachments: ParsedAttachment[]
  }

  export function simpleParser(source: Buffer | string, options?: Record<string, unknown>): Promise<ParsedMail>
}
