/**
 * email_read downloads the body parts of a message, not its attachments, and
 * returns what reading the whole message returns: the same text and HTML, the
 * same attachment names and types, sizes from the structure.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailDetail } from '../../../../src/main/services/email-mcp/imap-client'

const { fetchOne } = vi.hoisted(() => ({ fetchOne: vi.fn() }))
vi.mock('imapflow', () => ({
  ImapFlow: class {
    on() {}
    async connect() {}
    async getMailboxLock() { return { release() {} } }
    fetchOne = fetchOne
  },
}))

import { ImapClient } from '../../../../src/main/services/email-mcp/imap-client'

const CRLF = '\r\n'
const lines = (...rows: string[]) => rows.join(CRLF) + CRLF

/**
 * A part as the server returns it: its MIME header block, and its encoded
 * body without the line break that belongs to the next boundary.
 */
interface RawPart { mime: string; body: string }

const base64Lines = (content: Buffer) => content.toString('base64').replace(/.{76}/g, `$&${CRLF}`)

const attachment = Buffer.alloc(512 * 1024, 42)

// "你好" in GB2312, quoted-printable: a non-UTF-8 charset behind a transfer encoding.
const parts: Record<string, RawPart> = {
  '1.1': {
    mime: lines('Content-Type: text/plain; charset=gb2312', 'Content-Transfer-Encoding: quoted-printable', ''),
    body: '=C4=E3=BA=C3, the report is attached.',
  },
  '1.2': {
    mime: lines('Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', ''),
    body: base64Lines(Buffer.from('<p>你好, the <b>report</b> is attached.</p>')),
  },
  '2': {
    mime: lines(
      'Content-Type: application/octet-stream; name="=?UTF-8?B?5ZGo5oql?=.pdf"',
      'Content-Disposition: attachment; filename="=?UTF-8?B?5ZGo5oql?=.pdf"',
      'Content-Transfer-Encoding: base64',
      ''
    ),
    body: base64Lines(attachment),
  },
}

const source = lines(
  'From: Alice <alice@example.com>',
  'To: Bob <bob@example.com>',
  'Subject: Weekly report',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="mixed"',
  '',
  '--mixed',
  'Content-Type: multipart/alternative; boundary="alt"',
  '',
  '--alt',
) + parts['1.1'].mime + parts['1.1'].body + CRLF + lines('--alt') + parts['1.2'].mime + parts['1.2'].body + CRLF +
  lines('--alt--', '', '--mixed') + parts['2'].mime + parts['2'].body + CRLF + lines('--mixed--')

const size = (part: string) => Buffer.byteLength(parts[part].body)

const structure = {
  type: 'multipart/mixed',
  childNodes: [
    {
      part: '1',
      type: 'multipart/alternative',
      childNodes: [
        { part: '1.1', type: 'text/plain', encoding: 'quoted-printable', size: size('1.1') },
        { part: '1.2', type: 'text/html', encoding: 'base64', size: size('1.2') },
      ],
    },
    { part: '2', type: 'application/octet-stream', encoding: 'base64', size: size('2'), disposition: 'attachment' },
  ],
}

const envelope = {
  subject: 'Weekly report',
  from: [{ name: 'Alice', address: 'alice@example.com' }],
  to: [{ name: 'Bob', address: 'bob@example.com' }],
  date: new Date('2026-10-01T09:00:00Z'),
}

/** Serves the message the way imapflow answers each kind of FETCH. */
function serve(bodyStructure: unknown, rawSource: string, rawParts: Record<string, RawPart>) {
  fetchOne.mockImplementation(async (_uid: number, query: Record<string, unknown>) => {
    if (query.source) return { uid: 7, source: Buffer.from(rawSource) }
    if (Array.isArray(query.bodyParts)) {
      return {
        uid: 7,
        bodyParts: new Map((query.bodyParts as string[]).map(key => {
          const isHeader = key.endsWith('.mime')
          const part = rawParts[isHeader ? key.slice(0, -'.mime'.length) : key]
          return [key, Buffer.from(isHeader ? part.mime : part.body)]
        })),
      }
    }
    return { uid: 7, envelope, bodyStructure }
  })
}

const requested = () => fetchOne.mock.calls.map(call => call[1] as Record<string, unknown>)
const requestedParts = () => requested().flatMap(query => (query.bodyParts as string[] | undefined) ?? [])
const downloadedWhole = () => requested().some(query => query.source)

function client() {
  return new ImapClient({ smtp: { host: 'imap.example.com', user: 'u', password: 'p' } } as never)
}

/** The message read whole: what email_read returned before reading parts. */
async function readWhole(format: 'text' | 'html' | 'full'): Promise<EmailDetail> {
  serve(undefined, source, parts)
  const detail = await client().readEmail('7', 'INBOX', format, 0)
  expect(downloadedWhole()).toBe(true)
  fetchOne.mockReset()
  return detail
}

beforeEach(() => {
  fetchOne.mockReset()
})

describe('ImapClient.readEmail', () => {
  it('reads the body without downloading the attachment, returning what the whole message gives', async () => {
    const whole = await readWhole('full')
    serve(structure, source, parts)

    const detail = await client().readEmail('7', 'INBOX', 'full', 0)

    expect(downloadedWhole()).toBe(false)
    expect(requestedParts()).toEqual(['1.1.mime', '1.1', '1.2.mime', '1.2', '2.mime'])
    expect(detail.body).toBe(whole.body)
    expect(detail.body).toBe('你好, the report is attached.')
    expect(detail.html_body).toBe(whole.html_body)
    expect(detail.html_body).toContain('<b>report</b>')
    expect(detail.attachments).toHaveLength(1)
    expect(detail.attachments[0]).toMatchObject({
      filename: whole.attachments[0].filename,
      content_type: whole.attachments[0].content_type,
      part_id: '2',
    })
    expect(detail.attachments[0].filename).toBe('周报.pdf')
    expect(detail.attachments[0].content_type).toBe('application/pdf')
    expect(Math.abs(detail.attachments[0].size - whole.attachments[0].size)).toBeLessThanOrEqual(3)
  })

  it('downloads only the plain body for the text format', async () => {
    serve(structure, source, parts)

    const detail = await client().readEmail('7', 'INBOX', 'text', 5000)

    expect(requestedParts()).toEqual(['1.1.mime', '1.1', '2.mime'])
    expect(detail.html_body).toBe('')
    expect(detail.body).toBe('你好, the report is attached.')
  })

  it('truncates the body as before', async () => {
    serve(structure, source, parts)

    const detail = await client().readEmail('7', 'INBOX', 'text', 4)

    expect(detail.body).toBe('你好, \n... (truncated)')
  })

  it('reads the whole message when the HTML references inline images', async () => {
    const related = {
      type: 'multipart/related',
      childNodes: [
        { part: '1', type: 'text/html', encoding: 'base64', size: size('1.2') },
        { part: '2', type: 'image/png', encoding: 'base64', size: 120, disposition: 'inline', id: '<logo>' },
      ],
    }
    serve(related, source, parts)

    await client().readEmail('7', 'INBOX', 'html', 0)

    expect(downloadedWhole()).toBe(true)
  })

  it.each([
    ['an attachment', '2'],
    ['a body part', '1.1'],
  ])('reads the whole message when the server returns no header block for %s', async (_label, part) => {
    const whole = await readWhole('text')
    serve(structure, source, { ...parts, [part]: { mime: '', body: parts[part].body } })

    const detail = await client().readEmail('7', 'INBOX', 'text', 0)

    expect(downloadedWhole()).toBe(true)
    expect(detail).toEqual(whole)
  })

  it('reads the whole message when fetching the parts fails', async () => {
    const whole = await readWhole('text')
    serve(structure, source, parts)
    const answer = fetchOne.getMockImplementation()!
    fetchOne.mockImplementation(async (uid: number, query: Record<string, unknown>) => {
      if (query.bodyParts) throw new Error('BAD Invalid part specifier')
      return answer(uid, query)
    })

    const detail = await client().readEmail('7', 'INBOX', 'text', 0)

    expect(downloadedWhole()).toBe(true)
    expect(detail).toEqual(whole)
  })

  it('reads a single-part message whole', async () => {
    const single = lines('From: a@example.com', 'Subject: hi', 'Content-Type: text/plain; charset=utf-8', '', 'Just text.')
    serve({ type: 'text/plain', encoding: '7bit', size: 12 }, single, {})

    const detail = await client().readEmail('7', 'INBOX', 'text', 0)

    expect(downloadedWhole()).toBe(true)
    expect(detail.body).toContain('Just text.')
  })
})
