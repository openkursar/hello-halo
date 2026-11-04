import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { shortConversationId } from '../../../src/shared/conversation-reference'
import {
  test, expect, acceptance, readAcceptanceConversation, sendAcceptanceMessage, waitForAcceptanceIdle,
} from '../fixtures/acceptance-app'
import { openManagedConversation, seedManagedConversation, type ManagedConversation } from '../fixtures/acceptance-management'
import { navigateToChat } from '../fixtures/helpers'
import { clickArtifactByName } from '../../perf/lib/open-artifact'

test.setTimeout(150000)

const SPACE = 'halo-temp'
const UNAVAILABLE = 'This conversation is no longer available'

interface Handoff { via: string; target: string }

/**
 * Replaces every Electron entry point through which a link can leave Halo with a
 * recorder, so a stray hand-off is observable and never reaches the host.
 */
async function observeExternalHandoffs(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow, shell, dialog }) => {
    const handoffs: Handoff[] = []
    ;(globalThis as unknown as { acceptanceHandoffs: Handoff[] }).acceptanceHandoffs = handoffs
    const record = (via: string, target: unknown) => { handoffs.push({ via, target: typeof target === 'string' ? target : JSON.stringify(target) }) }
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.on('will-navigate', (_event, url) => { if (/^conv:/i.test(url)) record('will-navigate', url) })
    }
    shell.openExternal = async (url: string) => { record('shell.openExternal', url) }
    shell.openPath = async (path: string) => { record('shell.openPath', path); return '' }
    shell.showItemInFolder = (path: string) => { record('shell.showItemInFolder', path) }
    dialog.showMessageBox = (async (...args: unknown[]) => {
      record('dialog.showMessageBox', (args.at(-1) as { detail?: string })?.detail ?? '')
      return { response: 1, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
    dialog.showMessageBoxSync = ((...args: unknown[]) => {
      record('dialog.showMessageBoxSync', (args.at(-1) as { detail?: string })?.detail ?? '')
      return 1
    }) as typeof dialog.showMessageBoxSync
  })
}

function readHandoffs(app: ElectronApplication): Promise<Handoff[]> {
  return app.evaluate(() => (globalThis as unknown as { acceptanceHandoffs: Handoff[] }).acceptanceHandoffs)
}

/** The recorder must sit on the path the app really uses, or an empty record proves nothing. */
async function confirmObserverSeesExternalOpens(app: ElectronApplication, window: Page) {
  const control = `https://example.invalid/acceptance-control-${randomUUID()}`
  const before = (await readHandoffs(app)).length
  await window.evaluate(url => (globalThis as unknown as { halo: HaloAPI }).halo.openExternal(url), control)
  expect((await readHandoffs(app)).slice(before)).toEqual([{ via: 'shell.openExternal', target: control }])
}

async function seedTargets(window: Page, token: string) {
  const short = await seedManagedConversation(window, SPACE, `Short link target ${token}`, [
    { role: 'user', content: `Short target question ${token}` },
    { role: 'assistant', content: `Short target answer ${token}` },
  ])
  const full = await seedManagedConversation(window, SPACE, `Full link target ${token}`, [
    { role: 'user', content: `Full target question ${token}` },
    { role: 'assistant', content: `Full target answer ${token}` },
  ])
  const missing = randomUUID()
  expect([short.id, full.id]).not.toContain(missing)
  expect(shortConversationId(short.id)).toMatch(/^[0-9a-f]{8}$/)
  expect(shortConversationId(full.id)).not.toBe(shortConversationId(short.id))
  const markdown = [
    `[Short ${token}](conv:${shortConversationId(short.id)})`,
    `[Full ${token}](conv:${full.id})`,
    `[Missing ${token}](conv:${missing})`,
    `[Malformed ${token}](conv:not-a-conversation)`,
  ].join('\n\n')
  return { short, full, missing, markdown }
}

async function expectConversationShown(window: Page, conversation: ManagedConversation) {
  await expect(window.getByRole('banner').getByText(conversation.title, { exact: true })).toBeVisible()
  for (const message of conversation.messages) {
    await expect(window.locator(`[data-message-id="${message.id}"]`).first()).toContainText(message.content)
  }
}

async function expectUnavailable(window: Page, link: Locator, stayOn: () => Promise<void>) {
  // The notice reuses one id, so a previous link's notice must expire before this one counts.
  await expect(window.getByText(UNAVAILABLE, { exact: true })).toHaveCount(0, { timeout: 10000 })
  await link.click()
  await expect(window.getByText(UNAVAILABLE, { exact: true }).first()).toBeVisible()
  await stayOn()
}

test('conv links in an AI reply open the short- and full-id conversations and report a missing one in the app', acceptance('references.conversation.open', { surface: 'reply' }), async ({ acceptanceApp, model, window }, info) => {
  const token = randomUUID().slice(0, 8)
  await navigateToChat(window)
  const targets = await seedTargets(window, token)
  await observeExternalHandoffs(acceptanceApp.app)
  const question = `Point me at the related conversations ${token}`
  model.respond(request => {
    if (request.lastUserText.includes(question)) return { text: `Related conversations:\n\n${targets.markdown}` }
    throw new Error(`Unexpected conversation-link request ${request.sequence}`)
  })

  const turn = await sendAcceptanceMessage(window, question)
  expect([targets.short.id, targets.full.id]).not.toContain(turn.conversationId)
  await expect(window.locator('.message-assistant').last()).toContainText(`Short ${token}`)
  await waitForAcceptanceIdle(window, turn.conversationId)
  const source = await readAcceptanceConversation(window, turn.spaceId, turn.conversationId)
  const reply = () => window.locator('.message-assistant').last()
  const backToSource = async () => {
    await openManagedConversation(window, source.title, turn.spaceId)
    await expect(reply()).toContainText(`Short ${token}`)
  }
  const sourceStillShown = async () => {
    await expect(window.getByRole('banner').getByText(source.title, { exact: true })).toBeVisible()
    await expect(window.locator('.message-user').filter({ hasText: question })).toHaveCount(1)
  }

  await reply().getByText(`Short ${token}`, { exact: true }).click()
  await expectConversationShown(window, targets.short)
  await expect(window.locator('.message-user').filter({ hasText: question })).toHaveCount(0)

  await backToSource()
  await reply().getByText(`Full ${token}`, { exact: true }).click()
  await expectConversationShown(window, targets.full)
  await expect(window.locator('.message-user').filter({ hasText: question })).toHaveCount(0)

  await backToSource()
  await expectUnavailable(window, reply().getByText(`Missing ${token}`, { exact: true }), sourceStillShown)
  await expectUnavailable(window, reply().getByText(`Malformed ${token}`, { exact: true }), sourceStillShown)

  const handoffs = await readHandoffs(acceptanceApp.app)
  expect(handoffs).toEqual([])
  await confirmObserverSeesExternalOpens(acceptanceApp.app, window)
  expect(model.exchanges.filter(exchange => exchange.completed)).toHaveLength(1)
  await info.attach('conversation-links-reply', { body: JSON.stringify({ source: turn.conversationId, short: targets.short.id, full: targets.full.id, missing: targets.missing, handoffs }), contentType: 'application/json' })
})

test('conv links in a canvas Markdown preview open the short- and full-id conversations and report a missing one in the app', acceptance('references.conversation.open', { surface: 'preview' }), async ({ acceptanceApp, model, window }, info) => {
  const token = randomUUID().slice(0, 8)
  model.respond(request => { throw new Error(`The preview scenario sends no model request (${request.sequence})`) })
  await navigateToChat(window)
  const targets = await seedTargets(window, token)
  const name = `conversation-links-${token}.md`
  const directory = join(acceptanceApp.profile, '.halo', 'temp', 'artifacts')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, name), `# Conversation links ${token}\n\n${targets.markdown}\n`)
  // Seeded through the API after load; a reload lets the conversation list show them.
  await window.reload({ waitUntil: 'domcontentloaded' })
  await observeExternalHandoffs(acceptanceApp.app)

  const preview = () => window.locator('.prose').filter({ has: window.getByRole('heading', { name: `Conversation links ${token}`, exact: true }) })
  const openPreview = async () => {
    if (!await preview().isVisible().catch(() => false)) await clickArtifactByName(window, name)
    await expect(preview().getByText(`Short ${token}`, { exact: true })).toBeVisible()
  }

  await openManagedConversation(window, targets.full.title)
  await openPreview()
  await preview().getByText(`Short ${token}`, { exact: true }).click()
  await expectConversationShown(window, targets.short)
  await expect(window.locator(`[data-message-id="${targets.full.messages[0].id}"]`)).toHaveCount(0)

  await openPreview()
  await preview().getByText(`Full ${token}`, { exact: true }).click()
  await expectConversationShown(window, targets.full)
  await expect(window.locator(`[data-message-id="${targets.short.messages[0].id}"]`)).toHaveCount(0)

  const fullStillShown = async () => { await expectConversationShown(window, targets.full) }
  await openPreview()
  await expectUnavailable(window, preview().getByText(`Missing ${token}`, { exact: true }), fullStillShown)
  await openPreview()
  await expectUnavailable(window, preview().getByText(`Malformed ${token}`, { exact: true }), fullStillShown)

  const handoffs = await readHandoffs(acceptanceApp.app)
  expect(handoffs).toEqual([])
  await confirmObserverSeesExternalOpens(acceptanceApp.app, window)
  expect(model.exchanges).toHaveLength(0)
  await info.attach('conversation-links-preview', { body: JSON.stringify({ file: name, short: targets.short.id, full: targets.full.id, missing: targets.missing, handoffs }), contentType: 'application/json' })
})
