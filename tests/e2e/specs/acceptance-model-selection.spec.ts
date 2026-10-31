import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { AISource, StoredModelSelection } from '../../../src/shared/types/ai-sources'
import {
  test, expect, modelSettingsAcceptance, aiSection, providerField, sourceCard,
  readProviderConfiguration, PROVIDER_RESPONSE, type ProviderGateway, type ProviderEndpoint,
} from '../fixtures/acceptance-model-settings'
import {
  listManagedConversations, openManagedConversation, readManagedConversation, type ManagedConversation,
} from '../fixtures/acceptance-management'
import { navigateToChat, navigateToSettings } from '../fixtures/helpers'

test.setTimeout(180000)

type SelectionConversation = Omit<ManagedConversation, 'messages'> & StoredModelSelection & {
  messages: Array<{ id: string; role: string; content: string; error?: string }>
}

async function readConversation(page: Page, id: string): Promise<SelectionConversation> {
  return await readManagedConversation(page, 'halo-temp', id) as SelectionConversation
}

async function openSettings(page: Page) {
  if (!await aiSection(page).isVisible()) await navigateToSettings(page)
}

async function addProvider(page: Page, profile: string, gateway: ProviderGateway, endpoint: ProviderEndpoint, model: string) {
  const name = `Selection ${endpoint} account`
  await openSettings(page)
  const section = aiSection(page)
  await section.getByRole('button', { name: 'Add AI Provider', exact: true }).click()
  await expect(section.getByRole('heading', { name: 'Add AI Provider', exact: true })).toBeVisible()
  await providerField(page, 'Display Name').fill(name)
  await providerField(page, 'API URL').fill(gateway.url(endpoint))
  await providerField(page, 'API Key').fill(gateway.key(endpoint))
  await section.getByRole('button', { name: 'Fetch Models', exact: true }).click()
  await expect(section.getByText('Found 2 models', { exact: true })).toBeVisible()
  await section.getByRole('button', { name: /^(gpt-4o|gpt-4o-mini)$/ }).click()
  const choices = section.locator('div.absolute').filter({ has: page.getByPlaceholder('Search models...', { exact: true }) })
  await expect(choices).toHaveCount(1)
  await choices.getByText(model, { exact: true }).click()
  await section.getByRole('button', { name: 'Test connection', exact: true }).click()
  await expect(section.getByText('Connection successful', { exact: true })).toBeVisible({ timeout: 30000 })
  await section.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(sourceCard(page, name)).toBeVisible()
  await expect(section.getByRole('heading', { name: 'Add AI Provider', exact: true })).toHaveCount(0)
  await expect.poll(() => readProviderConfiguration(profile).sources.filter(source => source.name === name).length).toBe(1)
  return readProviderConfiguration(profile).sources.find(source => source.name === name)!
}

async function setupAccounts(page: Page, profile: string, gateway: ProviderGateway) {
  const engine = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getEngineAvailability())
  expect(engine).toMatchObject({ success: true, data: { activeEngine: 'halo', degradedFrom: null } })
  const primary = await addProvider(page, profile, gateway, 'primary', 'gpt-4o')
  const secondary = await addProvider(page, profile, gateway, 'secondary', 'gpt-4o-mini')
  expect(primary.id).not.toBe(secondary.id)
  expect(readProviderConfiguration(profile).currentId).toBe(secondary.id)
  await navigateToChat(page)
  return { primary, secondary }
}

async function newConversation(page: Page, title: string) {
  const before = new Set((await listManagedConversations(page)).map(conversation => conversation.id))
  const button = page.getByRole('button', { name: 'New', exact: true })
  await expect(button).toHaveCount(1)
  await button.click()
  await expect(page.locator('.message-user')).toHaveCount(0)
  await expect.poll(async () => (await listManagedConversations(page)).filter(conversation => !before.has(conversation.id)).length).toBe(1)
  const id = (await listManagedConversations(page)).find(conversation => !before.has(conversation.id))!.id
  const active = page.locator('div.group.bg-secondary.font-medium').filter({ has: page.getByTitle('Pin', { exact: true }) })
  await expect(active).toHaveCount(1)
  await active.hover()
  await active.getByTitle('More', { exact: true }).click()
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  const input = page.getByPlaceholder('Conversation title...', { exact: true })
  await input.fill(title)
  await input.press('Enter')
  await expect.poll(async () => (await readConversation(page, id)).title).toBe(title)
  await expect(active.getByText(title, { exact: true })).toBeVisible()
  return id
}

function modelLabel(model: string): RegExp {
  // A refreshed built-in catalog supplies display names; provider requests still use wire IDs.
  if (model === 'gpt-4o') return /^(?:gpt-4o|GPT-4o)$/
  if (model === 'gpt-4o-mini') return /^(?:gpt-4o-mini|GPT-4o Mini)$/
  throw new Error(`No expected display label for fixture model ${model}`)
}

function modelButton(page: Page) {
  return page.getByRole('button', { name: /^(?:gpt-4o(?:-mini)?|GPT-4o(?: Mini)?)$/ })
}

async function selectModel(page: Page, id: string, source: AISource, model: string) {
  await expect(modelButton(page)).toHaveCount(1)
  await modelButton(page).click()
  await page.getByTitle('Switch model', { exact: true }).click()
  const account = page.getByTitle(source.name, { exact: true })
  await expect(account).toHaveCount(1)
  if (await account.getAttribute('aria-expanded') !== 'true') await account.click()
  await account.locator('..').getByRole('button', { name: modelLabel(model) }).click()
  await expect.poll(async () => {
    const conversation = await readConversation(page, id)
    return { modelSourceId: conversation.modelSourceId, modelId: conversation.modelId }
  }).toEqual({ modelSourceId: source.id, modelId: model })
  await expectModel(page, source, model)
}

async function expectModel(page: Page, source: AISource, model: string) {
  await expect(modelButton(page)).toHaveCount(1)
  await expect(modelButton(page)).toHaveAttribute('title', modelLabel(model))
  await modelButton(page).click()
  const card = page.getByTitle('Switch model', { exact: true })
  await expect(card.getByText(source.name, { exact: true })).toBeVisible()
  await expect(card.getByText(modelLabel(model))).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
}

async function waitForIdle(page: Page, id: string) {
  await expect.poll(async () => {
    const result = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.getSessionState(id), id)
    expect(result.success).toBe(true)
    return (result.data as { isActive: boolean }).isActive
  }, { timeout: 45000 }).toBe(false)
  await expect(page.getByTitle('Stop generation (Esc)', { exact: true })).toHaveCount(0)
}

function inferenceRequests(gateway: ProviderGateway, after: number) {
  return gateway.requests.slice(after).filter(request => request.method === 'POST' && /\/(chat\/completions|messages)$/.test(request.path))
}

async function sendSuccessfulTurn(page: Page, id: string, gateway: ProviderGateway, endpoint: ProviderEndpoint, model: string, question: string) {
  const before = await readConversation(page, id)
  const after = gateway.requests.length
  await page.locator('textarea').first().fill(question)
  await page.locator('[data-onboarding="send-button"]').click()
  await expect.poll(async () => (await readConversation(page, id)).messages.length, { timeout: 45000 }).toBe(before.messages.length + 2)
  await waitForIdle(page, id)
  const history = await readConversation(page, id)
  expect(history.messages.slice(0, before.messages.length)).toEqual(before.messages)
  expect(history.messages.slice(-2)).toMatchObject([
    { role: 'user', content: question }, { role: 'assistant', content: PROVIDER_RESPONSE },
  ])
  expect(history.messages.at(-1)?.error).toBeFalsy()
  await expect(page.locator('.message-assistant').last()).toContainText(PROVIDER_RESPONSE)
  const requests = inferenceRequests(gateway, after)
  expect(requests.length, 'The new turn must actually contact the selected account').toBeGreaterThan(0)
  for (const request of requests) expect(request).toMatchObject({ endpoint, model, authorized: true, status: 200 })
  return history
}

async function reopenConversation(page: Page, id: string) {
  const conversation = await readConversation(page, id)
  await openManagedConversation(page, conversation.title)
  return conversation
}

test('two conversations keep their own accounts and models through alternating turns and restart', modelSettingsAcceptance('models.selection.per-chat'), async ({ providerGateway, managementApp, window }, info) => {
  const { primary, secondary } = await setupAccounts(window, managementApp.profile, providerGateway)
  const first = await newConversation(window, 'Primary model discussion')
  await selectModel(window, first, primary, 'gpt-4o')
  await sendSuccessfulTurn(window, first, providerGateway, 'primary', 'gpt-4o', 'Primary discussion, first question.')
  const second = await newConversation(window, 'Secondary model discussion')
  expect(second).not.toBe(first)
  await selectModel(window, second, secondary, 'gpt-4o-mini')
  await sendSuccessfulTurn(window, second, providerGateway, 'secondary', 'gpt-4o-mini', 'Secondary discussion, first question.')

  const choices = [
    { id: first, source: primary, endpoint: 'primary', model: 'gpt-4o', label: 'Primary' },
    { id: second, source: secondary, endpoint: 'secondary', model: 'gpt-4o-mini', label: 'Secondary' },
  ] as const
  for (const choice of choices) {
    await reopenConversation(window, choice.id)
    await expectModel(window, choice.source, choice.model)
    expect(readProviderConfiguration(managementApp.profile).currentId).toBe(secondary.id)
    await sendSuccessfulTurn(window, choice.id, providerGateway, choice.endpoint, choice.model, `${choice.label} discussion, second question.`)
  }
  const saved = await Promise.all(choices.map(choice => readConversation(window, choice.id)))
  const reopened = await managementApp.restart()
  for (const choice of [...choices].reverse()) {
    const history = await reopenConversation(reopened, choice.id)
    expect(history).toMatchObject({ modelSourceId: choice.source.id, modelId: choice.model })
    expect(history.messages).toEqual(saved.find(conversation => conversation.id === choice.id)!.messages)
    await expectModel(reopened, choice.source, choice.model)
    expect(readProviderConfiguration(managementApp.profile).currentId).toBe(secondary.id)
    const final = await sendSuccessfulTurn(reopened, choice.id, providerGateway, choice.endpoint, choice.model, `${choice.label} discussion, question after restart.`)
    expect(final).toMatchObject({ modelSourceId: choice.source.id, modelId: choice.model })
    expect(final.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([
      `${choice.label} discussion, first question.`, `${choice.label} discussion, second question.`, `${choice.label} discussion, question after restart.`,
    ])
  }
  await info.attach('conversation-model-pins', { body: JSON.stringify(choices.map(({ id, source, model }) => ({ conversationId: id, sourceId: source.id, model }))), contentType: 'application/json' })
})

for (const state of ['removed', 'invalid'] as const) {
  test(`a pinned account that is ${state} ${state === 'removed' ? 'uses the global fallback' : 'fails without switching accounts'}`, modelSettingsAcceptance('models.selection.account-gone', 'scripted', { state }), async ({ providerGateway, managementApp, window }) => {
    const { primary, secondary } = await setupAccounts(window, managementApp.profile, providerGateway)
    const id = await newConversation(window, 'Pinned account check')
    await selectModel(window, id, primary, 'gpt-4o')
    await sendSuccessfulTurn(window, id, providerGateway, 'primary', 'gpt-4o', 'Confirm the pinned account works before its configuration changes.')
    await openSettings(window)
    await sourceCard(window, secondary.name).getByRole('button').first().click()
    await expect.poll(() => readProviderConfiguration(managementApp.profile).currentId).toBe(secondary.id)
    const card = sourceCard(window, primary.name)
    if (!await card.getByRole('button', { name: 'Edit', exact: true }).isVisible()) await card.getByText(primary.name, { exact: true }).click()
    if (state === 'removed') {
      await card.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(aiSection(window).getByRole('heading', { name: 'Confirm Delete', exact: true })).toBeVisible()
      await aiSection(window).getByRole('button', { name: 'Delete', exact: true }).click()
      await expect.poll(() => readProviderConfiguration(managementApp.profile).sources.some(source => source.id === primary.id)).toBe(false)
    } else {
      await card.getByRole('button', { name: 'Edit', exact: true }).click()
      await expect(aiSection(window).getByRole('heading', { name: 'Edit Provider', exact: true })).toBeVisible()
      await providerField(window, 'API Key').fill('invalid-local-selection-key')
      await aiSection(window).getByRole('button', { name: 'Update', exact: true }).click()
      await expect(aiSection(window).getByRole('heading', { name: 'Edit Provider', exact: true })).toHaveCount(0)
      expect(readProviderConfiguration(managementApp.profile).sources.some(source => source.id === primary.id)).toBe(true)
    }
    await sourceCard(window, secondary.name).getByRole('button').first().click()
    await expect.poll(() => readProviderConfiguration(managementApp.profile).currentId).toBe(secondary.id)
    const afterMutation = providerGateway.requests.length
    let page = window
    for (const phase of ['before restart', 'after restart']) {
      if (phase === 'after restart') page = await managementApp.restart()
      const before = await reopenConversation(page, id)
      expect(before).toMatchObject({ modelSourceId: primary.id, modelId: 'gpt-4o' })
      expect(readProviderConfiguration(managementApp.profile).currentId).toBe(secondary.id)
      await expectModel(page, state === 'removed' ? secondary : primary, state === 'removed' ? 'gpt-4o-mini' : 'gpt-4o')
      const question = `Check the ${state} pinned account ${phase}.`
      if (state === 'removed') {
        await sendSuccessfulTurn(page, id, providerGateway, 'secondary', 'gpt-4o-mini', question)
      } else {
        const after = providerGateway.requests.length
        await page.locator('textarea').first().fill(question)
        await page.locator('[data-onboarding="send-button"]').click()
        await expect.poll(async () => (await readConversation(page, id)).messages.slice(before.messages.length).some(message => message.role === 'assistant' && message.error?.includes('Invalid API key')), { timeout: 45000 }).toBe(true)
        await waitForIdle(page, id)
        const history = await readConversation(page, id)
        expect(history.messages.slice(0, before.messages.length)).toEqual(before.messages)
        expect(history.messages.slice(before.messages.length).filter(message => message.role === 'user').map(message => message.content)).toEqual([question])
        expect(history.messages.slice(before.messages.length).some(message => message.role === 'assistant' && message.content.trim() && !message.error)).toBe(false)
        const failure = history.messages.slice(before.messages.length).find(message => message.role === 'assistant' && message.error?.includes('Invalid API key'))!
        const bubble = page.locator(`[data-message-id="${failure.id}"]`)
        await expect(bubble.getByText('Something went wrong', { exact: true })).toBeVisible()
        await expect(bubble).toContainText('Invalid API key')
        const rejected = inferenceRequests(providerGateway, after)
        expect(rejected.length).toBeGreaterThan(0)
        for (const request of rejected) expect(request).toMatchObject({ endpoint: 'primary', authorized: false, status: 401 })
        expect(providerGateway.requests.slice(afterMutation).filter(request => request.endpoint === 'secondary' && request.method === 'POST')).toEqual([])
      }
      expect(await readConversation(page, id)).toMatchObject({ modelSourceId: primary.id, modelId: 'gpt-4o' })
    }
  })
}
