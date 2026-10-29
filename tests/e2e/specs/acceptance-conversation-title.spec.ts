import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import {
  test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle,
} from '../fixtures/acceptance-app'
import {
  conversationRow, listManagedConversations, openManagedConversation, seedManagedConversation,
} from '../fixtures/acceptance-management'
import { navigateToChat, navigateToSettings } from '../fixtures/helpers'

test.setTimeout(90000)

interface TitleConversation {
  id: string
  title: string
  titleCustomized?: boolean
  messages: Array<{ id: string; role: string; content: string }>
}

async function readConversation(page: Page, id: string): Promise<TitleConversation> {
  return page.evaluate(async id => {
    const result = await (globalThis as unknown as { halo: HaloAPI }).halo.getConversation('halo-temp', id)
    if (!result.success || !result.data) throw new Error('The titled conversation must remain readable')
    return result.data as TitleConversation
  }, id)
}

test('a first-question title stays current in the list and header after visiting settings and restarting', acceptance('conversations.organize.auto-title'), async ({ acceptanceApp, model, window }, info) => {
  const question = `Topic ${randomUUID().slice(0, 8)}`
  const answer = 'The short first question now names this conversation.'
  model.respond(() => ({ text: answer }))
  const directory = join(acceptanceApp.profile, '.halo', 'temp', 'conversations')
  const evidence: Array<Record<string, unknown>> = []
  const recordIndex = (phase: string, id: string) => {
    const path = join(directory, 'index.json')
    const index = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as { conversations: Array<{ id: string; title: string }> } : null
    const indexedTitle = index?.conversations.find(item => item.id === id)?.title ?? null
    evidence.push({ phase, at: new Date().toISOString(), conversationId: id, indexedTitle, indexMatchesQuestion: indexedTitle === question })
  }

  try {
    await navigateToChat(window)
    const control = await seedManagedConversation(window, 'halo-temp', 'Unchanged title control', [
      { role: 'user', content: 'Retain this independent question.' },
      { role: 'assistant', content: 'Retain this independent answer.' },
    ])
    const controlFile = join(directory, `${control.id}.json`)
    const controlBytes = readFileSync(controlFile, 'utf8')
    const existing = new Set((await listManagedConversations(window)).map(conversation => conversation.id))
    const create = window.getByRole('button', { name: 'New', exact: true })
    await expect(create).toHaveCount(1)
    await create.click()
    await expect(window.locator('textarea').first()).toHaveValue('')
    await expect(window.locator('.message-user')).toHaveCount(0)
    await expect.poll(async () => (await listManagedConversations(window)).filter(conversation => !existing.has(conversation.id)).length).toBe(1)
    const created = (await listManagedConversations(window)).find(conversation => !existing.has(conversation.id))!
    const blank = await readConversation(window, created.id)
    expect(blank.messages).toEqual([])
    expect(blank.titleCustomized).not.toBe(true)

    const turn = await sendAcceptanceMessage(window, question)
    expect(turn).toMatchObject({ spaceId: 'halo-temp', conversationId: created.id })
    await expect(window.locator('.message-assistant').last()).toContainText(answer)
    await waitForAcceptanceIdle(window, turn.conversationId)
    recordIndex('before-settings', turn.conversationId)
    await navigateToSettings(window)
    await navigateToChat(window)
    recordIndex('after-return', turn.conversationId)

    const saved = await readConversation(window, turn.conversationId)
    const body = JSON.parse(readFileSync(join(directory, `${turn.conversationId}.json`), 'utf8')) as TitleConversation
    const listed = (await listManagedConversations(window)).find(conversation => conversation.id === turn.conversationId)
    evidence.push({ phase: 'returned-values', conversationId: turn.conversationId, storedTitle: body.title, readTitle: saved.title, listedTitle: listed?.title })
    expect(saved).toMatchObject({ id: created.id, title: question })
    expect(saved.titleCustomized).not.toBe(true)
    expect(body).toMatchObject({ id: created.id, title: question })
    expect(listed).toMatchObject({ id: created.id, title: question })
    expect(saved.messages).toEqual([
      expect.objectContaining({ role: 'user', content: question }),
      expect.objectContaining({ role: 'assistant', content: answer }),
    ])
    await expect(conversationRow(window, question)).toHaveCount(1)
    await expect(window.getByRole('banner').getByText(question, { exact: true })).toBeVisible()
    await expect(window.locator(`[data-message-id="${saved.messages[0].id}"]`).first()).toContainText(question)
    await expect(window.locator(`[data-message-id="${saved.messages[1].id}"]`).first()).toContainText(answer)
    expect(await readConversation(window, control.id)).toEqual(control)
    expect(readFileSync(controlFile, 'utf8')).toBe(controlBytes)
    expect((await listManagedConversations(window)).find(conversation => conversation.id === control.id)?.title).toBe(control.title)
    expect(model.exchanges).toHaveLength(1)
    expect(model.exchanges[0].request.lastUserText).toContain(question)

    const reopened = await acceptanceApp.restart()
    await openManagedConversation(reopened, question)
    const restored = await readConversation(reopened, turn.conversationId)
    expect(restored.title).toBe(question)
    expect(restored.messages).toEqual(saved.messages)
    expect((await listManagedConversations(reopened)).find(conversation => conversation.id === turn.conversationId)?.title).toBe(question)
    await expect(conversationRow(reopened, question)).toHaveCount(1)
    await expect(reopened.getByRole('banner').getByText(question, { exact: true })).toBeVisible()
    await expect(reopened.locator(`[data-message-id="${saved.messages[0].id}"]`).first()).toContainText(question)
    await expect(reopened.locator(`[data-message-id="${saved.messages[1].id}"]`).first()).toContainText(answer)
    expect(await readConversation(reopened, control.id)).toEqual(control)
    expect(readFileSync(controlFile, 'utf8')).toBe(controlBytes)
    expect(model.exchanges).toHaveLength(1)
    recordIndex('after-restart', turn.conversationId)
  } finally {
    await info.attach('conversation-title-index-observations', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
  }
})
