import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import {
  test, expect, managementAcceptance, conversationRow, listManagedConversations,
  openManagedConversation, readManagedConversation, seedManagedConversation, seedManagedSpace,
} from '../fixtures/acceptance-management'
import { navigateToChat, openDigitalHumanConversation } from '../fixtures/helpers'

test.setTimeout(90000)

async function openConversationMenu(page: Page, title: string, action: string) {
  const row = conversationRow(page, title)
  await expect(row).toHaveCount(1)
  await row.hover()
  await row.getByTitle('More', { exact: true }).click()
  await page.getByRole('button', { name: action, exact: true }).click()
}

test('a new conversation starts blank while the previous conversation retains its records after restart', managementAcceptance('conversations.organize.new'), async ({ managementApp, window }) => {
  const original = await seedManagedConversation(window, 'halo-temp', 'Original discussion', [
    { role: 'user', content: 'Keep the original question in this discussion.' },
    { role: 'assistant', content: 'The original answer belongs only to this discussion.' },
  ])
  await window.reload()
  await openManagedConversation(window, original.title)
  await expect(window.locator('.message-assistant')).toContainText(original.messages[1].content)
  const before = (await listManagedConversations(window)).map(item => item.id)
  await window.getByRole('button', { name: 'New', exact: true }).first().click()
  await expect(window.locator('textarea').first()).toHaveValue('')
  await expect(window.locator('.message-assistant')).toHaveCount(0)
  await expect.poll(async () => (await listManagedConversations(window)).filter(item => !before.includes(item.id)).length).toBe(1)
  const created = (await listManagedConversations(window)).find(item => !before.includes(item.id))!
  expect((await readManagedConversation(window, 'halo-temp', created.id)).messages).toEqual([])
  await openManagedConversation(window, original.title)
  await expect(window.locator('.message-assistant')).toContainText(original.messages[1].content)
  expect((await readManagedConversation(window, 'halo-temp', original.id)).messages).toEqual(original.messages)

  const reopened = await managementApp.restart()
  await openManagedConversation(reopened, original.title)
  await expect(reopened.locator('.message-assistant')).toContainText(original.messages[1].content)
  expect((await readManagedConversation(reopened, 'halo-temp', created.id)).messages).toEqual([])
})

test('renaming and pinning one conversation persists without altering another conversation', managementAcceptance('conversations.organize.pin'), async ({ managementApp, window }) => {
  const first = await seedManagedConversation(window, 'halo-temp', 'Pinned research', [
    { role: 'user', content: 'Research fixture question.' }, { role: 'assistant', content: 'Research fixture answer.' },
  ])
  const second = await seedManagedConversation(window, 'halo-temp', 'Unchanged release', [
    { role: 'user', content: 'Release fixture question.' }, { role: 'assistant', content: 'Release fixture answer.' },
  ])
  await window.reload()
  await openManagedConversation(window, first.title)
  await openConversationMenu(window, first.title, 'Rename')
  await window.getByPlaceholder('Conversation title...', { exact: true }).fill('Cancelled conversation title')
  await window.getByPlaceholder('Conversation title...', { exact: true }).press('Escape')
  expect((await readManagedConversation(window, 'halo-temp', first.id)).title).toBe(first.title)
  await openConversationMenu(window, first.title, 'Rename')
  await window.getByPlaceholder('Conversation title...', { exact: true }).fill('Evidence to keep')
  await window.getByPlaceholder('Conversation title...', { exact: true }).press('Enter')
  await expect.poll(async () => (await readManagedConversation(window, 'halo-temp', first.id)).title).toBe('Evidence to keep')
  const row = conversationRow(window, 'Evidence to keep')
  await row.hover()
  await row.getByTitle('Pin', { exact: true }).click()
  await expect.poll(async () => (await listManagedConversations(window)).find(item => item.id === first.id)?.starred).toBe(true)
  expect((await readManagedConversation(window, 'halo-temp', second.id)).title).toBe(second.title)
  expect((await listManagedConversations(window)).find(item => item.id === second.id)?.starred ?? false).toBe(false)

  const reopened = await managementApp.restart()
  await navigateToChat(reopened)
  const restored = conversationRow(reopened, 'Evidence to keep')
  await expect(restored).toBeVisible()
  await restored.hover()
  await expect(restored.getByTitle('Unpin', { exact: true })).toHaveAttribute('aria-pressed', 'true')
  await restored.getByTitle('Unpin', { exact: true }).click()
  await expect.poll(async () => Boolean((await listManagedConversations(reopened)).find(item => item.id === first.id)?.starred)).toBe(false)
  expect((await readManagedConversation(reopened, 'halo-temp', first.id)).messages).toEqual(first.messages)
  expect((await readManagedConversation(reopened, 'halo-temp', second.id)).messages).toEqual(second.messages)
})

test('deleting a space conversation removes only that history and does not recreate it after restart', managementAcceptance('conversations.organize.delete-space'), async ({ managementApp, window }) => {
  const removed = await seedManagedConversation(window, 'halo-temp', 'Disposable discussion', [
    { role: 'user', content: 'Delete this isolated history.' }, { role: 'assistant', content: 'This reply will be removed.' },
  ])
  const retained = await seedManagedConversation(window, 'halo-temp', 'Retained discussion', [
    { role: 'user', content: 'Keep this isolated history.' }, { role: 'assistant', content: 'This reply must remain.' },
  ])
  await window.reload()
  await openManagedConversation(window, removed.title)
  await openConversationMenu(window, removed.title, 'Delete')
  await expect(conversationRow(window, removed.title)).toHaveCount(0)
  await expect.poll(async () => (await listManagedConversations(window)).some(item => item.id === removed.id)).toBe(false)
  const missing = await window.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.getConversation('halo-temp', id), removed.id)
  expect(missing).toMatchObject({ success: false, error: 'Conversation not found' })
  expect((await readManagedConversation(window, 'halo-temp', retained.id)).messages).toEqual(retained.messages)
  const reopened = await managementApp.restart()
  await openManagedConversation(reopened, retained.title)
  await expect(reopened.locator('.message-assistant')).toContainText(retained.messages[1].content)
  expect((await listManagedConversations(reopened)).some(item => item.id === removed.id)).toBe(false)
})

test.describe('digital-human history clearing', () => {
  test.use({ seedPersonChat: true })

  test('clearing a digital-human chat requires confirmation and preserves unrelated conversation records', managementAcceptance('conversations.organize.delete'), async ({ managementApp, window }) => {
    const chat = managementApp.personChat
    if (!chat) throw new Error('The digital-human history precondition was not seeded')
    const other = await seedManagedConversation(window, 'halo-temp', 'Keep separate history', [
      { role: 'user', content: 'This separate conversation is not being cleared.' },
      { role: 'assistant', content: 'Its answer must survive the other history being cleared.' },
    ])
    await window.reload()
    await navigateToChat(window)
    await openDigitalHumanConversation(window, chat.name, chat.turns.at(-1)!.reply.slice(0, 20))
    const transcript = () => window.evaluate(async ({ appId, conversationId }) => {
      const result = await (window as unknown as { halo: HaloAPI }).halo.appChatTranscript({ appId, spaceId: 'halo-temp', conversationId })
      if (!result.success || !result.data) throw new Error('Could not inspect the stored digital-human transcript')
      return result.data.messages
    }, chat)
    const before = await transcript()
    expect(before.length).toBeGreaterThan(0)
    await window.getByRole('button', { name: 'Clear chat', exact: true }).click()
    await expect(window.getByText('Clear all chat history?', { exact: true })).toBeVisible()
    await window.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await transcript()).toEqual(before)
    await expect(window.getByText(chat.turns.at(-1)!.reply, { exact: true }).first()).toBeVisible()
    await window.getByRole('button', { name: 'Clear chat', exact: true }).click()
    await window.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect.poll(transcript).toEqual([])
    expect((await readManagedConversation(window, 'halo-temp', other.id)).messages).toEqual(other.messages)

    const reopened = await managementApp.restart()
    const cleared = await reopened.evaluate(async ({ appId, conversationId }) => (window as unknown as { halo: HaloAPI }).halo.appChatTranscript({ appId, spaceId: 'halo-temp', conversationId }), chat)
    expect(cleared).toMatchObject({ success: true, data: { messages: [] } })
    await openManagedConversation(reopened, other.title)
    await expect(reopened.locator('.message-assistant')).toContainText(other.messages[1].content)
  })
})

const searchPlaceholder = 'Search conversations, files, tasks, knowledge bases, digital humans, or run an action...'
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

test('message search respects conversation and workspace scope and opens an older result in another workspace', {
  annotation: [managementAcceptance('search.messages.scope').annotation, managementAcceptance('search.messages.open').annotation],
}, async ({ window }) => {
  const marker = 'acceptance-scope-marker'
  const first = await seedManagedConversation(window, 'halo-temp', 'Current search discussion', [
    { role: 'user', content: 'Question for the current discussion.' }, { role: 'assistant', content: `${marker} in the current discussion.` },
  ])
  const second = await seedManagedConversation(window, 'halo-temp', 'Neighbor search discussion', [
    { role: 'user', content: 'Question for the neighboring discussion.' }, { role: 'assistant', content: `${marker} in the neighboring discussion.` },
  ])
  const space = await seedManagedSpace(window, 'Other searchable workspace')
  const older = await seedManagedConversation(window, space.id, 'Older remote result', [
    { role: 'user', content: 'The first question in another workspace.' },
    { role: 'assistant', content: `${marker} in the older answer.` },
    ...Array.from({ length: 110 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `Later history item ${index + 1} without the search phrase.` })),
  ])
  await window.reload()
  await openManagedConversation(window, first.title)

  for (const [scope, titles] of [
    ['Current conversation', [first.title]],
    ['Current workspace', [first.title, second.title]],
    ['All workspaces', [first.title, second.title, older.title]],
  ] as const) {
    await window.keyboard.press(`${modifier}+k`)
    const input = window.getByPlaceholder(searchPlaceholder, { exact: true })
    await expect(input).toBeVisible()
    const panel = input.locator('../..')
    if (scope !== 'All workspaces') {
      await panel.getByRole('button', { name: 'All workspaces', exact: true }).click()
      await panel.getByRole('button', { name: scope, exact: true }).click()
    }
    await input.fill('')
    await input.fill(marker)
    await panel.getByRole('button', { name: `Search message content for "${marker}"`, exact: true }).click()
    const results = panel.getByRole('button').filter({ has: window.locator('.border-l-2') })
    await expect(results).toHaveCount(titles.length)
    for (const title of titles) await expect(results.filter({ hasText: title })).toBeVisible()
    if (scope !== 'All workspaces') {
      await window.keyboard.press('Escape')
      await expect(input).toHaveCount(0)
    } else {
      await results.filter({ hasText: older.title }).click()
      await expect(input).toHaveCount(0)
    }
  }
  await expect(window.getByTitle(`Current workspace: ${space.name} — click to switch`, { exact: true })).toBeVisible()
  const target = window.locator(`[data-message-id="${older.messages[1].id}"]`).first()
  await expect(target).toContainText(`${marker} in the older answer.`)
  await expect(target).toBeInViewport()
  await expect(window.getByRole('button', { name: 'Close search', exact: true })).toBeVisible()
  await window.getByRole('button', { name: 'Close search', exact: true }).click()
  expect((await readManagedConversation(window, 'halo-temp', first.id)).messages).toEqual(first.messages)
  expect((await readManagedConversation(window, space.id, older.id)).messages).toEqual(older.messages)
})

test('quick-jump keyboard navigation opens the selected conversation and Escape dismisses search', managementAcceptance('search.jump.keyboard'), async ({ window }) => {
  const conversation = await seedManagedConversation(window, 'halo-temp', 'Keyboard destination', [
    { role: 'user', content: 'A keyboard-selected question.' }, { role: 'assistant', content: 'A keyboard-selected answer.' },
  ])
  const control = await seedManagedConversation(window, 'halo-temp', 'Different starting discussion', [
    { role: 'user', content: 'This is the starting conversation, not the keyboard destination.' },
    { role: 'assistant', content: 'The starting answer must disappear when navigation succeeds.' },
  ])
  await window.reload()
  await openManagedConversation(window, control.title)
  await expect(window.locator('.message-assistant')).toContainText(control.messages[1].content)
  await expect(window.getByText(conversation.messages[1].content, { exact: true })).toHaveCount(0)
  await window.keyboard.press(`${modifier}+k`)
  const input = window.getByPlaceholder(searchPlaceholder, { exact: true })
  await input.fill(conversation.title)
  const panel = input.locator('../..')
  await expect(panel.getByRole('button').filter({ hasText: conversation.title }).first()).toBeVisible()
  await input.press('ArrowDown')
  await input.press('ArrowUp')
  await input.press('Enter')
  await expect(input).toHaveCount(0)
  await expect(window.locator('.message-assistant')).toContainText(conversation.messages[1].content)
  await expect(window.getByText(control.messages[1].content, { exact: true })).toHaveCount(0)
  await expect(window.locator(`[data-message-id="${conversation.messages[1].id}"]`).first()).toBeVisible()
  await window.keyboard.press(`${modifier}+k`)
  await expect(input).toBeVisible()
  await input.press('Escape')
  await expect(input).toHaveCount(0)
  await expect(window.locator('textarea').first()).toBeVisible()
})
