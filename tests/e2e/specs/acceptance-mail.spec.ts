import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  test, expect, mailAcceptance, mailRecipients, prepareMailPerson, performMailTool, assertMailHistory,
} from '../fixtures/acceptance-mail'
import { parseFixtureCalendar } from '../fixtures/acceptance-mail-caldav'

test.setTimeout(180000)

interface ParsedMail {
  messageId?: string
  subject?: string
  text?: string
  from?: unknown
  to?: unknown
  cc?: unknown
  bcc?: unknown
  attachments: Array<{ filename?: string; content: Buffer }>
}

const { simpleParser } = createRequire(import.meta.url)('mailparser') as { simpleParser(source: Buffer): Promise<ParsedMail> }

function addresses(value: unknown): string[] {
  const headers = (Array.isArray(value) ? value : value ? [value] : []) as Array<{ value: Array<{ address?: string }> }>
  return headers.flatMap(header => header.value.flatMap(address => address.address ? [address.address.toLowerCase()] : [])).sort()
}

function seedCalendarEvent(uid: string, owner: string, summary: string) {
  return Buffer.from([
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:${uid}`,
    'DTSTART;TZID=Asia/Shanghai:20300405T093000', 'DTEND;TZID=Asia/Shanghai:20300405T100000',
    `SUMMARY:${summary}`, `ORGANIZER:mailto:${owner}`, 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n'))
}

function assertFailedTool(result: Awaited<ReturnType<typeof performMailTool>>, message: RegExp) {
  expect(result.tool.toolResult?.isError).toBe(true)
  expect(result.text).toMatch(message)
  expect(result.text).not.toMatch(/"success"\s*:\s*true/)
}

test('email_send persists only the requested synthetic MIME delivery and exposes auth and temporary refusal before recovery', mailAcceptance('send'), async ({ mailBackend, acceptanceApp, model, window }, info) => {
  const person = await prepareMailPerson(window, acceptanceApp.profile, mailBackend)
  const attachment = Buffer.concat([Buffer.from([0, 255, 17, 128]), Buffer.from(`Owned attachment 中文 ${randomUUID()}`)])
  const untouched = Buffer.from(`Unselected file ${randomUUID()}`)
  const file = join(person.directory, '证据_attachment.bin'), controlFile = join(person.directory, 'unselected-control.bin')
  writeFileSync(file, attachment)
  writeFileSync(controlFile, untouched)
  const histories: Array<Awaited<ReturnType<typeof performMailTool>>> = []
  const outcomes: Array<Record<string, unknown>> = []
  try {
    for (const phase of ['success', 'auth', 'transport', 'recovery'] as const) {
      mailBackend.smtp.setFailure(phase === 'auth' || phase === 'transport' ? phase : 'none')
      const before = mailBackend.smtp.readMessages()
      const requestStart = mailBackend.smtp.receipts.length
      const subject = `Synthetic ${phase} 中文 ${randomUUID()}`
      const body = `Owned body for ${subject}\n.leading dot survives transport`
      const result = await performMailTool(window, model, person, 'email_send', { to: mailRecipients[0], cc: mailRecipients[1], bcc: mailRecipients[2], subject, body, is_html: false, attachments: [file] })
      histories.push(result)
      const receipts = mailBackend.smtp.receipts.slice(requestStart)
      const after = mailBackend.smtp.readMessages()
      if (phase === 'auth' || phase === 'transport') {
        assertFailedTool(result, phase === 'auth' ? /Failed to send email:.*535/s : /Failed to send email:.*451/s)
        expect(after).toEqual(before)
        expect(receipts.some(receipt => receipt.command === (phase === 'auth' ? 'AUTH' : 'DATA') && receipt.status === (phase === 'auth' ? 535 : 451))).toBe(true)
        expect(receipts.some(receipt => receipt.command === 'DATA' && receipt.status === 250)).toBe(false)
      } else {
        expect(result.tool.toolResult?.isError).toBe(false)
        const returned = JSON.parse(result.text) as { success: boolean; message_id: string; sent_to: string[] }
        expect(returned).toMatchObject({ success: true, sent_to: [mailRecipients[0]] })
        const added = after.filter(message => !before.some(old => old.id === message.id))
        expect(added).toHaveLength(1)
        expect(after.filter(message => before.some(old => old.id === message.id))).toEqual(before)
        const message = added[0]
        expect(message).toMatchObject({ account: 'primary', from: mailBackend.accounts.primary.user })
        expect([...message.to].sort()).toEqual(mailRecipients.slice(0, 3).sort())
        const parsed = await simpleParser(message.raw)
        expect(parsed.messageId).toBe(returned.message_id)
        expect(parsed.subject).toBe(subject)
        expect(parsed.text?.trimEnd()).toBe(body)
        expect(addresses(parsed.from)).toEqual([mailBackend.accounts.primary.user])
        expect(addresses(parsed.to)).toEqual([mailRecipients[0]])
        expect(addresses(parsed.cc)).toEqual([mailRecipients[1]])
        expect(parsed.bcc).toBeUndefined()
        expect(parsed.attachments).toHaveLength(1)
        expect(parsed.attachments[0].filename).toBe('证据_attachment.bin')
        expect(parsed.attachments[0].content).toEqual(attachment)
        expect(receipts.filter(receipt => receipt.command === 'DATA' && receipt.status === 250)).toHaveLength(1)
        expect(receipts.some(receipt => receipt.command === 'AUTH' && receipt.status === 235 && receipt.account === 'primary')).toBe(true)
      }
      expect(after.every(message => message.account === 'primary' && !message.to.includes(mailRecipients[3]))).toBe(true)
      expect(readFileSync(file)).toEqual(attachment)
      expect(readFileSync(controlFile)).toEqual(untouched)
      outcomes.push({ phase, acceptedMessages: after.map(message => ({ id: message.id, account: message.account, from: message.from, to: message.to, size: message.size })), receipts, toolError: result.tool.toolResult?.isError })
    }
    const stored = mailBackend.smtp.readMessages()
    expect(stored).toHaveLength(2)
    const reopened = await acceptanceApp.restart()
    await assertMailHistory(reopened, person, histories)
    expect(mailBackend.smtp.readMessages()).toEqual(stored)
    expect(readFileSync(file)).toEqual(attachment)
    expect(readFileSync(controlFile)).toEqual(untouched)
    expect(model.exchanges).toHaveLength(8)
  } finally {
    mailBackend.smtp.setFailure('none')
    await info.attach('mail-send-outcome', { body: JSON.stringify({ appId: person.appId, outcomes }, null, 2), contentType: 'application/json' })
  }
})

test('calendar_create persists the requested event only after authenticated successful transport and preserves independent events', mailAcceptance('calendar-create'), async ({ mailBackend, acceptanceApp, model, window }, info) => {
  const person = await prepareMailPerson(window, acceptanceApp.profile, mailBackend)
  const controlUid = randomUUID()
  const ownControl = seedCalendarEvent(controlUid, mailBackend.accounts.primary.user, 'Preserved calendar control')
  const otherControl = seedCalendarEvent(controlUid, mailBackend.accounts.control.user, 'Other account calendar control')
  mailBackend.calendar.seedEvent('primary', controlUid, ownControl)
  mailBackend.calendar.seedEvent('control', controlUid, otherControl)
  const histories: Array<Awaited<ReturnType<typeof performMailTool>>> = []
  const outcomes: Array<Record<string, unknown>> = []
  try {
    for (const phase of ['success', 'auth', 'transport', 'recovery'] as const) {
      mailBackend.calendar.setFailure(phase === 'auth' || phase === 'transport' ? phase : 'none')
      const before = mailBackend.calendar.readEvents('primary')
      const requestStart = mailBackend.calendar.requests.length
      const input = { summary: `Review, preserve; 中文 ${randomUUID()}`, start: '2030-04-05 09:30', end: '2030-04-05 10:00', description: 'First line\nSecond line with \\ marker', location: 'Owned test room', attendees: mailRecipients.slice(0, 2), reminder_minutes: 0 }
      const result = await performMailTool(window, model, person, 'calendar_create', input)
      histories.push(result)
      const receipts = mailBackend.calendar.requests.slice(requestStart)
      expect(receipts).toHaveLength(1)
      const after = mailBackend.calendar.readEvents('primary')
      if (phase === 'auth' || phase === 'transport') {
        assertFailedTool(result, new RegExp(`Failed to create calendar event:.*HTTP ${phase === 'auth' ? 401 : 503}`, 's'))
        expect(receipts[0]).toMatchObject({ method: 'PUT', account: 'primary', status: phase === 'auth' ? 401 : 503, authorized: phase !== 'auth' })
        expect(after).toEqual(before)
      } else {
        expect(result.tool.toolResult?.isError).toBe(false)
        const returned = JSON.parse(result.text) as { success: boolean; uid: string }
        expect(returned).toMatchObject({ success: true, summary: input.summary, start: input.start, end: input.end })
        expect(returned.uid).not.toBe(controlUid)
        expect(receipts[0]).toMatchObject({ method: 'PUT', account: 'primary', uid: returned.uid, authorized: true, status: 201 })
        const added = after.filter(event => !before.some(old => old.uid === event.uid))
        expect(added).toHaveLength(1)
        expect(added[0].uid).toBe(returned.uid)
        expect(parseFixtureCalendar(added[0].bytes)).toEqual({ uid: returned.uid, summary: input.summary,
          start: { parameters: 'TZID=Asia/Shanghai', value: '20300405T093000' }, end: { parameters: 'TZID=Asia/Shanghai', value: '20300405T100000' },
          description: input.description, location: input.location, organizer: `mailto:${mailBackend.accounts.primary.user}`, attendees: input.attendees.map(address => `mailto:${address}`) })
        expect(after.filter(event => before.some(old => old.uid === event.uid))).toEqual(before)
      }
      expect(mailBackend.calendar.readEvents('control')).toEqual([{ uid: controlUid, bytes: otherControl }])
      expect(after.find(event => event.uid === controlUid)?.bytes).toEqual(ownControl)
      expect(mailBackend.smtp.readMessages()).toEqual([])
      outcomes.push({ phase, eventIds: after.map(event => event.uid), receipts, toolError: result.tool.toolResult?.isError })
    }
    const stored = mailBackend.calendar.readEvents('primary')
    expect(stored).toHaveLength(3)
    const reopened = await acceptanceApp.restart()
    await assertMailHistory(reopened, person, histories)
    expect(mailBackend.calendar.readEvents('primary')).toEqual(stored)
    expect(mailBackend.calendar.readEvents('control')).toEqual([{ uid: controlUid, bytes: otherControl }])
    expect(model.exchanges).toHaveLength(8)
  } finally {
    mailBackend.calendar.setFailure('none')
    await info.attach('calendar-create-outcome', { body: JSON.stringify({ appId: person.appId, controlUid, outcomes }, null, 2), contentType: 'application/json' })
  }
})

test('calendar_delete refuses failed transport without removing records and recovery deletes only the requested account UID', mailAcceptance('calendar-delete'), async ({ mailBackend, acceptanceApp, model, window }, info) => {
  const person = await prepareMailPerson(window, acceptanceApp.profile, mailBackend)
  const targetUid = randomUUID(), controlUid = randomUUID()
  const target = seedCalendarEvent(targetUid, mailBackend.accounts.primary.user, 'Selected owned event')
  const ownControl = seedCalendarEvent(controlUid, mailBackend.accounts.primary.user, 'Preserved own event')
  const otherControl = seedCalendarEvent(targetUid, mailBackend.accounts.control.user, 'Same UID in another owned account')
  mailBackend.calendar.seedEvent('primary', targetUid, target)
  mailBackend.calendar.seedEvent('primary', controlUid, ownControl)
  mailBackend.calendar.seedEvent('control', targetUid, otherControl)
  const initial = mailBackend.calendar.readEvents('primary')
  const histories: Array<Awaited<ReturnType<typeof performMailTool>>> = []
  const outcomes: Array<Record<string, unknown>> = []
  try {
    for (const phase of ['auth', 'transport', 'recovery'] as const) {
      mailBackend.calendar.setFailure(phase === 'recovery' ? 'none' : phase)
      const requestStart = mailBackend.calendar.requests.length
      const result = await performMailTool(window, model, person, 'calendar_delete', { uid: targetUid })
      histories.push(result)
      const receipts = mailBackend.calendar.requests.slice(requestStart)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({ method: 'DELETE', account: 'primary', uid: targetUid, status: phase === 'auth' ? 401 : phase === 'transport' ? 503 : 204, authorized: phase !== 'auth' })
      if (phase !== 'recovery') {
        assertFailedTool(result, new RegExp(`Failed to delete calendar event:.*HTTP ${phase === 'auth' ? 401 : 503}`, 's'))
        expect(mailBackend.calendar.readEvents('primary')).toEqual(initial)
      } else {
        expect(result.tool.toolResult?.isError).toBe(false)
        expect(JSON.parse(result.text)).toEqual({ success: true, deleted_uid: targetUid })
        expect(mailBackend.calendar.readEvents('primary')).toEqual([{ uid: controlUid, bytes: ownControl }])
      }
      expect(mailBackend.calendar.readEvents('control')).toEqual([{ uid: targetUid, bytes: otherControl }])
      expect(mailBackend.smtp.readMessages()).toEqual([])
      outcomes.push({ phase, receipts, remaining: mailBackend.calendar.readEvents('primary').map(event => event.uid), toolError: result.tool.toolResult?.isError })
    }
    const reopened = await acceptanceApp.restart()
    await assertMailHistory(reopened, person, histories)
    expect(mailBackend.calendar.readEvents('primary')).toEqual([{ uid: controlUid, bytes: ownControl }])
    expect(mailBackend.calendar.readEvents('control')).toEqual([{ uid: targetUid, bytes: otherControl }])
    expect(model.exchanges).toHaveLength(6)
  } finally {
    mailBackend.calendar.setFailure('none')
    await info.attach('calendar-delete-outcome', { body: JSON.stringify({ appId: person.appId, targetUid, controlUid, outcomes }, null, 2), contentType: 'application/json' })
  }
})
