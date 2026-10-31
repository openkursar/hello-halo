import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { test, expect, completeFirstPreferences, firstUseAcceptance, firstUseState } from '../fixtures/acceptance-first-use'
import { PROVIDER_RESPONSE, providerField } from '../fixtures/acceptance-model-settings'
import { listManagedConversations, readManagedConversation, openManagedConversation } from '../fixtures/acceptance-management'
import { navigateToSettings } from '../fixtures/helpers'

test.setTimeout(120000)
const configuredTest = test.extend({ firstUseEngine: 'halo' as const })

async function expectWorkspaceWithoutSetup(page: Page) {
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({ timeout: 15000 })
  await expect(page.getByText("Let's set things up", { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Skip for now', exact: true })).toHaveCount(0)
}

configuredTest('a fresh profile configures its first local account through setup and keeps the usable account after restart', firstUseAcceptance('startup.first-use.configure', 'scripted'), async ({ firstUseApp, providerGateway, window }, info) => {
  const initial = await firstUseState(window)
  expect(initial).toMatchObject({ isFirstLaunch: true, modelConfigSkipped: false, onboardingCompleted: false, currentId: null, sources: [] })
  const preferences = await completeFirstPreferences(window)
  await window.getByRole('button').filter({ has: window.getByText('Custom API', { exact: true }) }).click()
  await expect(window.getByRole('heading', { name: 'Custom API', exact: true })).toBeVisible()
  const save = window.getByRole('button', { name: 'Save and enter', exact: true })
  await expect(save).toBeDisabled()
  const key = window.getByPlaceholder('Enter your API Key', { exact: true })
  await expect(key).toHaveAttribute('type', 'password')
  await key.fill(providerGateway.key('primary'))
  await expect(save).toBeDisabled()
  await window.getByRole('button', { name: /Select provider/ }).click()
  await window.getByPlaceholder('Search providers...', { exact: true }).fill('OpenAI API')
  await window.getByRole('button').filter({ has: window.getByText('OpenAI API', { exact: true }) }).click()
  await window.getByPlaceholder('https://xxx.xxx.xxx', { exact: true }).fill(providerGateway.url('primary'))
  const availability = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.getEngineAvailability())
  expect(availability).toMatchObject({ success: true, data: { activeEngine: 'halo', degradedFrom: null } })
  await info.attach('first-use-engine', { body: JSON.stringify({ requestedEngine: 'halo', availability }, null, 2), contentType: 'application/json' })
  await window.getByRole('button', { name: 'Test connection', exact: true }).click()
  await expect(window.getByText('Connection successful', { exact: true })).toBeVisible({ timeout: 30000 })
  expect(providerGateway.requests.some(request => /\/(chat\/completions|messages)$/.test(request.path) && request.model === 'gpt-4o' && request.authorized && request.status === 200)).toBe(true)
  await save.click()
  await expectWorkspaceWithoutSetup(window)
  const saved = await firstUseState(window, providerGateway.key('primary'))
  expect(saved).toMatchObject({ isFirstLaunch: false, modelConfigSkipped: false, theme: 'light' })
  expect(saved.sources).toHaveLength(1)
  expect(saved.sources[0]).toMatchObject({ name: 'OpenAI API', provider: 'openai', authType: 'api-key', model: 'gpt-4o', credentialMatches: true })
  expect([providerGateway.url('primary'), `${providerGateway.url('primary')}/chat/completions`]).toContain(saved.sources[0].apiUrl)
  expect(saved.currentId).toBe(saved.sources[0].id)
  expect(providerGateway.requests.some(request => request.method === 'GET' && request.path.endsWith('/models') && request.authorized && request.status === 200)).toBe(true)

  const message = `Confirm the account configured during first use: ${randomUUID()}`
  const beforeChat = providerGateway.requests.length
  await window.locator('textarea').fill(message)
  await window.locator('[data-onboarding="send-button"]').click()
  await expect(window.locator('.message-assistant').last()).toContainText(PROVIDER_RESPONSE, { timeout: 45000 })
  await expect(window.getByTitle('Stop generation (Esc)', { exact: true })).toHaveCount(0)
  expect(providerGateway.requests.slice(beforeChat).some(request => /\/(chat\/completions|messages)$/.test(request.path) && request.endpoint === 'primary' && request.model === 'gpt-4o' && request.authorized && request.status === 200)).toBe(true)
  let conversationId: string | undefined
  await expect.poll(async () => {
    for (const entry of await listManagedConversations(window)) {
      const stored = await readManagedConversation(window, 'halo-temp', entry.id)
      if (!stored.messages.some(item => item.role === 'user' && item.content === message)) continue
      conversationId = stored.id
      return stored.messages.filter(item => item.role === 'assistant' && item.content === PROVIDER_RESPONSE).length
    }
    return 0
  }).toBe(1)
  const stored = await readManagedConversation(window, 'halo-temp', conversationId!)
  const reopened = await firstUseApp.restart()
  await expectWorkspaceWithoutSetup(reopened)
  expect(await firstUseState(reopened, providerGateway.key('primary'))).toEqual(saved)
  await openManagedConversation(reopened, stored.title)
  await expect(reopened.locator('.message-user').last()).toContainText(message)
  await expect(reopened.locator('.message-assistant').last()).toContainText(PROVIDER_RESPONSE)
  expect((await readManagedConversation(reopened, 'halo-temp', stored.id)).messages).toEqual(stored.messages)
  await navigateToSettings(reopened)
  await expect(reopened.locator('#ai-model').getByText('OpenAI API', { exact: true })).toBeVisible()
  await info.attach('first-use-configuration', { body: JSON.stringify({ preferences, initial, saved, conversationId: stored.id, persistedMessageCount: stored.messages.length }, null, 2), contentType: 'application/json' })
})

test('deferring account configuration from a fresh profile persists and keeps the settings entry usable', firstUseAcceptance('startup.first-use.defer', 'none'), async ({ firstUseApp, providerGateway, window }, info) => {
  const initial = await firstUseState(window)
  expect(initial).toMatchObject({ isFirstLaunch: true, modelConfigSkipped: false, onboardingCompleted: false, currentId: null, sources: [] })
  const preferences = await completeFirstPreferences(window)
  await window.getByRole('button', { name: 'Skip for now', exact: true }).click()
  await expectWorkspaceWithoutSetup(window)
  const deferred = await firstUseState(window)
  expect(deferred).toMatchObject({ isFirstLaunch: false, modelConfigSkipped: true, onboardingCompleted: false, theme: 'light', currentId: null, sources: [] })
  const reopened = await firstUseApp.restart()
  await expectWorkspaceWithoutSetup(reopened)
  expect(await firstUseState(reopened)).toEqual(deferred)
  await navigateToSettings(reopened)
  await reopened.locator('#ai-model').getByRole('button', { name: 'Add AI Provider', exact: true }).click()
  await expect(reopened.locator('#ai-model').getByRole('heading', { name: 'Add AI Provider', exact: true })).toBeVisible()
  await expect(providerField(reopened, 'API Key')).toBeEditable()
  await expect(providerField(reopened, 'API URL')).toBeEditable()
  await reopened.locator('#ai-model').getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await firstUseState(reopened)).toEqual(deferred)
  expect(providerGateway.requests).toEqual([])
  await info.attach('first-use-deferral', { body: JSON.stringify({ preferences, initial, deferred, configurationEntryAvailable: true, providerRequests: providerGateway.requests.length }, null, 2), contentType: 'application/json' })
})
