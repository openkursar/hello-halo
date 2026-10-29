import type { Page } from '@playwright/test'
import {
  test, expect, modelSettingsAcceptance, aiSection, providerField,
  readProviderConfiguration, sourceCard,
} from '../fixtures/acceptance-model-settings'
import { listManagedConversations, readManagedConversation } from '../fixtures/acceptance-management'
import { navigateToChat, navigateToSettings } from '../fixtures/helpers'

test.setTimeout(120000)

async function openSettings(page: Page) {
  if (!await aiSection(page).isVisible()) await navigateToSettings(page)
}

async function openAdd(page: Page) {
  await openSettings(page)
  await aiSection(page).getByRole('button', { name: 'Add AI Provider', exact: true }).click()
  await expect(aiSection(page).getByRole('heading', { name: 'Add AI Provider', exact: true })).toBeVisible()
}

async function setCustomModel(page: Page, model: string) {
  await aiSection(page).getByLabel('Use custom model ID', { exact: true }).check()
  await aiSection(page).getByPlaceholder('Enter model ID', { exact: true }).fill(model)
  await aiSection(page).getByRole('button', { name: 'Apply', exact: true }).click()
}

async function fillProvider(page: Page, value: { name: string; url: string; key: string; model?: string }) {
  await providerField(page, 'Display Name').fill(value.name)
  await providerField(page, 'API URL').fill(value.url)
  await providerField(page, 'API Key').fill(value.key)
  if (value.model) await setCustomModel(page, value.model)
}

async function fetchAndChoose(page: Page, model: string) {
  const section = aiSection(page)
  await section.getByRole('button', { name: 'Fetch Models', exact: true }).click()
  await expect(section.getByText('Found 2 models', { exact: true })).toBeVisible()
  await section.getByRole('button', { name: /^(gpt-4o|gpt-4o-mini)$/ }).click()
  const choices = section.locator('div.absolute').filter({ has: page.getByPlaceholder('Search models...', { exact: true }) })
  await expect(choices).toHaveCount(1)
  await choices.getByText(model, { exact: true }).click()
  await expect(section.getByRole('button', { name: model, exact: true })).toBeVisible()
}

async function saveProvider(page: Page, name: string, action: 'Save' | 'Update' = 'Save') {
  await aiSection(page).getByRole('button', { name: action, exact: true }).click()
  await expect(sourceCard(page, name)).toBeVisible()
  await expect(aiSection(page).getByRole('heading', { name: /^(Add AI Provider|Edit Provider)$/ })).toHaveCount(0)
}

async function expandProvider(page: Page, name: string) {
  const card = sourceCard(page, name)
  await expect(card).toHaveCount(1)
  if (!await card.getByRole('button', { name: 'Edit', exact: true }).isVisible()) await card.getByText(name, { exact: true }).click()
  await expect(card.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
  return card
}

async function editProvider(page: Page, name: string) {
  await (await expandProvider(page, name)).getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(aiSection(page).getByRole('heading', { name: 'Edit Provider', exact: true })).toBeVisible()
}

async function successfulConnection(page: Page) {
  await aiSection(page).getByRole('button', { name: 'Test connection', exact: true }).click()
  await expect(aiSection(page).getByText('Connection successful', { exact: true })).toBeVisible({ timeout: 30000 })
}

function accountSettings(profile: string) {
  const configuration = readProviderConfiguration(profile)
  // Encryption may rewrite ciphertext; the editor separately verifies the retained credential.
  return { ...configuration, sources: configuration.sources.map(({ apiKey, ...source }) => ({ ...source, hasApiKey: Boolean(apiKey) })) }
}

test('a custom provider saved through settings supplies the connection check and a real chat after restart', modelSettingsAcceptance('models.accounts.custom'), async ({ providerGateway, managementApp, window }) => {
  const name = 'Local configured provider'
  await openAdd(window)
  await fillProvider(window, { name, url: providerGateway.url('primary'), key: providerGateway.key('primary') })
  await fetchAndChoose(window, 'gpt-4o-mini')
  await successfulConnection(window)
  await saveProvider(window, name)
  await expect.poll(() => readProviderConfiguration(managementApp.profile).sources.length).toBe(1)
  const saved = readProviderConfiguration(managementApp.profile).sources[0]
  expect(saved).toMatchObject({ name, provider: 'openai', authType: 'api-key', model: 'gpt-4o-mini' })
  expect([providerGateway.url('primary'), `${providerGateway.url('primary')}/chat/completions`]).toContain(saved.apiUrl)
  expect(readProviderConfiguration(managementApp.profile).currentId).toBe(saved.id)
  expect(providerGateway.requests.some(request => /\/(chat\/completions|messages)$/.test(request.path) && request.model === 'gpt-4o-mini' && request.authorized && request.status === 200)).toBe(true)

  const reopened = await managementApp.restart()
  expect(readProviderConfiguration(managementApp.profile).sources[0]).toMatchObject({ id: saved.id, model: 'gpt-4o-mini' })
  await navigateToChat(reopened)
  const before = providerGateway.requests.length
  const message = 'Verify the provider selected in my local account settings.'
  await reopened.locator('textarea').first().fill(message)
  await reopened.locator('[data-onboarding="send-button"]').click()
  await expect(reopened.locator('.message-assistant').last()).toContainText('Local provider configuration verified', { timeout: 45000 })
  await expect(reopened.getByTitle('Stop generation (Esc)', { exact: true })).toHaveCount(0)
  await expect.poll(() => providerGateway.requests.slice(before).some(request => request.endpoint === 'primary' && request.model === 'gpt-4o-mini' && request.authorized && request.status === 200)).toBe(true)
  await expect.poll(async () => {
    for (const conversation of await listManagedConversations(reopened)) {
      const stored = await readManagedConversation(reopened, 'halo-temp', conversation.id)
      if (stored.messages.some(item => item.role === 'user' && item.content === message)) return stored.messages.some(item => item.role === 'assistant' && item.content.includes('Local provider configuration verified'))
    }
    return false
  }).toBe(true)
})

test('editing a provider rotates its endpoint and key without creating a duplicate account', modelSettingsAcceptance('models.accounts.edit'), async ({ providerGateway, managementApp, window }) => {
  await openAdd(window)
  await fillProvider(window, { name: 'Original local account', url: providerGateway.url('primary'), key: providerGateway.key('primary'), model: 'gpt-4o' })
  await saveProvider(window, 'Original local account')
  const original = readProviderConfiguration(managementApp.profile).sources[0]
  await editProvider(window, original.name)
  await fillProvider(window, { name: 'Updated local account', url: providerGateway.url('secondary'), key: providerGateway.key('secondary') })
  await fetchAndChoose(window, 'gpt-4o-mini')
  await successfulConnection(window)
  await saveProvider(window, 'Updated local account', 'Update')
  await expect.poll(() => readProviderConfiguration(managementApp.profile).sources[0]?.name).toBe('Updated local account')
  const saved = readProviderConfiguration(managementApp.profile)
  expect(saved.sources).toHaveLength(1)
  expect(saved.currentId).toBe(original.id)
  expect(saved.sources[0]).toMatchObject({ id: original.id, model: 'gpt-4o-mini' })
  expect([providerGateway.url('secondary'), `${providerGateway.url('secondary')}/chat/completions`]).toContain(saved.sources[0].apiUrl)

  const reopened = await managementApp.restart()
  await openSettings(reopened)
  await editProvider(reopened, 'Updated local account')
  await expect(providerField(reopened, 'API URL')).toHaveValue(saved.sources[0].apiUrl)
  const before = providerGateway.requests.length
  await successfulConnection(reopened)
  const requests = providerGateway.requests.slice(before).filter(request => /\/(chat\/completions|messages)$/.test(request.path))
  expect(requests.length).toBeGreaterThan(0)
  expect(requests.every(request => request.endpoint === 'secondary' && request.model === 'gpt-4o-mini' && request.authorized && request.status === 200)).toBe(true)
})

test('credentials are concealed by default and reopening the editor restores concealment', modelSettingsAcceptance('models.accounts.credentials', 'none'), async ({ providerGateway, managementApp, window }) => {
  const name = 'Concealed local credential'
  const key = providerGateway.key('primary')
  await openAdd(window)
  await fillProvider(window, { name, url: providerGateway.url('primary'), key, model: 'gpt-4o' })
  const input = providerField(window, 'API Key')
  await expect(input).toHaveAttribute('type', 'password')
  expect(await aiSection(window).innerText()).not.toContain(key)
  await input.locator('..').getByRole('button').click()
  await expect(input).toHaveAttribute('type', 'text')
  await expect(input).toHaveValue(key)
  await input.locator('..').getByRole('button').click()
  await expect(input).toHaveAttribute('type', 'password')
  await saveProvider(window, name)
  expect(await sourceCard(window, name).innerText()).not.toContain(key)
  const reopened = await managementApp.restart()
  await openSettings(reopened)
  await editProvider(reopened, name)
  await expect(providerField(reopened, 'API Key')).toHaveAttribute('type', 'password')
  await expect(providerField(reopened, 'API Key')).toHaveValue(key)
  expect(await aiSection(reopened).innerText()).not.toContain(key)
  expect(providerGateway.requests).toEqual([])
})

test('a rejected key shows errors for model fetching and connection testing and can be corrected in place', modelSettingsAcceptance('models.accounts.rejected-key'), async ({ providerGateway, managementApp, window }) => {
  await openAdd(window)
  await fillProvider(window, { name: 'Recoverable account', url: providerGateway.url('primary'), key: 'invalid-local-fixture-key', model: 'gpt-4o' })
  await aiSection(window).getByRole('button', { name: 'Fetch Models', exact: true }).click()
  await expect(aiSection(window).getByText('Invalid API Key or no permission', { exact: false })).toBeVisible()
  await aiSection(window).getByRole('button', { name: 'Test connection', exact: true }).click()
  await expect(aiSection(window).getByText('Invalid API key', { exact: true })).toBeVisible({ timeout: 30000 })
  await expect(aiSection(window).getByText('Connection successful', { exact: true })).toHaveCount(0)
  expect(readProviderConfiguration(managementApp.profile).sources).toEqual([])
  expect(providerGateway.requests.some(request => request.method === 'GET' && request.status === 401)).toBe(true)
  expect(providerGateway.requests.some(request => request.method === 'POST' && request.status === 401)).toBe(true)
  await providerField(window, 'API Key').fill(providerGateway.key('primary'))
  await successfulConnection(window)
  await saveProvider(window, 'Recoverable account')
  expect(readProviderConfiguration(managementApp.profile).sources).toHaveLength(1)
})

test('an unavailable custom model fails visibly and selecting an available model restores the connection', modelSettingsAcceptance('models.accounts.unavailable-model'), async ({ providerGateway, managementApp, window }) => {
  await openAdd(window)
  await fillProvider(window, { name: 'Corrected model account', url: providerGateway.url('primary'), key: providerGateway.key('primary'), model: 'unavailable-local-model' })
  await aiSection(window).getByRole('button', { name: 'Test connection', exact: true }).click()
  await expect(aiSection(window).getByText(/Requested model is not available/)).toBeVisible({ timeout: 30000 })
  await expect(aiSection(window).getByText('Connection successful', { exact: true })).toHaveCount(0)
  expect(readProviderConfiguration(managementApp.profile).sources).toEqual([])
  expect(providerGateway.requests.some(request => request.model === 'unavailable-local-model' && request.status === 400)).toBe(true)
  await setCustomModel(window, 'gpt-4o')
  await successfulConnection(window)
  await saveProvider(window, 'Corrected model account')
  expect(readProviderConfiguration(managementApp.profile).sources[0].model).toBe('gpt-4o')
})

test('cancelling account creation, editing and deletion preserves the stored configuration', modelSettingsAcceptance('models.accounts.cancel', 'none'), async ({ providerGateway, managementApp, window }) => {
  await openAdd(window)
  await fillProvider(window, { name: 'Cancelled new account', url: providerGateway.url('primary'), key: providerGateway.key('primary'), model: 'gpt-4o' })
  await aiSection(window).getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(aiSection(window).getByText('No AI sources configured', { exact: true })).toBeVisible()
  expect(readProviderConfiguration(managementApp.profile).sources).toEqual([])
  await openAdd(window)
  await fillProvider(window, { name: 'Retained account', url: providerGateway.url('primary'), key: providerGateway.key('primary'), model: 'gpt-4o' })
  await saveProvider(window, 'Retained account')
  const previous = accountSettings(managementApp.profile)
  await editProvider(window, 'Retained account')
  await fillProvider(window, { name: 'Cancelled edit', url: providerGateway.url('secondary'), key: providerGateway.key('secondary'), model: 'gpt-4o-mini' })
  await aiSection(window).getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(accountSettings(managementApp.profile)).toEqual(previous)
  await (await expandProvider(window, 'Retained account')).getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(aiSection(window).getByRole('heading', { name: 'Confirm Delete', exact: true })).toBeVisible()
  await aiSection(window).getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(accountSettings(managementApp.profile)).toEqual(previous)
  const reopened = await managementApp.restart()
  await openSettings(reopened)
  await expect(sourceCard(reopened, 'Retained account')).toBeVisible()
  expect(accountSettings(managementApp.profile)).toEqual(previous)
  await editProvider(reopened, 'Retained account')
  await expect(providerField(reopened, 'API Key')).toHaveValue(providerGateway.key('primary'))
  expect(providerGateway.requests).toEqual([])
})

const shutdownTest = test.extend({ diagnoseShutdown: true })

shutdownTest('default account switching and deleting the current account preserve the remaining account model', modelSettingsAcceptance('models.accounts.current-fallback'), async ({ providerGateway, managementApp, window }) => {
  await openAdd(window)
  await fillProvider(window, { name: 'First account', url: providerGateway.url('primary'), key: providerGateway.key('primary') })
  await fetchAndChoose(window, 'gpt-4o-mini')
  await saveProvider(window, 'First account')
  const first = readProviderConfiguration(managementApp.profile).sources[0]
  await openAdd(window)
  await fillProvider(window, { name: 'Second account', url: providerGateway.url('secondary'), key: providerGateway.key('secondary') })
  await fetchAndChoose(window, 'gpt-4o')
  await saveProvider(window, 'Second account')
  const second = readProviderConfiguration(managementApp.profile).sources.find(source => source.name === 'Second account')!
  expect(readProviderConfiguration(managementApp.profile).currentId).toBe(second.id)
  await sourceCard(window, 'First account').getByRole('button').first().click()
  await expect.poll(() => readProviderConfiguration(managementApp.profile).currentId).toBe(first.id)
  await expect(sourceCard(window, 'First account').getByRole('button').first()).toHaveClass(/\bbg-primary\b/)
  await sourceCard(window, 'Second account').getByRole('button').first().click()
  await expect.poll(() => readProviderConfiguration(managementApp.profile).currentId).toBe(second.id)
  await (await expandProvider(window, 'Second account')).getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(aiSection(window).getByRole('heading', { name: 'Confirm Delete', exact: true })).toBeVisible()
  await aiSection(window).getByRole('button', { name: 'Delete', exact: true }).click()
  await expect.poll(() => readProviderConfiguration(managementApp.profile).sources.length).toBe(1)
  expect(readProviderConfiguration(managementApp.profile)).toMatchObject({ currentId: first.id, sources: [{ id: first.id, name: 'First account', model: 'gpt-4o-mini' }] })
  const reopened = await managementApp.restart()
  await openSettings(reopened)
  await expect(sourceCard(reopened, 'First account').getByText('gpt-4o-mini', { exact: true })).toBeVisible()
  await expect(sourceCard(reopened, 'First account').getByRole('button').first()).toHaveClass(/\bbg-primary\b/)
  expect(readProviderConfiguration(managementApp.profile).currentId).toBe(first.id)
})
