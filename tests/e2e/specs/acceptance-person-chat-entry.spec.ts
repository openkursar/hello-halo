import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { buildLocalSessionKey, parseAppChatKey } from '../../../src/shared/apps/im-keys'
import type { ModelRequest } from '../fixtures/acceptance-model'
import { test, expect, acceptance, readAcceptanceErrors, sendAcceptanceMessage } from '../fixtures/acceptance-app'
import {
  conversationRow, listManagedConversations, listManagedPersonChats, openManagedPerson, readManagedConversation, readManagedPerson, seedManagedSpace,
} from '../fixtures/acceptance-management'
import { navigateToChat, navigateToWorkspaces, openDigitalHumanConversation, startNewDigitalHumanConversation } from '../fixtures/helpers'

test.setTimeout(180000)

async function installPerson(window: Page, spaceId: string, name: string) {
  const installed = await window.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appInstall({
    spaceId: input.spaceId,
    spec: {
      spec_version: '1.0', version: '1.0.0', type: 'automation', name: input.name,
      author: 'Acceptance author', description: 'An isolated conversation recipient.',
      system_prompt: 'Respond only to the supplied synthetic task.', subscriptions: [], requires: {}, config_schema: [], permissions: [],
    },
  }), { name, spaceId })
  expect(installed.success).toBe(true)
  return readManagedPerson(window, (installed.data as { appId: string }).appId)
}

async function openChatFromDetails(window: Page, name: string) {
  await openManagedPerson(window, name)
  await window.getByTitle('Opens the conversation with this digital human in the workspace chat', { exact: true }).click()
  await expect(window.getByTitle(`Chatting with ${name}`, { exact: true })).toBeVisible()
}

async function transcript(window: Page, appId: string, spaceId: string, conversationId: string) {
  const result = await window.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appChatTranscript(input), { appId, spaceId, conversationId })
  expect(result.success).toBe(true)
  return result.data!.messages
}

async function waitIdle(window: Page, appId: string, conversationId: string) {
  await expect.poll(() => window.evaluate(async input => {
    const result = await (window as unknown as { halo: HaloAPI }).halo.appChatSessionState(input.appId, input.conversationId)
    if (!result.success || !result.data) throw new Error('The actual person conversation must remain readable')
    return (result.data as { isActive: boolean }).isActive
  }, { appId, conversationId })).toBe(false)
}

async function userTexts(window: Page, appId: string, spaceId: string, conversationId: string) {
  return (await transcript(window, appId, spaceId, conversationId)).filter(message => message.role === 'user').map(message => message.content)
}

test('Chat continues a person\'s latest conversation and starts one only when it has none or on request', {
  annotation: [acceptance('conversations.organize.person-continue').annotation, acceptance('conversations.organize.person-new').annotation],
}, async ({ model, window }, info) => {
  const name = `Chat entry owner ${randomUUID().slice(0, 8)}`
  const requests: ModelRequest[] = []
  model.respond(request => {
    requests.push(request)
    return { text: `Person reply ${requests.length}.` }
  })
  await navigateToChat(window)
  const space = await seedManagedSpace(window, 'Empty person-chat workspace')
  const person = await installPerson(window, space.id, name)
  await navigateToWorkspaces(window)
  await expect(window.getByRole('heading', { name: space.name, level: 3, exact: true })).toBeVisible()
  expect(await listManagedConversations(window, space.id)).toEqual([])
  expect(await listManagedPersonChats(window, person.id)).toEqual([])
  const questions = [1, 2, 3].map(stage => `Person chat ${stage}: ${randomUUID()}`)
  const observations: Array<Record<string, unknown>> = []
  try {
    // No conversation yet: Chat starts one, addressed to the person, from the details page of an empty workspace.
    await openChatFromDetails(window, name)
    await expect.poll(async () => (await listManagedPersonChats(window, person.id)).length).toBe(1)
    const first = buildLocalSessionKey(person.id, (await listManagedPersonChats(window, person.id))[0].chatId)
    await expect(window.getByTitle(`Current workspace: ${space.name} — click to switch`, { exact: true })).toBeVisible()
    await expect(window.locator('.message-user')).toHaveCount(0)
    await expect(window.locator('textarea').first()).toHaveValue('')
    const firstTurn = await sendAcceptanceMessage(window, questions[0])
    expect(firstTurn).toMatchObject({ spaceId: space.id, conversationId: first })
    await expect(window.locator('.message-assistant [data-message-content]').last()).toHaveText('Person reply 1.')
    await waitIdle(window, person.id, first)
    observations.push({ stage: 'first chat', conversationId: first })

    // Chat again from the details page: the same conversation, its history shown, nothing new created.
    await openChatFromDetails(window, name)
    await expect(window.locator('.message-user [data-message-content]').filter({ hasText: questions[0] })).toBeVisible()
    expect((await listManagedPersonChats(window, person.id)).map(record => record.chatId)).toEqual([parseAppChatKey(first)!.chatId])
    const continued = await sendAcceptanceMessage(window, questions[1])
    expect(continued).toMatchObject({ spaceId: space.id, conversationId: first })
    await expect(window.locator('.message-assistant [data-message-content]').last()).toHaveText('Person reply 2.')
    await waitIdle(window, person.id, first)
    expect(await userTexts(window, person.id, space.id, first)).toEqual([questions[0], questions[1]])
    expect(requests[1].lastUserText).toContain(questions[1])
    observations.push({ stage: 'chat again', conversationId: continued.conversationId })

    // The sidebar's new-conversation action still starts a separate, empty conversation with the same person.
    const before = new Set((await listManagedPersonChats(window, person.id)).map(record => record.chatId))
    await startNewDigitalHumanConversation(window, name)
    await expect.poll(async () => (await listManagedPersonChats(window, person.id)).filter(record => !before.has(record.chatId)).length).toBe(1)
    const created = (await listManagedPersonChats(window, person.id)).find(record => !before.has(record.chatId))!
    const second = buildLocalSessionKey(person.id, created.chatId)
    await expect(window.getByTitle(`Chatting with ${name}`, { exact: true })).toBeVisible()
    await expect(window.locator('.message-user')).toHaveCount(0)
    await expect(window.locator('textarea').first()).toHaveValue('')
    const separate = await sendAcceptanceMessage(window, questions[2])
    expect(separate).toMatchObject({ spaceId: space.id, conversationId: second })
    await expect(window.locator('.message-assistant [data-message-content]').last()).toHaveText('Person reply 3.')
    await waitIdle(window, person.id, second)
    expect(await userTexts(window, person.id, space.id, second)).toEqual([questions[2]])
    expect(await userTexts(window, person.id, space.id, first)).toEqual([questions[0], questions[1]])
    observations.push({ stage: 'new conversation', conversationId: second })

    // Chat now continues the most recent of the two.
    await openChatFromDetails(window, name)
    await expect(window.locator('.message-user [data-message-content]').filter({ hasText: questions[2] })).toBeVisible()
    await expect(window.locator('.message-user [data-message-content]').filter({ hasText: questions[0] })).toHaveCount(0)
    expect(await listManagedPersonChats(window, person.id)).toHaveLength(2)

    expect(requests).toHaveLength(3)
    expect(await readAcceptanceErrors(window)).toEqual([])
    for (const ordinary of await listManagedConversations(window, space.id)) {
      expect((await readManagedConversation(window, space.id, ordinary.id)).messages).toEqual([])
    }
  } finally {
    await info.attach('person-chat-entry-identities', { body: JSON.stringify({ appId: person.id, spaceId: space.id, observations, requests }, null, 2), contentType: 'application/json' })
  }
})

test('a person conversation keeps its first question as its title in the list and header, until the user renames it', acceptance('conversations.organize.person-title'), async ({ acceptanceApp, model, window }, info) => {
  const name = `Title keeper ${randomUUID().slice(0, 8)}`
  const token = randomUUID().slice(0, 8)
  const first = `Plan the launch ${token}`
  const later = `Now the budget ${token}`
  const other = `Draft the memo ${token}`
  const renamed = `Launch room ${token}`
  let replies = 0
  model.respond(() => ({ text: `Title reply ${++replies}.` }))
  await navigateToChat(window)
  const space = await seedManagedSpace(window, 'Person title workspace')
  const person = await installPerson(window, space.id, name)
  // The workspace list is where the app learns of a workspace seeded outside it.
  await navigateToWorkspaces(window)
  await expect(window.getByRole('heading', { name: space.name, level: 3, exact: true })).toBeVisible()
  const banner = (page: Page) => page.getByRole('banner')
  const evidence: Array<Record<string, unknown>> = []
  try {
    await openChatFromDetails(window, name)
    const launch = (await sendAcceptanceMessage(window, first)).conversationId
    await waitIdle(window, person.id, launch)
    await expect(conversationRow(window, first)).toHaveCount(1)
    await expect(banner(window).getByText(`${name} · ${first}`, { exact: true })).toBeVisible()

    // A later message changes the preview, never the title.
    expect((await sendAcceptanceMessage(window, later)).conversationId).toBe(launch)
    await waitIdle(window, person.id, launch)
    await expect.poll(async () => (await listManagedPersonChats(window, person.id))[0]?.lastMessage).toBe(later)
    expect((await listManagedPersonChats(window, person.id))[0]).toMatchObject({ title: first, lastMessage: later })
    await expect(conversationRow(window, first)).toHaveCount(1)
    await expect(conversationRow(window, later)).toHaveCount(0)
    await expect(banner(window).getByText(`${name} · ${first}`, { exact: true })).toBeVisible()

    // A second conversation has its own title, and the header follows whichever is open.
    await startNewDigitalHumanConversation(window, name)
    await expect(window.locator('.message-user')).toHaveCount(0)
    const memo = (await sendAcceptanceMessage(window, other)).conversationId
    expect(memo).not.toBe(launch)
    await waitIdle(window, person.id, memo)
    await expect(conversationRow(window, other)).toHaveCount(1)
    await expect(banner(window).getByText(`${name} · ${other}`, { exact: true })).toBeVisible()
    await openDigitalHumanConversation(window, name, first)
    await expect(window.locator('.message-user [data-message-content]').filter({ hasText: later })).toBeVisible()
    await expect(banner(window).getByText(`${name} · ${first}`, { exact: true })).toBeVisible()
    evidence.push({ phase: 'two conversations', sessions: await listManagedPersonChats(window, person.id) })

    // The user's own name wins, and stays through later messages.
    const chatId = parseAppChatKey(launch)!.chatId
    const named = await window.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.imSessionsSetCustomName(input), { appId: person.id, channel: 'local', chatId, name: renamed })
    expect(named.success).toBe(true)
    await expect(conversationRow(window, renamed)).toHaveCount(1)
    await expect(banner(window).getByText(`${name} · ${renamed}`, { exact: true })).toBeVisible()

    // Titles survive a restart; Chat lands on the most recently active conversation.
    const reopened = await acceptanceApp.restart()
    await openChatFromDetails(reopened, name)
    await expect(banner(reopened).getByText(`${name} · ${other}`, { exact: true })).toBeVisible()
    await expect(conversationRow(reopened, other)).toHaveCount(1)
    await expect(conversationRow(reopened, renamed)).toHaveCount(1)
    await expect(conversationRow(reopened, first)).toHaveCount(0)
    const sessions = await listManagedPersonChats(reopened, person.id)
    expect(sessions.map(session => session.title).sort()).toEqual([first, other].sort())
    evidence.push({ phase: 'after restart', sessions })
    expect(await readAcceptanceErrors(reopened)).toEqual([])

    await info.attach('person-titles-desktop', { body: await reopened.screenshot(), contentType: 'image/png' })
    await reopened.setViewportSize({ width: 390, height: 844 })
    await reopened.getByTitle('Conversation history', { exact: true }).click()
    await expect(reopened.getByText(renamed, { exact: true }).first()).toBeVisible()
    await info.attach('person-titles-390', { body: await reopened.screenshot(), contentType: 'image/png' })
  } finally {
    await info.attach('person-chat-titles', { body: JSON.stringify({ appId: person.id, spaceId: space.id, evidence }, null, 2), contentType: 'application/json' })
  }
})
