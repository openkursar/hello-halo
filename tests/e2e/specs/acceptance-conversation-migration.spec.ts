import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { TranscriptMessage } from '../../../src/shared/types/transcript'
import { test, expect, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { openManagedConversation, seedManagedConversation, seedManagedSpace } from '../fixtures/acceptance-management'
import { conversationFileIdentity, installLegacyConversation, legacyConversationFixture, legacyConversationIdentity } from '../fixtures/acceptance-conversation-migration'

test.setTimeout(120000)

type HistoricalInput = ReturnType<typeof installLegacyConversation>

function withoutThoughts(message: TranscriptMessage) {
  const { thoughts: _thoughts, thoughtsSummary: _summary, ...stored } = message
  return stored
}

async function inspectHistory(page: Page, historical: HistoricalInput) {
  const { legacy, main, thoughts } = historical
  const response = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.getConversation(input.spaceId, input.id), { spaceId: legacy.spaceId, id: legacy.id })
  expect(response.success).toBe(true)
  const readable = response.data as { id: string; spaceId: string; title: string; messages: TranscriptMessage[] }
  const stored = JSON.parse(readFileSync(main, 'utf8'))
  expect(stored).toMatchObject({ version: 2, id: legacy.id, spaceId: legacy.spaceId, title: legacy.title, createdAt: legacy.createdAt })
  expect(stored.messages.slice(0, legacy.messages.length).map(withoutThoughts)).toEqual(legacy.messages.map(withoutThoughts))
  expect(readable).toMatchObject({ id: legacy.id, spaceId: legacy.spaceId, title: legacy.title })
  const expectedThoughts = legacy.messages[1].thoughts!
  expect(stored.messages[1]).toMatchObject({ thoughts: null, thoughtsSummary: { count: 4, types: { thinking: 1, tool_use: 1, tool_result: 1, result: 1 }, duration: 3 } })
  const sidecar = JSON.parse(readFileSync(thoughts, 'utf8'))
  expect(sidecar).toMatchObject({ version: 1, conversationId: legacy.id })
  expect(sidecar.messages[legacy.messages[1].id]).toEqual(expectedThoughts)
  for (const message of legacy.messages) {
    const actual = readable.messages.find(value => value.id === message.id)!
    expect(actual, `The original message ${message.id} must remain readable`).toBeDefined()
    const images = actual.images?.map(image => {
      expect(image.url, 'The desktop must materialize the historical image through its real image reader').toMatch(/^halo-file:\/\//)
      const path = fileURLToPath(new URL(image.url!.replace(/^halo-file:/, 'file:')))
      const within = relative(realpathSync(main.slice(0, -'.json'.length) + '.images'), realpathSync(path))
      expect(!within || isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)).toBe(false)
      const { url: _url, ...metadata } = image
      return { ...metadata, data: readFileSync(path).toString('base64') }
    })
    expect(withoutThoughts({ ...actual, ...(images ? { images } : {}) })).toEqual(withoutThoughts(message))
    const detail = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.getMessageThoughts(input.spaceId, input.id, input.messageId), { spaceId: legacy.spaceId, id: legacy.id, messageId: message.id })
    expect(detail.success).toBe(true)
    expect(detail.data).toEqual(message.thoughts ?? [])
  }
  return { readable, stored, sidecar }
}

test('unversioned conversation messages and inline thoughts migrate intact and accept a new persisted turn', {
  annotation: { type: 'acceptance', description: JSON.stringify({ caseId: 'lifecycle.install.migrate', evidence: 'integration', mode: 'scripted', variant: { dataset: 'conversation-v1' } }) },
}, async ({ acceptanceApp, model, window }, info) => {
  const space = await seedManagedSpace(window, 'Conversation migration workspace')
  const template = legacyConversationFixture('template-space', 'template-conversation')
  const target = await seedManagedConversation(window, space.id, template.title, [])
  const control = await seedManagedConversation(window, space.id, 'Unchanged conversation control', [
    { role: 'user', content: 'Keep this independent control question.' },
    { role: 'assistant', content: 'Keep this independent control answer.' },
  ])
  const controlPath = join(space.path, '.halo', 'conversations', `${control.id}.json`)
  const child = acceptanceApp.app.process()
  let historical!: HistoricalInput
  let controlIdentity!: ReturnType<typeof conversationFileIdentity>
  let page = await acceptanceApp.restart(profile => {
    historical = installLegacyConversation(profile, child, space.path, space.id, target.id)
    controlIdentity = conversationFileIdentity(controlPath)
  })
  const observations: Record<string, unknown> = { fixture: legacyConversationIdentity(), historical: historical.legacy }
  const question = 'Add a new answer to the migrated archive: birch-461.'
  const answer = 'The new archive entry retains reference birch-461.'
  const received: boolean[] = []
  model.respond(request => {
    received.push(request.lastUserText.includes(question))
    return { text: answer }
  })
  try {
    const migrated = await inspectHistory(page, historical)
    expect(migrated.stored.messages).toHaveLength(historical.legacy.messages.length)
    expect(migrated.stored).toMatchObject({ updatedAt: historical.legacy.updatedAt, messageCount: historical.legacy.messageCount, preview: historical.legacy.preview })
    expect(Object.keys(migrated.sidecar.messages)).toEqual([historical.legacy.messages[1].id])
    observations.migrated = migrated
    const firstMain = conversationFileIdentity(historical.main)
    const firstThoughts = conversationFileIdentity(historical.thoughts)
    await inspectHistory(page, historical)
    expect(conversationFileIdentity(historical.main)).toEqual(firstMain)
    expect(conversationFileIdentity(historical.thoughts)).toEqual(firstThoughts)
    expect(conversationFileIdentity(controlPath)).toEqual(controlIdentity)

    await openManagedConversation(page, historical.legacy.title, space.id)
    const turn = await sendAcceptanceMessage(page, question)
    expect(turn).toMatchObject({ spaceId: space.id, conversationId: target.id })
    await expect(page.locator('.message-assistant').last()).toContainText(answer)
    await waitForAcceptanceIdle(page, target.id)
    expect(received).toEqual([true])
    const extended = await inspectHistory(page, historical)
    expect(extended.stored.messages.slice(0, historical.legacy.messages.length)).toEqual(migrated.stored.messages)
    const added = extended.stored.messages.slice(historical.legacy.messages.length) as TranscriptMessage[]
    expect(added.map(message => ({ role: message.role, content: message.content }))).toEqual([{ role: 'user', content: question }, { role: 'assistant', content: answer }])
    expect(new Set(extended.stored.messages.map((message: TranscriptMessage) => message.id)).size).toBe(extended.stored.messages.length)
    expect(conversationFileIdentity(controlPath)).toEqual(controlIdentity)
    observations.extended = extended
    const mainBeforeRestart = conversationFileIdentity(historical.main)
    const thoughtsBeforeRestart = conversationFileIdentity(historical.thoughts)

    page = await acceptanceApp.restart()
    const reopened = await inspectHistory(page, historical)
    expect(reopened.stored).toEqual(extended.stored)
    expect(reopened.sidecar).toEqual(extended.sidecar)
    expect(conversationFileIdentity(historical.main)).toEqual(mainBeforeRestart)
    expect(conversationFileIdentity(historical.thoughts)).toEqual(thoughtsBeforeRestart)
    expect(conversationFileIdentity(controlPath)).toEqual(controlIdentity)
    expect(model.exchanges).toHaveLength(1)
    observations.idempotent = { mainBeforeRestart, thoughtsBeforeRestart, controlIdentity }
  } finally {
    await info.attach('conversation-v1-migration-evidence', { body: JSON.stringify({ ...observations, received }, null, 2), contentType: 'application/json' })
  }
})
