import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { AIGroup } from '../../../src/shared/types/ai-sources'
import {
  test, expect, modelSettingsAcceptance, aiSection, providerField, sourceCard,
  readProviderConfiguration, PROVIDER_RESPONSE, type ProviderGateway, type ProviderEndpoint,
} from '../fixtures/acceptance-model-settings'
import {
  listManagedConversations, openManagedConversation, readManagedConversation, type ManagedConversation,
} from '../fixtures/acceptance-management'
import { navigateToChat, navigateToSettings } from '../fixtures/helpers'

test.setTimeout(240000)

const GROUP_NAME = 'Model group'
const GROUP_TITLE = `${GROUP_NAME} · Auto`

type GroupConversation = Omit<ManagedConversation, 'messages'> & { modelSourceId?: string; modelId?: string } & {
  messages: Array<{ id: string; role: string; content: string; error?: string }>
}

async function readConversation(page: Page, id: string): Promise<GroupConversation> {
  return await readManagedConversation(page, 'halo-temp', id) as GroupConversation
}

async function openSettings(page: Page) {
  if (!await aiSection(page).isVisible()) await navigateToSettings(page)
}

async function addProvider(page: Page, profile: string, gateway: ProviderGateway, endpoint: ProviderEndpoint, model: string) {
  const name = `Group ${endpoint} account`
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

/** The primary account is added first, so the secondary one is the account in use. */
async function setupAccounts(page: Page, profile: string, gateway: ProviderGateway) {
  const engine = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getEngineAvailability())
  expect(engine).toMatchObject({ success: true, data: { activeEngine: 'halo', degradedFrom: null } })
  const primary = await addProvider(page, profile, gateway, 'primary', 'gpt-4o')
  const secondary = await addProvider(page, profile, gateway, 'secondary', 'gpt-4o-mini')
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

/** The header names the model in use until a group is chosen. */
function accountModelButton(page: Page) {
  return page.getByRole('button', { name: /^(?:gpt-4o(?:-mini)?|GPT-4o(?: Mini)?)$/ })
}

function groupButton(page: Page) {
  return page.getByRole('button', { name: GROUP_TITLE, exact: true })
}

async function createGroupThroughUi(page: Page, profile: string): Promise<AIGroup> {
  await openSettings(page)
  const section = aiSection(page)
  await section.getByRole('button', { name: 'More ways to add', exact: true }).click()
  await page.getByRole('button', { name: /Create Load-Balancing Group/ }).click()
  await expect(section.getByRole('heading', { name: 'Create Load-Balancing Group', exact: true })).toBeVisible()
  await section.getByRole('button', { name: 'Quick add from accounts', exact: true }).click()
  await expect(section.getByRole('listitem')).toHaveCount(2)
  await section.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(section.getByRole('heading', { name: 'Create Load-Balancing Group', exact: true })).toHaveCount(0)
  await expect.poll(() => (readProviderConfiguration(profile).groups ?? []).length).toBe(1)
  return readProviderConfiguration(profile).groups![0]
}

async function reopenConversation(page: Page, id: string) {
  const conversation = await readConversation(page, id)
  await openManagedConversation(page, conversation.title)
  return conversation
}

async function chooseGroup(page: Page, id: string, group: AIGroup) {
  await expect(accountModelButton(page)).toHaveCount(1)
  await accountModelButton(page).click()
  await page.getByTitle('Switch model', { exact: true }).click()
  const header = page.getByTitle(`${group.name} · Auto`, { exact: true })
  await expect(header).toHaveCount(1)
  if (await header.getAttribute('aria-expanded') !== 'true') await header.click()
  await page.getByRole('button', { name: /Choose automatically/ }).click()
  await expect.poll(async () => {
    const conversation = await readConversation(page, id)
    return { modelSourceId: conversation.modelSourceId, modelId: conversation.modelId }
  }).toEqual({ modelSourceId: group.id, modelId: 'halo-auto' })
  await expect(groupButton(page)).toBeVisible()
}

/** Opens the model card of the open conversation; its route line says where the group is sending it. */
async function openRoute(page: Page) {
  await groupButton(page).click()
  await expect(page.getByTitle('Switch model', { exact: true })).toBeVisible()
  return page.getByRole('status').filter({ hasText: /Picked automatically|In use for this chat|Trying another model|No model is available/ })
}

async function closeCard(page: Page) {
  await page.keyboard.press('Escape')
  await expect(page.getByTitle('Switch model', { exact: true })).toHaveCount(0)
}

async function waitForIdle(page: Page, id: string) {
  await expect.poll(async () => {
    const result = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.getSessionState(id), id)
    expect(result.success).toBe(true)
    return (result.data as { isActive: boolean }).isActive
  }, { timeout: 45000 }).toBe(false)
  await expect(page.getByTitle('Stop generation (Esc)', { exact: true })).toHaveCount(0)
}

async function memberStates(page: Page, group: AIGroup) {
  const result = await page.evaluate(groupId => (window as unknown as { halo: HaloAPI }).halo.aiGroupsHealth(groupId), group.id)
  expect(result.success).toBe(true)
  return result.data?.members ?? []
}

function inferenceRequests(gateway: ProviderGateway, after: number) {
  return gateway.requests.slice(after).filter(request => request.method === 'POST' && /\/(chat\/completions|messages)$/.test(request.path))
}

/** Sends a message and returns the inference requests the provider saw for it, once the reply is complete. */
async function sendTurn(page: Page, id: string, gateway: ProviderGateway, question: string) {
  const before = await readConversation(page, id)
  const after = gateway.requests.length
  await page.locator('textarea').first().fill(question)
  await page.locator('[data-onboarding="send-button"]').click()
  await expect.poll(async () => (await readConversation(page, id)).messages.length, { timeout: 60000 }).toBe(before.messages.length + 2)
  await waitForIdle(page, id)
  const history = await readConversation(page, id)
  expect(history.messages.slice(-2)).toMatchObject([
    { role: 'user', content: question }, { role: 'assistant', content: PROVIDER_RESPONSE },
  ])
  expect(history.messages.at(-1)?.error).toBeFalsy()
  await expect(page.locator('.message-assistant').last()).toContainText(PROVIDER_RESPONSE)
  return inferenceRequests(gateway, after).map(request => ({ endpoint: request.endpoint, model: request.model, status: request.status }))
}

test('a group is made from the accounts, chosen like a provider, and answers the chat', modelSettingsAcceptance('models.groups.create-and-choose'), async ({ providerGateway, managementApp, window }) => {
  const profile = managementApp.profile
  const { primary, secondary } = await setupAccounts(window, profile, providerGateway)

  const group = await createGroupThroughUi(window, profile)
  expect(group).toMatchObject({
    name: GROUP_NAME,
    strategy: 'priority',
    members: [{ sourceId: secondary.id, modelId: 'gpt-4o-mini' }, { sourceId: primary.id, modelId: 'gpt-4o' }],
  })
  await expect(sourceCard(window, group.name)).toBeVisible()
  // Making a group changes nothing that is already in use.
  expect(readProviderConfiguration(profile).currentId).toBe(secondary.id)
  expect(readProviderConfiguration(profile).currentGroupId ?? null).toBeNull()

  await navigateToChat(window)
  const id = await newConversation(window, 'Group chat')
  await chooseGroup(window, id, group)
  // The choice is remembered for new chats; the account in use stays as it was.
  await expect.poll(() => readProviderConfiguration(profile)).toMatchObject({ currentId: secondary.id, currentGroupId: group.id })

  // Nothing has been sent, so the card does not guess which model will answer.
  await expect(await openRoute(window)).toContainText('Picked automatically when you send')
  await closeCard(window)

  // The first model in the order answers, and the card names its account.
  expect(await sendTurn(window, id, providerGateway, 'Which model answers this?')).toEqual([
    { endpoint: 'secondary', model: 'gpt-4o-mini', status: 200 },
  ])
  const route = await openRoute(window)
  await expect(route).toContainText('In use for this chat')
  await expect(route).toContainText(secondary.name)
  await closeCard(window)

  // The group and the conversation's choice survive a restart.
  const reopened = await managementApp.restart()
  await reopenConversation(reopened, id)
  await expect(groupButton(reopened)).toBeVisible()
  expect(readProviderConfiguration(profile).groups ?? []).toHaveLength(1)
  expect(await readConversation(reopened, id)).toMatchObject({ modelSourceId: group.id, modelId: 'halo-auto' })

  // A new chat starts on the group chosen last.
  const next = await newConversation(reopened, 'Next chat')
  expect(await readConversation(reopened, next)).toMatchObject({ modelSourceId: group.id, modelId: 'halo-auto' })
})

test('a rate-limited model is passed over without the chat ever seeing an error', modelSettingsAcceptance('models.groups.failover'), async ({ providerGateway, managementApp, window }) => {
  const profile = managementApp.profile
  const { primary, secondary } = await setupAccounts(window, profile, providerGateway)
  const group = await createGroupThroughUi(window, profile)
  await navigateToChat(window)
  const id = await newConversation(window, 'Failover chat')
  await chooseGroup(window, id, group)

  // The first model of the group (the secondary account's) is rate limited; the other answers.
  providerGateway.respond(request => request.body.model === 'gpt-4o-mini'
    ? { failure: { status: 429, type: 'rate_limit_error', message: 'Too many requests' } }
    : { text: PROVIDER_RESPONSE })

  expect(await sendTurn(window, id, providerGateway, 'The first model is busy.')).toEqual([
    { endpoint: 'secondary', model: 'gpt-4o-mini', status: 429 },
    { endpoint: 'primary', model: 'gpt-4o', status: 200 },
  ])
  const history = await readConversation(window, id)
  expect(history.messages.some(message => message.error)).toBe(false)
  await expect(window.getByText('Something went wrong', { exact: true })).toHaveCount(0)

  const route = await openRoute(window)
  await expect(route).toContainText('In use for this chat')
  await expect(route).toContainText(primary.name)
  await closeCard(window)

  // The busy model is resting, so the next message goes straight to the one that works.
  expect(await memberStates(window, group)).toEqual(expect.arrayContaining([
    expect.objectContaining({ sourceId: secondary.id, modelId: 'gpt-4o-mini', state: 'resting', reason: 'rate' }),
    expect.objectContaining({ sourceId: primary.id, modelId: 'gpt-4o', state: 'ready' }),
  ]))
  expect(await sendTurn(window, id, providerGateway, 'Carry on where it works.')).toEqual([
    { endpoint: 'primary', model: 'gpt-4o', status: 200 },
  ])
  expect(await readConversation(window, id)).toMatchObject({ modelSourceId: group.id, modelId: 'halo-auto' })
})

test('deleting a group leaves the accounts, and its chats follow the default model', modelSettingsAcceptance('models.groups.delete'), async ({ providerGateway, managementApp, window }) => {
  const profile = managementApp.profile
  const { primary, secondary } = await setupAccounts(window, profile, providerGateway)
  const group = await createGroupThroughUi(window, profile)
  await navigateToChat(window)
  const id = await newConversation(window, 'Deleted group chat')
  await chooseGroup(window, id, group)
  await sendTurn(window, id, providerGateway, 'Answer through the group first.')

  await openSettings(window)
  const card = sourceCard(window, group.name)
  await card.getByText(group.name, { exact: true }).click()
  await card.getByRole('button', { name: 'Delete', exact: true }).click()
  const confirmation = window.getByRole('alertdialog')
  await expect(confirmation).toContainText('Delete this group?')
  await confirmation.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect.poll(() => readProviderConfiguration(profile).groups ?? []).toEqual([])

  const saved = readProviderConfiguration(profile)
  expect(saved.sources.map(source => source.id).sort()).toEqual([primary.id, secondary.id].sort())
  expect(saved.currentId).toBe(secondary.id)
  expect(saved.currentGroupId ?? null).toBeNull()

  // The chat keeps its stored choice, shows the default model it now runs on, and uses that account.
  await reopenConversation(window, id)
  expect(await readConversation(window, id)).toMatchObject({ modelSourceId: group.id, modelId: 'halo-auto' })
  await expect(accountModelButton(window)).toHaveCount(1)
  expect(await sendTurn(window, id, providerGateway, 'Now the default model answers.')).toEqual([
    { endpoint: 'secondary', model: 'gpt-4o-mini', status: 200 },
  ])
})
