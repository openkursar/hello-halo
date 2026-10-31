import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { AISourcesConfig } from '../../../src/shared/types/ai-sources'
import { test as base, expect, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { readManagedConversation } from '../fixtures/acceptance-management'
import { aiSection, providerField, sourceCard, startProviderGateway, PROVIDER_RESPONSE, type ProviderGateway, type ProviderEndpoint } from '../fixtures/acceptance-model-settings'
import { aiSourceMigrationCount, installLegacyAiSources, legacyAiSourcesIdentity, readAiSourceMigration } from '../fixtures/acceptance-ai-sources-migration'
import { navigateToChat, navigateToSettings } from '../fixtures/helpers'

const test = base.extend<{ historicalProvider: ProviderGateway }>({
  historicalProvider: [async ({}, use, info) => {
    const gateway = await startProviderGateway()
    try { await use(gateway) }
    finally {
      await gateway.close()
      await info.attach('historical-provider-request-metadata', { body: JSON.stringify(gateway.requests, null, 2), contentType: 'application/json' })
      expect(gateway.errors).toEqual([])
    }
  }, { auto: true }],
})

test.setTimeout(180000)

async function inspectAccount(page: Page, profile: string, expected: ReturnType<typeof installLegacyAiSources>, apiKey: string) {
  const config = readAiSourceMigration(profile)
  expect(config.version).toBe(2)
  expect(config.sources).toHaveLength(1)
  const [account] = config.sources
  expect(account).toMatchObject({ name: expected.account.name, provider: 'openai', authType: 'api-key', apiUrl: expected.account.apiUrl, model: expected.account.model, hasCredential: true })
  expect(account.models).toEqual(expect.arrayContaining(expected.account.availableModels))
  expect(account.models).toContain(expected.account.model)
  expect(new Set(account.models).size).toBe(account.models.length)
  const catalog = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.authGetBuiltinProviders())
  expect(catalog.success).toBe(true)
  const providers = (catalog.data as Array<{ id: string; models: Array<{ id: string }> }>).filter(provider => provider.id === 'openai')
  expect(providers).toHaveLength(1)
  const builtinModels = providers[0].models.map(model => model.id).sort()
  const addedModels = account.models.filter((id: string) => !expected.account.availableModels.includes(id))
  expect(builtinModels).toEqual(expect.arrayContaining(addedModels))
  expect(account.id).toEqual(expect.any(String))
  expect(account.id).not.toBe('')
  if (expected.account.id) expect(account.id).toBe(expected.account.id)
  expect(config.currentId).toBe(account.id)
  expect(Number.isFinite(Date.parse(account.createdAt as string))).toBe(true)
  expect(config.control).toMatchObject(expected.control)
  const live = await page.evaluate(async expectedKey => {
    const response = await (window as unknown as { halo: HaloAPI }).halo.getConfig()
    const sources = (response.data as { aiSources?: AISourcesConfig } | undefined)?.aiSources
    return { success: response.success, version: sources?.version, currentId: sources?.currentId, ids: sources?.sources.map(source => source.id), credentialMatches: sources?.sources.length === 1 && sources.sources[0].apiKey === expectedKey }
  }, apiKey)
  expect(live).toEqual({ success: true, version: 2, currentId: account.id, ids: [account.id], credentialMatches: true })
  return { ...account, catalog: { reportedBy: 'authGetBuiltinProviders', providerId: 'openai', builtinModels, addedModels } }
}

async function inspectSettings(page: Page, expected: ReturnType<typeof installLegacyAiSources>, key: string) {
  await navigateToSettings(page)
  const card = sourceCard(page, expected.account.name!)
  await expect(card).toHaveCount(1)
  await expect(card).toHaveClass(/border-primary\/50/)
  await expect(card).toContainText(expected.account.model)
  if (!await card.getByRole('button', { name: 'Edit', exact: true }).isVisible()) await card.getByText(expected.account.name!, { exact: true }).click()
  await card.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(aiSection(page).getByRole('heading', { name: 'Edit Provider', exact: true })).toBeVisible()
  await expect(providerField(page, 'Display Name')).toHaveValue(expected.account.name!)
  await expect(providerField(page, 'API URL')).toHaveValue(expected.account.apiUrl)
  expect(await providerField(page, 'API Key').evaluate((input, expectedKey) => (input as HTMLInputElement).value === expectedKey, key)).toBe(true)
  await aiSection(page).getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(aiSection(page).getByRole('heading', { name: 'Edit Provider', exact: true })).toHaveCount(0)
}

async function sendThroughMigratedAccount(page: Page, gateway: ProviderGateway, endpoint: ProviderEndpoint, sourceId: string, question: string) {
  await navigateToChat(page)
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await expect(page.locator('.message-user')).toHaveCount(0)
  const start = gateway.requests.length
  const turn = await sendAcceptanceMessage(page, question)
  await expect(page.locator('.message-assistant').last()).toContainText(PROVIDER_RESPONSE)
  await waitForAcceptanceIdle(page, turn.conversationId)
  const inference = gateway.requests.slice(start).filter(request => request.method === 'POST' && /\/(?:chat\/completions|messages)$/.test(request.path))
  expect(inference).toHaveLength(1)
  expect(inference[0]).toMatchObject({ endpoint, model: 'gpt-4o-mini', authorized: true, status: 200 })
  const stored = await readManagedConversation(page, turn.spaceId, turn.conversationId)
  expect(stored).toMatchObject({ modelSourceId: sourceId, modelId: 'gpt-4o-mini' })
  expect(stored.messages.map(message => ({ role: message.role, content: message.content }))).toEqual([{ role: 'user', content: question }, { role: 'assistant', content: PROVIDER_RESPONSE }])
  return { ...turn, messages: stored.messages, request: inference[0] }
}

test('legacy custom API accounts retain their settings and credential semantics through a real migration and restart', {
  annotation: { type: 'acceptance', description: JSON.stringify({ caseId: 'lifecycle.install.migrate', evidence: 'integration', mode: 'scripted', variant: { dataset: 'ai-sources-v1' } }) },
}, async ({ historicalProvider, acceptanceApp, model }, info) => {
  const records: Array<Record<string, unknown>> = []
  const ids: string[] = []
  try {
    for (const hasIdentity of [true, false]) {
      const endpoint = hasIdentity ? 'primary' : 'secondary'
      const migrationsBefore = aiSourceMigrationCount(acceptanceApp.profile)
      const child = acceptanceApp.app.process()
      let historical!: ReturnType<typeof installLegacyAiSources>
      let page = await acceptanceApp.restart(profile => {
        historical = installLegacyAiSources(profile, child, `${historicalProvider.url(endpoint)}/chat/completions`, historicalProvider.key(endpoint), hasIdentity)
      })
      const record: Record<string, unknown> = { identity: hasIdentity ? 'retained' : 'assigned', endpoint, historical }
      records.push(record)
      const account = await inspectAccount(page, acceptanceApp.profile, historical, historicalProvider.key(endpoint))
      if (!hasIdentity) expect(ids).not.toContain(account.id)
      ids.push(account.id as string)
      expect(aiSourceMigrationCount(acceptanceApp.profile)).toBe(migrationsBefore + 1)
      await inspectSettings(page, historical, historicalProvider.key(endpoint))
      const first = await sendThroughMigratedAccount(page, historicalProvider, endpoint, account.id as string, `Verify the ${hasIdentity ? 'retained' : 'assigned'} migrated account before reopening.`)
      record.account = account
      record.first = first
      expect(model.exchanges).toHaveLength(0)

      page = await acceptanceApp.restart()
      const reopened = await inspectAccount(page, acceptanceApp.profile, historical, historicalProvider.key(endpoint))
      expect(reopened).toEqual(account)
      expect(aiSourceMigrationCount(acceptanceApp.profile)).toBe(migrationsBefore + 1)
      expect((await readManagedConversation(page, first.spaceId, first.conversationId)).messages).toEqual(first.messages)
      await inspectSettings(page, historical, historicalProvider.key(endpoint))
      const second = await sendThroughMigratedAccount(page, historicalProvider, endpoint, account.id as string, `Verify the ${hasIdentity ? 'retained' : 'assigned'} migrated account in a fresh conversation after reopening.`)
      expect(second.conversationId).not.toBe(first.conversationId)
      expect((await readManagedConversation(page, first.spaceId, first.conversationId)).messages).toEqual(first.messages)
      record.second = second
      expect(model.exchanges).toHaveLength(0)
    }
  } finally {
    await info.attach('ai-sources-v1-migration-evidence', { body: JSON.stringify({ fixture: legacyAiSourcesIdentity(), records }, null, 2), contentType: 'application/json' })
  }
})
