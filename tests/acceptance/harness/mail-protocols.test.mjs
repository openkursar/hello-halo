import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import nodemailer from 'nodemailer'
import { simpleParser } from 'mailparser'

const compiled = await mkdtemp(path.join(tmpdir(), 'acceptance-mail-protocols-'))
after(() => rm(compiled, { recursive: true, force: true }))
for (const name of ['smtp', 'caldav']) await build({ entryPoints: [fileURLToPath(new URL(`../../e2e/fixtures/acceptance-mail-${name}.ts`, import.meta.url))], outfile: path.join(compiled, `${name}.cjs`), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
const require = createRequire(import.meta.url)
const { startAcceptanceSmtp } = require(path.join(compiled, 'smtp.cjs'))
const { startAcceptanceCalDav, parseFixtureCalendar } = require(path.join(compiled, 'caldav.cjs'))
const recipients = ['to@acceptance.test', 'cc@acceptance.test', 'hidden@acceptance.test', 'control@acceptance.test']

async function fixture(context) {
  const directory = await mkdtemp(path.join(tmpdir(), 'acceptance-mail-wire-'))
  const accounts = { primary: { user: 'owner@acceptance.test', password: `local-only-${randomBytes(16).toString('hex')}` }, control: { user: 'control@acceptance.test', password: `local-only-${randomBytes(16).toString('hex')}` } }
  const smtp = await startAcceptanceSmtp({ directory, accounts, recipients })
  const calendar = await startAcceptanceCalDav({ directory, accounts, recipients })
  context.after(async () => { await Promise.all([smtp.close(), calendar.close()]); await rm(directory, { recursive: true, force: true }) })
  return { smtp, calendar, accounts }
}

test('actual SMTP authentication, envelope and MIME bytes reach the isolated disk store without relaying', async context => {
  const { smtp, accounts } = await fixture(context)
  const transport = nodemailer.createTransport({ host: '127.0.0.1', port: smtp.port, secure: false, auth: { user: accounts.primary.user, pass: accounts.primary.password } })
  const attachment = Buffer.from('Independent attachment bytes: 中文 87261345')
  const sent = await transport.sendMail({ from: accounts.primary.user, to: recipients[0], cc: recipients[1], bcc: recipients[2], subject: 'Synthetic subject 中文', text: 'Body before\n.line beginning with a dot', attachments: [{ filename: '附件.txt', content: attachment }] })
  const messages = smtp.readMessages()
  assert.equal(messages.length, 1)
  assert.equal(messages[0].account, 'primary')
  assert.equal(messages[0].from, accounts.primary.user)
  assert.deepEqual([...messages[0].to].sort(), recipients.slice(0, 3).sort())
  const parsed = await simpleParser(messages[0].raw)
  assert.equal(parsed.messageId, sent.messageId)
  assert.equal(parsed.subject, 'Synthetic subject 中文')
  assert.equal(parsed.text.trimEnd(), 'Body before\n.line beginning with a dot')
  assert.equal(parsed.attachments[0].filename, '附件.txt')
  assert.deepEqual(parsed.attachments[0].content, attachment)
  assert.equal(parsed.bcc, undefined)
  assert.deepEqual(smtp.errors, [])
  assert.equal(JSON.stringify(smtp.receipts).includes(accounts.primary.password), false)
})

test('SMTP auth refusal, temporary DATA refusal and an unowned recipient persist nothing, then a fresh send recovers', async context => {
  const { smtp, accounts } = await fixture(context)
  const send = (to = recipients[0]) => nodemailer.createTransport({ host: '127.0.0.1', port: smtp.port, secure: false, auth: { user: accounts.primary.user, pass: accounts.primary.password } }).sendMail({ from: accounts.primary.user, to, subject: 'Controlled failure', text: 'No delivery on failure' })
  smtp.setFailure('auth')
  await assert.rejects(send(), /535/)
  assert.deepEqual(smtp.readMessages(), [])
  smtp.setFailure('transport')
  await assert.rejects(send(), /451/)
  assert.deepEqual(smtp.readMessages(), [])
  smtp.setFailure('none')
  await assert.rejects(send('unowned@example.invalid'), /550/)
  assert.deepEqual(smtp.readMessages(), [])
  await send()
  assert.equal(smtp.readMessages().length, 1)
  assert.deepEqual(smtp.errors, [])
})

function event(uid, organizer, summary = 'Synthetic calendar event') {
  return Buffer.from(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTART;TZID=Asia/Shanghai:20300405T093000', 'DTEND;TZID=Asia/Shanghai:20300405T100000', `SUMMARY:${summary}`, `ORGANIZER:mailto:${organizer}`, 'ATTENDEE:mailto:to@acceptance.test', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'))
}

test('actual CalDAV requests preserve account scope, conditional writes and failed-operation bytes', async context => {
  const { calendar, accounts } = await fixture(context)
  const uid = randomUUID(), controlUid = randomUUID()
  const original = event(uid, accounts.primary.user)
  const control = event(controlUid, accounts.control.user, 'Other owned account')
  calendar.seedEvent('control', controlUid, control)
  const auth = account => ({ Authorization: 'Basic ' + Buffer.from(`${accounts[account].user}:${accounts[account].password}`).toString('base64') })
  const write = () => fetch(calendar.url('primary') + uid + '.ics', { method: 'PUT', headers: { ...auth('primary'), 'If-None-Match': '*', 'Content-Type': 'text/calendar' }, body: original })
  calendar.setFailure('auth')
  assert.equal((await write()).status, 401)
  calendar.setFailure('transport')
  assert.equal((await write()).status, 503)
  assert.deepEqual(calendar.readEvents('primary'), [])
  calendar.setFailure('none')
  assert.equal((await write()).status, 201)
  assert.deepEqual(calendar.readEvents('primary'), [{ uid, bytes: original }])
  assert.equal((await write()).status, 412)
  assert.equal((await fetch(calendar.url('control') + controlUid + '.ics', { method: 'DELETE', headers: auth('primary') })).status, 401)
  const report = await fetch(calendar.url('primary'), { method: 'REPORT', headers: auth('primary'), body: '<calendar-query/>' })
  assert.equal(report.status, 207)
  assert.ok((await report.text()).includes(uid))
  for (const failure of ['auth', 'transport']) {
    calendar.setFailure(failure)
    assert.equal((await fetch(calendar.url('primary') + uid + '.ics', { method: 'DELETE', headers: auth('primary') })).status, failure === 'auth' ? 401 : 503)
    assert.deepEqual(calendar.readEvents('primary'), [{ uid, bytes: original }])
  }
  calendar.setFailure('none')
  assert.equal((await fetch(calendar.url('primary') + uid + '.ics', { method: 'DELETE', headers: auth('primary') })).status, 204)
  assert.deepEqual(calendar.readEvents('primary'), [])
  assert.deepEqual(calendar.readEvents('control'), [{ uid: controlUid, bytes: control }])
  assert.deepEqual(calendar.errors, [])
  assert.equal(JSON.stringify(calendar.requests).includes(accounts.primary.password), false)
})

test('the independent calendar reader unfolds text and ignores timezone and alarm properties outside VEVENT', () => {
  const bytes = Buffer.from(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VTIMEZONE', 'DTSTART:19700101T000000', 'END:VTIMEZONE', 'BEGIN:VEVENT', 'UID:owned', 'DTSTART;TZID=Asia/Shanghai:20300405T093000', 'DTEND;TZID=Asia/Shanghai:20300405T100000', 'SUMMARY:Long\\, title\\; 中文', ' continuation', 'DESCRIPTION:first\\nsecond\\\\suffix', 'BEGIN:VALARM', 'DESCRIPTION:Alarm only', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'))
  const parsed = parseFixtureCalendar(bytes)
  assert.equal(parsed.summary, 'Long, title; 中文continuation')
  assert.equal(parsed.description, 'first\nsecond\\suffix')
  assert.deepEqual(parsed.start, { parameters: 'TZID=Asia/Shanghai', value: '20300405T093000' })
  assert.throws(() => parseFixtureCalendar(Buffer.from('not a calendar')), /one complete calendar event/)
})
