import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { InstalledApp } from '../../../src/shared/apps/app-types'
import type { Thought, TranscriptMessage } from '../../../src/shared/types/transcript'
import { test as base, expect } from './acceptance-app'
import type { AcceptanceModel, ModelRequest } from './acceptance-model'
import { seedManagedSpace } from './acceptance-management'
import { startAcceptanceSmtp } from './acceptance-mail-smtp'
import { startAcceptanceCalDav } from './acceptance-mail-caldav'

export const mailRecipients = ['recipient@acceptance.test', 'copy@acceptance.test', 'hidden@acceptance.test', 'control@acceptance.test']

async function startMailBackend() {
  const directory = await mkdtemp(join(tmpdir(), 'acceptance-mail-backend-'))
  const accounts = {
    primary: { user: 'owner@acceptance.test', password: `local-only-${randomBytes(24).toString('hex')}` },
    control: { user: 'control@acceptance.test', password: `local-only-${randomBytes(24).toString('hex')}` },
  }
  let smtp: Awaited<ReturnType<typeof startAcceptanceSmtp>> | undefined
  let calendar: Awaited<ReturnType<typeof startAcceptanceCalDav>> | undefined
  try {
    smtp = await startAcceptanceSmtp({ directory, accounts, recipients: mailRecipients })
    calendar = await startAcceptanceCalDav({ directory, accounts, recipients: mailRecipients })
    return { directory, accounts, smtp, calendar }
  } catch (error) {
    const closed = await Promise.allSettled([smtp?.close(), calendar?.close()])
    if (closed.some(result => result.status === 'rejected')) throw new AggregateError([error, ...closed.filter(result => result.status === 'rejected').map(result => result.reason)], 'Mail fixture startup and cleanup failed; owned files retained')
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export type MailBackend = Awaited<ReturnType<typeof startMailBackend>>

export const test = base.extend<{ mailBackend: MailBackend }>({
  mailBackend: [async ({}, use, info) => {
    const backend = await startMailBackend()
    try { await use(backend) }
    finally {
      const closed = await Promise.allSettled([backend.smtp.close(), backend.calendar.close()])
      await info.attach('mail-protocol-receipts', { body: JSON.stringify({ smtp: backend.smtp.receipts, calendar: backend.calendar.requests, smtpErrors: backend.smtp.errors, calendarErrors: backend.calendar.errors }, null, 2), contentType: 'application/json' })
      if (closed.some(result => result.status === 'rejected')) throw new AggregateError(closed.filter(result => result.status === 'rejected').map(result => result.reason), 'Mail fixture cleanup failed; owned files retained')
      await rm(backend.directory, { recursive: true, force: true })
      expect(backend.smtp.errors).toEqual([])
      expect(backend.calendar.errors).toEqual([])
    }
  }, { auto: true }],
})

export function mailAcceptance(operation: 'send' | 'calendar-create' | 'calendar-delete') {
  return { annotation: { type: 'acceptance', description: JSON.stringify({ caseId: 'assistant-tools.mail.write', evidence: 'integration', mode: 'scripted', variant: { operation } }) } }
}

export async function prepareMailPerson(page: Page, profile: string, backend: MailBackend) {
  const configured = await page.evaluate(async email => {
    const api = (window as unknown as { halo: HaloAPI }).halo
    return api.setConfig({ notificationChannels: { email } })
  }, { enabled: true, smtp: { host: '127.0.0.1', port: backend.smtp.port, secure: false, user: backend.accounts.primary.user, password: backend.accounts.primary.password }, defaultTo: mailRecipients[0], caldavUrl: backend.calendar.url('primary') })
  expect(configured.success).toBe(true)
  await expect.poll(() => page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.appList({ type: 'automation' }).then(response => response.success)), { timeout: 30000 }).toBe(true)
  const directory = join(profile, 'mail working files')
  mkdirSync(directory)
  const space = await seedManagedSpace(page, 'Isolated mail workspace', directory)
  expect(space.workingDir).toBe(directory)
  const installed = await page.evaluate(spaceId => (window as unknown as { halo: HaloAPI }).halo.appInstall({
    spaceId,
    spec: { spec_version: '1.0', type: 'automation', version: '1.0.0', name: 'Isolated mail operator', author: 'Acceptance author',
      description: 'Uses only the supplied synthetic mailbox and calendar.', system_prompt: 'Use only the configured isolated email and calendar account, requested owned files, and explicitly requested fixture recipients.',
      subscriptions: [], requires: {}, config_schema: [], permissions: ['email'] },
  }), space.id)
  expect(installed.success).toBe(true)
  const appId = (installed.data as { appId: string }).appId
  const updated = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appUpdateOverrides({ appId, overrides: { notificationLevel: 'none', memory: { enabled: false, autoConsolidate: false } } }), appId)
  expect(updated.success).toBe(true)
  const person = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appGet(appId), appId)
  expect(person.success).toBe(true)
  expect((person.data as InstalledApp).permissions.denied).not.toContain('email')
  const owned = relative(realpathSync(profile), realpathSync(directory))
  expect(owned && !isAbsolute(owned) && owned !== '..' && !owned.startsWith(`..${sep}`)).toBeTruthy()
  return { appId, spaceId: space.id, directory }
}

export type MailPerson = Awaited<ReturnType<typeof prepareMailPerson>>

export async function readMailChat(page: Page, person: MailPerson, conversationId: string) {
  const response = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appChatTranscript(input), { appId: person.appId, spaceId: person.spaceId, conversationId, limit: 200 })
  expect(response.success).toBe(true)
  expect(response.data?.hasMoreBefore).toBe(false)
  return response.data!.messages
}

export async function performMailTool(page: Page, model: AcceptanceModel, person: MailPerson, name: string, input: Record<string, unknown>) {
  const id = `mail-${randomUUID()}`
  const question = `I authorize this isolated ${name} operation on the synthetic test account only: ${JSON.stringify(input)}. Reference ${id}.`
  const answer = `The local tool response has been recorded: ${id}.`
  const requests: ModelRequest[] = []
  const missing: number[] = []
  let text: string | undefined
  model.respond(request => {
    requests.push(request)
    const result = request.toolResults.find(result => result.id === id)
    if (result) { text = result.text; return { text: answer } }
    const names = request.tools.filter(tool => tool === name || tool.endsWith(`__${name}`))
    if (names.length !== 1) { missing.push(names.length); return { text: 'The requested mail capability was unavailable.' } }
    return { tools: [{ id, name: names[0], input }] }
  })
  const created = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appSessionCreate({ appId }), person.appId)
  expect(created.success).toBe(true)
  const conversationId = created.data!.conversationId
  const sent = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appChatSend(input), { appId: person.appId, spaceId: person.spaceId, conversationId, message: question })
  expect(sent.success).toBe(true)
  await expect.poll(() => text, { timeout: 45000, message: 'The actual email/calendar tool must return a result to the local model' }).not.toBeUndefined()
  await expect.poll(async () => {
    const response = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appChatSessionState(input.appId, input.conversationId), { appId: person.appId, conversationId })
    expect(response.success).toBe(true)
    return (response.data as { isActive: boolean }).isActive
  }, { timeout: 30000 }).toBe(false)
  expect(missing).toEqual([])
  expect(requests).toHaveLength(2)
  expect(requests[0].lastUserText).toContain(question)
  const messages = await readMailChat(page, person, conversationId)
  expect(messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([question])
  expect(messages.some(message => message.role === 'assistant' && message.content === answer)).toBe(true)
  const thoughts: Thought[] = []
  for (const message of messages.filter(message => message.role === 'assistant')) {
    const response = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appChatMessageThoughts(input), { appId: person.appId, spaceId: person.spaceId, conversationId, messageId: message.id })
    expect(response.success).toBe(true)
    thoughts.push(...response.data!)
  }
  const tools = thoughts.filter(thought => thought.type === 'tool_use' && (thought.toolName === name || thought.toolName?.endsWith(`__${name}`)))
  expect(tools).toHaveLength(1)
  expect(tools[0].toolInput).toMatchObject(input)
  expect(tools[0].toolResult).toBeDefined()
  return { conversationId, messages, tool: tools[0], text: text!, requestCount: requests.length }
}

export async function assertMailHistory(page: Page, person: MailPerson, histories: Array<{ conversationId: string; messages: TranscriptMessage[] }>) {
  for (const history of histories) expect(await readMailChat(page, person, history.conversationId)).toEqual(history.messages)
}

export { expect } from '@playwright/test'
