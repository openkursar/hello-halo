/**
 * Email MCP — IMAP Client
 *
 * Manages IMAP connections using imapflow for receiving, searching,
 * and managing emails. Handles the per-run lifecycle: connection is
 * established when the MCP server is created and closed when the run ends.
 *
 * Key design decisions:
 * - Uses imapflow for modern Promise-based IMAP support
 * - TLS cipher is configurable via config.tlsCiphers (enterprise builds pre-populate via product.json)
 * - Connection is lazy: established on first tool call, not at creation
 * - No connection pool (per-run lifecycle, same as scoped browser context)
 */

import type { EmailChannelConfig } from '../../../shared/types/notification-channels'
import {
  resolveImapFolderName,
  getFolderDisplayName,
  identifySystemFolder,
  type FolderInfo,
} from './folder-mapping'
import { planMessageParts, type BodyStructureNode } from './message-parts'

// Dynamic import for imapflow
let ImapFlowModule: typeof import('imapflow') | null = null
async function getImapFlow() {
  if (!ImapFlowModule) {
    ImapFlowModule = await import('imapflow')
  }
  return ImapFlowModule
}

// ============================================
// Types
// ============================================

export interface EmailSummary {
  id: string
  subject: string
  from: string
  date: string
  unread: boolean
  has_attachments: boolean
}

export interface EmailDetail {
  id: string
  subject: string
  from: string
  to: string
  cc: string
  date: string
  body: string
  html_body: string
  attachments: AttachmentInfo[]
}

export interface AttachmentInfo {
  filename: string
  content_type: string
  size: number
  part_id: string
}

export interface FolderStatus {
  name: string
  display_name: string
  type: 'system' | 'custom'
  message_count?: number
  unread_count?: number
}

/** Body text and attachment list of a message, before truncation. */
interface MessageContent {
  text: string
  html: string
  attachments: AttachmentInfo[]
}

// ============================================
// IMAP Client
// ============================================

export class ImapClient {
  private client: any = null
  private config: EmailChannelConfig
  private connected = false
  private knownFolders: Map<string, FolderInfo> = new Map()

  constructor(config: EmailChannelConfig) {
    this.config = config
  }

  /**
   * Ensure IMAP connection is established.
   * Lazy: called on first tool invocation.
   *
   * Also wires up 'error'/'close' listeners so that async socket failures
   * (e.g. idle-connection socket timeouts, server-side disconnects, network
   * drops after sleep/wake) do NOT propagate to the main process as
   * uncaughtException. Without a listener, ImapFlow.emit('error', err) would
   * bubble up and trigger Electron's native error dialog.
   */
  async connect(): Promise<void> {
    if (this.connected && this.client) return

    const { ImapFlow } = await getImapFlow()

    const client = new ImapFlow({
      host: this.config.smtp.host,
      port: 993,
      secure: true,
      auth: {
        user: this.config.smtp.user,
        pass: this.config.smtp.password,
      },
      tls: {
        rejectUnauthorized: false,
        ...(this.config.tlsCiphers ? { ciphers: this.config.tlsCiphers } : {}),
      },
      logger: false,
    })

    // Swallow async socket/protocol errors. Any in-flight operation will
    // still reject via its awaited promise; this listener only prevents the
    // error from becoming an uncaughtException when no operation is pending
    // (e.g. socket idle timeout between tool calls).
    client.on('error', (err: Error & { code?: string }) => {
      console.warn(
        `[EmailMCP][IMAP] Client error (auto-recovery on next call): ${err?.code || ''} ${err?.message || err}`
      )
      this.connected = false
    })

    // Mark as disconnected when the server/socket closes so the next
    // tool call triggers a fresh connect() instead of using a dead client.
    client.on('close', () => {
      if (this.connected) {
        console.log('[EmailMCP][IMAP] Connection closed by server or network')
      }
      this.connected = false
    })

    await client.connect()
    this.client = client
    this.connected = true
    console.log(`[EmailMCP][IMAP] Connected to ${this.config.smtp.host}:993`)
  }

  /**
   * Disconnect and clean up.
   */
  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      try {
        await this.client.logout()
      } catch {
        // Ignore logout errors during cleanup
      }
      this.connected = false
      this.client = null
      console.log('[EmailMCP][IMAP] Disconnected')
    }
  }

  /**
   * Resolve a folder name (friendly or encoded) to the IMAP name.
   */
  resolveFolder(name: string): string {
    return resolveImapFolderName(name, this.knownFolders.size > 0 ? this.knownFolders : undefined)
  }

  /**
   * List all mailbox folders.
   */
  async listFolders(): Promise<FolderStatus[]> {
    await this.connect()

    const folders: FolderStatus[] = []
    const mailboxes = await this.client.list()

    for (const mailbox of mailboxes) {
      const displayName = getFolderDisplayName(mailbox.path)
      const flags = new Set<string>(Array.from(mailbox.flags ?? []))
      const sysType = identifySystemFolder(mailbox.path, flags)

      const info: FolderInfo = {
        name: mailbox.path,
        displayName,
        type: sysType ? 'system' : 'custom',
      }
      this.knownFolders.set(mailbox.path, info)

      const folderStatus: FolderStatus = {
        name: mailbox.path,
        display_name: displayName,
        type: sysType ? 'system' : 'custom',
      }

      // Get message counts (best-effort, may be slow for large folders)
      try {
        const status = await this.client.status(mailbox.path, { messages: true, unseen: true })
        folderStatus.message_count = status.messages
        folderStatus.unread_count = status.unseen
      } catch {
        // Some folders may not support STATUS
      }

      folders.push(folderStatus)
    }

    return folders
  }

  /**
   * List emails in a folder.
   */
  async listEmails(
    folder: string,
    limit: number,
    unreadOnly: boolean
  ): Promise<{ total: number; unread: number; emails: EmailSummary[] }> {
    await this.connect()
    const imapFolder = this.resolveFolder(folder)

    const lock = await this.client.getMailboxLock(imapFolder)
    try {
      const mailbox = this.client.mailbox
      const total = mailbox.exists || 0
      const searchCriteria = unreadOnly ? { seen: false } : { all: true }

      // Search for message sequence numbers
      const results = await this.client.search(searchCriteria, { uid: true })
      const unread = unreadOnly ? results.length : (
        await this.client.search({ seen: false }, { uid: true })
      ).length

      if (results.length === 0) {
        return { total, unread, emails: [] }
      }

      // Get the latest N messages (newest first)
      const sortedUids = results.sort((a: number, b: number) => b - a)
      const uidRange = sortedUids.slice(0, limit)

      const emails: EmailSummary[] = []
      for await (const msg of this.client.fetch(
        uidRange.join(','),
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
        },
        { uid: true }
      )) {
        const envelope = msg.envelope
        const fromAddr = envelope?.from?.[0]
        const fromStr = fromAddr
          ? (fromAddr.name ? `${fromAddr.name} <${fromAddr.address}>` : fromAddr.address)
          : 'Unknown'

        const hasAttachments = detectAttachments(msg.bodyStructure)

        emails.push({
          id: String(msg.uid),
          subject: envelope?.subject || '(No Subject)',
          from: fromStr || 'Unknown',
          date: formatDate(envelope?.date),
          unread: !msg.flags?.has('\\Seen'),
          has_attachments: hasAttachments,
        })
      }

      return { total, unread, emails }
    } finally {
      lock.release()
    }
  }

  /**
   * Read a single email by UID.
   */
  async readEmail(
    emailId: string,
    folder: string,
    format: 'text' | 'html' | 'full',
    maxBodyLength: number
  ): Promise<EmailDetail> {
    await this.connect()
    const imapFolder = this.resolveFolder(folder)
    const uid = parseInt(emailId, 10)

    const lock = await this.client.getMailboxLock(imapFolder)
    try {
      const msg = await this.client.fetchOne(
        uid,
        {
          uid: true,
          envelope: true,
          bodyStructure: true,
        },
        { uid: true }
      )

      if (!msg) {
        throw new Error(`Email with ID ${emailId} not found in folder ${folder}`)
      }

      const envelope = msg.envelope
      const fromAddr = envelope?.from?.[0]
      const fromStr = fromAddr
        ? (fromAddr.name ? `${fromAddr.name} <${fromAddr.address}>` : fromAddr.address)
        : 'Unknown'

      const toStr = envelope?.to?.map((a: any) =>
        a.name ? `${a.name} <${a.address}>` : a.address
      ).join(', ') || ''

      const ccStr = envelope?.cc?.map((a: any) =>
        a.name ? `${a.name} <${a.address}>` : a.address
      ).join(', ') || ''

      const wantsText = format === 'text' || format === 'full'
      const wantsHtml = format === 'html' || format === 'full'
      let content: MessageContent | null = null
      try {
        content = await this.readBodyParts(uid, msg.bodyStructure, wantsText, wantsHtml)
      } catch (err) {
        console.warn(
          `[EmailMCP][IMAP] Reading the body parts of email ${emailId} failed, downloading the whole message: ` +
          `${err instanceof Error ? err.message : String(err)}`
        )
      }
      content ??= await this.readWholeMessage(uid, emailId)

      let body = ''
      let htmlBody = ''

      if (wantsText) {
        body = content.text
        if (maxBodyLength > 0 && body.length > maxBodyLength) {
          body = body.slice(0, maxBodyLength) + '\n... (truncated)'
        }
      }

      if (wantsHtml) {
        htmlBody = content.html
        if (maxBodyLength > 0 && htmlBody.length > maxBodyLength) {
          htmlBody = htmlBody.slice(0, maxBodyLength) + '\n... (truncated)'
        }
      }

      return {
        id: emailId,
        subject: envelope?.subject || '(No Subject)',
        from: fromStr,
        to: toStr,
        cc: ccStr,
        date: formatDate(envelope?.date),
        body,
        html_body: htmlBody,
        attachments: content.attachments,
      }
    } finally {
      lock.release()
    }
  }

  /**
   * Read only the body parts the format needs, plus each attachment's MIME
   * header for its name and type, in one FETCH. Each part is parsed by
   * mailparser on its own headers, the same decoding (transfer encoding,
   * charset, format=flowed) a whole-message parse applies. Returns null when
   * the structure needs the whole message (see planMessageParts).
   */
  private async readBodyParts(
    uid: number,
    bodyStructure: BodyStructureNode | undefined,
    wantsText: boolean,
    wantsHtml: boolean
  ): Promise<MessageContent | null> {
    const plan = planMessageParts(bodyStructure)
    if (!plan) return null
    // A whole-message parse inlines the images an HTML body references as
    // data: URLs; only it can produce that HTML.
    if (wantsHtml && plan.attachments.some(att => att.related)) return null

    // Without a plain-text part the text body stays empty, as mailparser
    // derives text from HTML only for a single-part message.
    const plainPart = wantsText ? plan.plainPart : undefined
    const htmlPart = wantsHtml ? plan.htmlPart : undefined
    const keys = [
      ...[plainPart, htmlPart].flatMap(part => (part ? [`${part}.mime`, part] : [])),
      ...plan.attachments.map(att => `${att.part}.mime`),
    ]
    const fetched: Map<string, Buffer> | undefined = keys.length > 0
      ? (await this.client.fetchOne(uid, { uid: true, bodyParts: keys }, { uid: true }))?.bodyParts
      : undefined

    const { simpleParser } = await import('mailparser')
    const parsePart = async (part: string, withBody: boolean, options: Record<string, unknown> = {}) => {
      const header = fetched?.get(`${part}.mime`)
      const body = withBody ? fetched?.get(part) : Buffer.alloc(0)
      // Without its header block a part cannot be decoded as the whole message decodes it.
      if (!header?.toString('latin1').trim() || !body) throw new Error(`the server returned no content for part ${part}`)
      return simpleParser(Buffer.concat([terminateHeader(header), body]), options)
    }

    let text = ''
    if (plainPart) {
      text = (await parsePart(plainPart, true, { skipTextToHtml: true })).text || ''
    }

    let html = ''
    if (htmlPart) {
      html = (await parsePart(htmlPart, true, { skipHtmlToText: true })).html || ''
    }

    const attachments: AttachmentInfo[] = []
    for (const att of plan.attachments) {
      const parsed = await parsePart(att.part, false)
      const described = parsed.attachments.length === 1 ? parsed.attachments[0] : null
      if (!described) throw new Error(`part ${att.part} does not describe an attachment by its own headers`)
      attachments.push({
        filename: described.filename || 'unnamed',
        content_type: described.contentType || 'application/octet-stream',
        size: att.size,
        part_id: described.contentId || att.part,
      })
    }

    return { text, html, attachments }
  }

  /** Download and parse the whole message, attachments included. */
  private async readWholeMessage(uid: number, emailId: string): Promise<MessageContent> {
    const msg = await this.client.fetchOne(uid, { uid: true, source: true }, { uid: true })
    if (!msg?.source) {
      throw new Error(`Email with ID ${emailId} could not be downloaded`)
    }

    const { simpleParser } = await import('mailparser')
    const parsed = await simpleParser(msg.source)
    return {
      text: parsed.text || '',
      html: parsed.html || '',
      attachments: (parsed.attachments || []).map(att => ({
        filename: att.filename || 'unnamed',
        content_type: att.contentType || 'application/octet-stream',
        size: att.size || 0,
        part_id: att.contentId || att.checksum || '',
      })),
    }
  }

  /**
   * Search emails by criteria.
   */
  async searchEmails(
    folder: string,
    criteria: {
      subject?: string
      from?: string
      to?: string
      since?: string
      before?: string
    },
    limit: number
  ): Promise<{ emails: EmailSummary[] }> {
    await this.connect()
    const imapFolder = this.resolveFolder(folder)

    const lock = await this.client.getMailboxLock(imapFolder)
    try {
      // Build IMAP search query
      const searchQuery: any = {}

      if (criteria.from) {
        searchQuery.from = criteria.from
      }
      if (criteria.to) {
        searchQuery.to = criteria.to
      }
      if (criteria.since) {
        searchQuery.since = new Date(criteria.since)
      }
      if (criteria.before) {
        searchQuery.before = new Date(criteria.before)
      }

      // For subject search — IMAP SEARCH with CHARSET is unreliable for CJK.
      // Use server-side search for ASCII, client-side filter for non-ASCII.
      let needsClientFilter = false
      if (criteria.subject) {
        if (/^[\x00-\x7F]*$/.test(criteria.subject)) {
          searchQuery.subject = criteria.subject
        } else {
          // Non-ASCII: fetch more messages and filter client-side
          needsClientFilter = true
        }
      }

      const results = await this.client.search(
        Object.keys(searchQuery).length > 0 ? searchQuery : { all: true },
        { uid: true }
      )

      if (results.length === 0) {
        return { emails: [] }
      }

      // Sort newest first
      const sortedUids = results.sort((a: number, b: number) => b - a)

      // If client-side filtering is needed, fetch more and filter
      const fetchLimit = needsClientFilter ? Math.min(sortedUids.length, limit * 5) : Math.min(sortedUids.length, limit)
      const uidRange = sortedUids.slice(0, fetchLimit)

      const emails: EmailSummary[] = []
      for await (const msg of this.client.fetch(
        uidRange.join(','),
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
        },
        { uid: true }
      )) {
        const envelope = msg.envelope
        const fromAddr = envelope?.from?.[0]
        const fromStr = fromAddr
          ? (fromAddr.name ? `${fromAddr.name} <${fromAddr.address}>` : fromAddr.address)
          : 'Unknown'

        // Client-side subject filter for CJK
        if (needsClientFilter && criteria.subject) {
          const subject = envelope?.subject || ''
          if (!subject.toLowerCase().includes(criteria.subject.toLowerCase())) {
            continue
          }
        }

        emails.push({
          id: String(msg.uid),
          subject: envelope?.subject || '(No Subject)',
          from: fromStr,
          date: formatDate(envelope?.date),
          unread: !msg.flags?.has('\\Seen'),
          has_attachments: detectAttachments(msg.bodyStructure),
        })

        if (emails.length >= limit) break
      }

      return { emails }
    } finally {
      lock.release()
    }
  }

  /**
   * Move an email between folders.
   */
  async moveEmail(emailId: string, fromFolder: string, toFolder: string): Promise<void> {
    await this.connect()
    const imapFrom = this.resolveFolder(fromFolder)
    const imapTo = this.resolveFolder(toFolder)
    const uid = parseInt(emailId, 10)

    const lock = await this.client.getMailboxLock(imapFrom)
    try {
      await this.client.messageMove(uid, imapTo, { uid: true })
    } finally {
      lock.release()
    }
  }

  /**
   * Update email flags (read/unread/flag/unflag).
   */
  async markEmail(
    emailIds: string[],
    action: 'read' | 'unread' | 'flag' | 'unflag',
    folder: string
  ): Promise<number> {
    await this.connect()
    const imapFolder = this.resolveFolder(folder)
    const uids = emailIds.map(id => parseInt(id, 10))

    const lock = await this.client.getMailboxLock(imapFolder)
    try {
      const uidRange = uids.join(',')
      switch (action) {
        case 'read':
          await this.client.messageFlagsAdd(uidRange, ['\\Seen'], { uid: true })
          break
        case 'unread':
          await this.client.messageFlagsRemove(uidRange, ['\\Seen'], { uid: true })
          break
        case 'flag':
          await this.client.messageFlagsAdd(uidRange, ['\\Flagged'], { uid: true })
          break
        case 'unflag':
          await this.client.messageFlagsRemove(uidRange, ['\\Flagged'], { uid: true })
          break
      }
      return uids.length
    } finally {
      lock.release()
    }
  }

  /**
   * Delete an email (move to Trash or permanently delete).
   */
  async deleteEmail(emailIds: string[], folder: string, permanent: boolean): Promise<number> {
    await this.connect()
    const imapFolder = this.resolveFolder(folder)
    const uids = emailIds.map(id => parseInt(id, 10))

    const lock = await this.client.getMailboxLock(imapFolder)
    try {
      const uidRange = uids.join(',')
      if (permanent) {
        await this.client.messageDelete(uidRange, { uid: true })
      } else {
        // Move to Trash
        const trashFolder = this.resolveFolder('Trash')
        await this.client.messageMove(uidRange, trashFolder, { uid: true })
      }
      return uids.length
    } finally {
      lock.release()
    }
  }

  /**
   * Download an attachment from an email.
   */
  async downloadAttachment(
    emailId: string,
    filename: string,
    folder: string,
    savePath?: string
  ): Promise<{ path: string; size: number; content_type: string }> {
    await this.connect()
    const imapFolder = this.resolveFolder(folder)
    const uid = parseInt(emailId, 10)

    const lock = await this.client.getMailboxLock(imapFolder)
    try {
      const msg = await this.client.fetchOne(uid, { source: true }, { uid: true })
      if (!msg) {
        throw new Error(`Email with ID ${emailId} not found`)
      }

      const { simpleParser } = await import('mailparser')
      const parsed = await simpleParser(msg.source)

      const attachment = parsed.attachments?.find(
        (att: any) => att.filename === filename
      )
      if (!attachment) {
        throw new Error(`Attachment "${filename}" not found in email ${emailId}`)
      }

      // Determine save path
      const { join } = await import('path')
      const { writeFile, mkdir } = await import('fs/promises')
      const { tmpdir } = await import('os')

      const dir = savePath
        ? (await import('path')).dirname(savePath)
        : join(tmpdir(), 'halo_attachments')
      await mkdir(dir, { recursive: true })

      const filePath = savePath || join(dir, filename)
      await writeFile(filePath, attachment.content)

      return {
        path: filePath,
        size: attachment.size,
        content_type: attachment.contentType || 'application/octet-stream',
      }
    } finally {
      lock.release()
    }
  }

  /**
   * Get the raw message source for reply/forward operations.
   */
  async getRawMessage(emailId: string, folder: string): Promise<{
    envelope: any
    source: Buffer
  }> {
    await this.connect()
    const imapFolder = this.resolveFolder(folder)
    const uid = parseInt(emailId, 10)

    const lock = await this.client.getMailboxLock(imapFolder)
    try {
      const msg = await this.client.fetchOne(
        uid,
        { uid: true, envelope: true, source: true },
        { uid: true }
      )
      if (!msg) {
        throw new Error(`Email with ID ${emailId} not found`)
      }
      return { envelope: msg.envelope, source: msg.source }
    } finally {
      lock.release()
    }
  }
}

// ============================================
// Helpers
// ============================================

function formatDate(date: Date | undefined | null): string {
  if (!date) return ''
  const d = new Date(date)
  const y = d.getFullYear()
  const m = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  const h = d.getHours().toString().padStart(2, '0')
  const min = d.getMinutes().toString().padStart(2, '0')
  return `${y}-${m}-${day} ${h}:${min}`
}

/** A MIME header block followed by the blank line that ends it. */
function terminateHeader(header: Buffer): Buffer {
  const tail = header.subarray(-4).toString('latin1')
  if (tail.endsWith('\r\n\r\n') || tail.endsWith('\n\n')) return header
  return Buffer.concat([header, Buffer.from(tail.endsWith('\n') ? '\r\n' : '\r\n\r\n')])
}

/**
 * Detect if a BODYSTRUCTURE has attachments.
 */
function detectAttachments(bodyStructure: any): boolean {
  if (!bodyStructure) return false

  if (bodyStructure.disposition === 'attachment') return true

  if (bodyStructure.childNodes) {
    return bodyStructure.childNodes.some((child: any) => detectAttachments(child))
  }

  return false
}
