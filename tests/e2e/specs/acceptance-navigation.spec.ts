import { test, expect, registryAcceptance, registryPerson, openRegistry, registryCard } from '../fixtures/acceptance-registry'
import {
  conversationRow, openManagedConversation, readManagedConversation, seedManagedConversation, seedManagedPerson,
} from '../fixtures/acceptance-management'
import { createKnowledgeBase, readKnowledgeBases } from '../fixtures/acceptance-knowledge'
import { navigateToApps, navigateToChat, navigateToSettings } from '../fixtures/helpers'

test.setTimeout(90000)

const storeResource = registryPerson('navigation-evidence', 'Navigation store evidence')
test.use({ registryCatalog: { sources: [{ id: 'navigation-source', name: 'Navigation catalog', resources: [storeResource] }] } })

test('primary navigation reaches real page content and returns to the same stored conversation and draft', {
  annotation: [registryAcceptance('startup.navigation.destinations').annotation, registryAcceptance('startup.navigation.back').annotation],
}, async ({ registryApp, registry, window }, info) => {
  await window.setViewportSize({ width: 1600, height: 900 })
  const person = await seedManagedPerson(window, 'Navigation person evidence')
  const knowledge = await createKnowledgeBase(window, 'Navigation knowledge evidence')
  const original = await seedManagedConversation(window, 'halo-temp', 'Retained navigation discussion', [
    { role: 'user', content: 'This question belongs to the retained navigation discussion.' },
    { role: 'assistant', content: 'This answer identifies the retained discussion after navigation.' },
  ])
  const control = await seedManagedConversation(window, 'halo-temp', 'Independent navigation discussion', [
    { role: 'user', content: 'Leave this separate discussion unchanged.' },
    { role: 'assistant', content: 'This answer is not the selected navigation discussion.' },
  ])
  const draft = 'Retain this unsent draft while I visit other primary pages.'
  const visited: string[] = []

  async function assertReturned() {
    await navigateToChat(window)
    await expect(window.getByRole('button', { name: 'Conversation', exact: true }).first()).toHaveAttribute('aria-current', 'page')
    await expect(window.getByRole('banner').getByText(original.title, { exact: true })).toBeVisible()
    await expect(conversationRow(window, original.title)).toHaveCount(1)
    for (const message of original.messages) {
      await expect(window.locator(`[data-message-id="${message.id}"]`).first()).toContainText(message.content)
    }
    for (const message of control.messages) await expect(window.locator(`[data-message-id="${message.id}"]`)).toHaveCount(0)
    await expect(window.locator('textarea').first()).toHaveValue(draft)
    expect((await readManagedConversation(window, 'halo-temp', original.id)).messages).toEqual(original.messages)
    expect((await readManagedConversation(window, 'halo-temp', control.id)).messages).toEqual(control.messages)
  }

  await openManagedConversation(window, original.title)
  await window.locator('textarea').first().fill(draft)
  await navigateToApps(window)
  await expect(window.getByRole('button', { name: 'Digital Humans', exact: true }).first()).toHaveAttribute('aria-current', 'page')
  await expect(window.getByRole('heading', { name: person.spec.name, level: 2, exact: true })).toBeVisible()
  await expect(window.getByRole('button', { name: 'Capability library', exact: true })).toBeVisible()
  visited.push('people')
  await assertReturned()

  await window.getByRole('button', { name: 'Knowledge Base', exact: true }).first().click()
  await expect(window.getByRole('button', { name: 'Knowledge Base', exact: true }).first()).toHaveAttribute('aria-current', 'page')
  await expect(window.getByRole('heading', { name: knowledge.name, exact: true })).toBeVisible()
  expect((await readKnowledgeBases(window)).find(entry => entry.id === knowledge.id)).toMatchObject({ id: knowledge.id, name: knowledge.name })
  visited.push('knowledge')
  await assertReturned()

  await openRegistry(window)
  await expect(window.getByRole('button', { name: 'Store', exact: true }).first()).toHaveAttribute('aria-current', 'page')
  await expect(registryCard(window, storeResource.entry.name)).toBeVisible()
  expect(registry.requests.some(request => request.path.startsWith('/navigation-source/') && request.status === 200)).toBe(true)
  visited.push('store')
  await assertReturned()

  const tasks = window.getByRole('button', { name: 'Tasks', exact: true }).first()
  await tasks.click()
  await expect(tasks).toHaveAttribute('aria-current', 'page')
  await expect(window.getByText('No active tasks', { exact: true })).toBeVisible()
  await expect(window.getByRole('banner').getByText(original.title, { exact: true })).toBeVisible()
  visited.push('tasks')
  await tasks.click()
  await expect(window.getByText('No active tasks', { exact: true })).toHaveCount(0)
  await assertReturned()

  await navigateToSettings(window)
  await expect(window.getByRole('button', { name: 'Settings', exact: true }).first()).toHaveAttribute('aria-current', 'page')
  await expect(window.locator('#ai-model').getByRole('heading', { name: 'AI Model', exact: true })).toBeVisible()
  visited.push('settings')
  await assertReturned()
  await expect(window.locator('#ai-model')).toHaveCount(0)
  expect(visited).toEqual(['people', 'knowledge', 'store', 'tasks', 'settings'])
  await info.attach('primary-navigation-identity', { body: JSON.stringify({ visited, original: original.id, control: control.id, person: person.id, knowledge: knowledge.id, profile: registryApp.profile }, null, 2), contentType: 'application/json' })
})
