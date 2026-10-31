import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { buildLocalSessionKey } from '../../../src/shared/apps/im-keys'
import type { ModelRequest } from '../fixtures/acceptance-model'
import { test, expect, acceptance, readAcceptanceErrors, sendAcceptanceMessage } from '../fixtures/acceptance-app'
import {
  listManagedConversations, openManagedPerson, readManagedConversation, readManagedPerson, seedManagedSpace,
} from '../fixtures/acceptance-management'
import { navigateToChat, navigateToWorkspaces } from '../fixtures/helpers'

test.setTimeout(120000)

async function localSessions(page: Page, appId: string) {
  const result = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.imSessionsList(id), appId)
  expect(result.success).toBe(true)
  return (result.data as Array<{ appId: string; source: string; chatId: string }>).filter(record => record.appId === appId && record.source === 'local')
}

test('opening a person from an empty workspace and opening another chat keeps the requested recipient and distinct histories', acceptance('conversations.organize.person-new'), async ({ model, window }, info) => {
  const name = `Chat entry owner ${randomUUID().slice(0, 8)}`
  const requests: ModelRequest[] = []
  model.respond(request => {
    requests.push(request)
    return { text: `Independent person reply ${requests.length}.` }
  })
  await navigateToChat(window)
  const space = await seedManagedSpace(window, 'Empty person-chat workspace')
  const installed = await window.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appInstall({
    spaceId: input.spaceId,
    spec: {
      spec_version: '1.0', version: '1.0.0', type: 'automation', name: input.name,
      author: 'Acceptance author', description: 'An isolated conversation recipient.',
      system_prompt: 'Respond only to the supplied synthetic task.', subscriptions: [], requires: {}, config_schema: [], permissions: [],
    },
  }), { name, spaceId: space.id })
  expect(installed.success).toBe(true)
  const person = await readManagedPerson(window, (installed.data as { appId: string }).appId)
  await navigateToWorkspaces(window)
  await expect(window.getByRole('heading', { name: space.name, level: 3, exact: true })).toBeVisible()
  expect(await listManagedConversations(window, space.id)).toEqual([])
  expect(await localSessions(window, person.id)).toEqual([])
  const observations: Array<Record<string, unknown>> = []
  const histories: Array<{ conversationId: string; messages: unknown[] }> = []
  try {
    for (const stage of [1, 2]) {
      const before = new Set((await localSessions(window, person.id)).map(record => record.chatId))
      const ordinaryBefore = (await listManagedConversations(window, space.id)).map(conversation => conversation.id)
      await openManagedPerson(window, name)
      await window.getByTitle('Opens the conversation with this digital human in the workspace chat', { exact: true }).click()
      await expect.poll(async () => (await localSessions(window, person.id)).filter(record => !before.has(record.chatId)).length).toBe(1)
      const created = (await localSessions(window, person.id)).find(record => !before.has(record.chatId))!
      const conversationId = buildLocalSessionKey(person.id, created.chatId)
      observations.push({ stage, conversationId, ordinaryBefore, ordinaryAfter: (await listManagedConversations(window, space.id)).map(conversation => conversation.id) })
      await expect(window.getByTitle(`Current workspace: ${space.name} — click to switch`, { exact: true })).toBeVisible()
      await expect(window.getByTitle(`Chatting with ${name}`, { exact: true })).toBeVisible()
      await expect(window.locator('.message-user')).toHaveCount(0)
      await expect(window.locator('textarea').first()).toHaveValue('')
      const empty = await window.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appChatTranscript(input), { appId: person.id, spaceId: space.id, conversationId })
      expect(empty.success).toBe(true)
      expect(empty.data?.messages).toEqual([])
      const question = `Person chat ${stage}: ${randomUUID()}`
      const turn = await sendAcceptanceMessage(window, question)
      expect(turn).toMatchObject({ spaceId: space.id, conversationId })
      await expect(window.locator('.message-assistant [data-message-content]').last()).toHaveText(`Independent person reply ${stage}.`)
      await expect.poll(() => window.evaluate(async input => {
        const result = await (window as unknown as { halo: HaloAPI }).halo.appChatSessionState(input.appId, input.conversationId)
        if (!result.success || !result.data) throw new Error('The actual person conversation must remain readable')
        return (result.data as { isActive: boolean }).isActive
      }, { appId: person.id, conversationId })).toBe(false)
      expect(await readAcceptanceErrors(window)).toEqual([])
      expect(requests).toHaveLength(stage)
      expect(requests[stage - 1].lastUserText).toContain(question)
      const saved = await window.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appChatTranscript(input), { appId: person.id, spaceId: space.id, conversationId })
      expect(saved.success).toBe(true)
      expect(saved.data?.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([question])
      expect(saved.data?.messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual([`Independent person reply ${stage}.`])
      histories.push({ conversationId, messages: saved.data!.messages })
      for (const prior of histories) {
        const retained = await window.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appChatTranscript(input), { appId: person.id, spaceId: space.id, conversationId: prior.conversationId })
        expect(retained.data?.messages).toEqual(prior.messages)
      }
      for (const ordinary of await listManagedConversations(window, space.id)) {
        expect((await readManagedConversation(window, space.id, ordinary.id)).messages).toEqual([])
      }
    }
    expect(new Set(histories.map(history => history.conversationId)).size).toBe(2)
    expect(model.exchanges).toHaveLength(2)
  } finally {
    await info.attach('person-chat-entry-identities', { body: JSON.stringify({ appId: person.id, spaceId: space.id, observations, histories, requests }, null, 2), contentType: 'application/json' })
  }
})
