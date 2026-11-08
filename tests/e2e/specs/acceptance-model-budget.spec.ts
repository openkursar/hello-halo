import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page, TestInfo } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { ImageAttachment } from '../../../src/shared/types/image-attachment'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle, readAcceptanceConversation, type AcceptanceApp } from '../fixtures/acceptance-app'
import type { AcceptanceModel } from '../fixtures/acceptance-model'
import { aiSection, providerField, sourceCard, readProviderConfiguration } from '../fixtures/acceptance-model-settings'
import { navigateToChat, navigateToSettings } from '../fixtures/helpers'
import { listManagedConversations } from '../fixtures/acceptance-management'

test.setTimeout(120000)
test.use({ startupObserver: resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/model-budget-observer.cjs') })

type Engine = 'halo' | 'anthropic'
type Budget = { contextWindow: number; maxOutputTokens: number }
type PersistedConversation = {
  messages: Array<{ id: string; role: string; content: string; images?: ImageAttachment[] }>
}
const defaults: Budget = { contextWindow: 200000, maxOutputTokens: 64000 }

async function addAccount(page: Page, model: AcceptanceModel, id: string, name = 'Budget account', preset = false) {
  if (!await aiSection(page).isVisible()) await navigateToSettings(page)
  const section = aiSection(page)
  await section.getByRole('button', { name: 'Add AI Provider', exact: true }).click()
  if (preset) {
    await section.getByRole('button').filter({ hasText: 'OpenAI' }).first().click()
    await section.getByPlaceholder('Search providers...').fill('DeepSeek')
    await section.getByRole('button').filter({ hasText: 'DeepSeek' }).last().click()
  }
  await providerField(page, 'Display Name').fill(name)
  await providerField(page, 'API URL').fill(`${model.url}/v1`)
  await providerField(page, 'API Key').fill('local-scripted-endpoint')
  if (!preset) {
    await section.getByLabel('Use custom model ID', { exact: true }).check()
    await section.getByPlaceholder('Enter model ID', { exact: true }).fill(id)
    await section.getByRole('button', { name: 'Apply', exact: true }).click()
  }
  await openBudget(page)
}

async function openBudget(page: Page) {
  const toggle = aiSection(page).getByRole('button', { name: 'Model Configuration', exact: true })
  const field = providerField(page, 'Context Window')
  await expect(toggle).toBeVisible()
  // Capability loading can auto-expand the panel. Only click a collapsed toggle,
  // and re-check after a racing auto-expand rather than blindly toggling it shut.
  await expect(async () => {
    const collapsed = toggle.filter({ has: page.locator('svg.lucide-chevron-right') })
    if (await collapsed.count()) await collapsed.click({ timeout: 1000 })
    await expect(toggle.locator('svg.lucide-chevron-down')).toBeVisible({ timeout: 1000 })
    await expect(aiSection(page).getByText('Loading model capabilities...', { exact: true })).toHaveCount(0, { timeout: 1000 })
    await expect(field).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 15000, intervals: [100, 250, 500] })
}

async function inspectBudget(page: Page, budget: Budget) {
  await expect(providerField(page, 'Context Window')).toHaveValue(String(budget.contextWindow))
  await expect(providerField(page, 'Max Output Tokens')).toHaveValue(String(budget.maxOutputTokens))
}

async function editAccount(page: Page, name = 'Budget account') {
  if (!await aiSection(page).isVisible()) await navigateToSettings(page)
  const card = sourceCard(page, name)
  if (!await card.getByRole('button', { name: 'Edit', exact: true }).isVisible()) await card.getByText(name, { exact: true }).click()
  await card.getByRole('button', { name: 'Edit', exact: true }).click()
  await openBudget(page)
}

async function saveAccount(page: Page, name = 'Budget account', action = 'Save') {
  await aiSection(page).getByRole('button', { name: action, exact: true }).click()
  await expect(sourceCard(page, name)).toBeVisible()
  await expect(aiSection(page).getByRole('heading', { name: /^(Add AI Provider|Edit Provider)$/ })).toHaveCount(0)
}

async function restartEngine(app: AcceptanceApp, engine: Engine) {
  const selectedPath = process.env.HALO_ACCEPTANCE_CLAUDE_CLI
  if (engine === 'anthropic' && (!selectedPath || !existsSync(selectedPath))) throw new Error('Blocked prerequisite: HALO_ACCEPTANCE_CLAUDE_CLI must name an installed external Claude Code')
  const page = await app.restart(profile => {
    const file = join(profile, '.halo/config.json')
    const config = JSON.parse(readFileSync(file, 'utf8'))
    config.agent = { ...config.agent, sdkEngine: engine, ...(engine === 'anthropic' ? { ccRuntime: { selectedPath, selectionOrigin: 'user' } } : {}) }
    writeFileSync(file, JSON.stringify(config))
  })
  const availability = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getEngineAvailability())
  expect(availability).toMatchObject({ success: true, data: { activeEngine: engine, degradedFrom: null } })
  return page
}

async function selectBudgetModel(app: AcceptanceApp, page: Page, id: string) {
  await navigateToChat(page)
  // Existing conversations retain their engine when the global default changes.
  const before = new Set((await listManagedConversations(page)).map(conversation => conversation.id))
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await expect.poll(async () => (await listManagedConversations(page)).filter(conversation => !before.has(conversation.id)).length).toBe(1)
  await expect(page.locator('.message-user')).toHaveCount(0)
  const source = readProviderConfiguration(app.profile).sources.find(item => item.name === 'Budget account')!
  expect(source.model).toBe(id)
  const label = source.availableModels?.find(model => model.id === id)?.name || id
  const picker = page.locator('button[aria-label][title]').filter({ has: page.locator('svg.lucide-chevron-down') })
  await expect(picker).toHaveCount(1)
  await picker.click()
  await page.getByTitle('Switch model', { exact: true }).click()
  const account = page.getByTitle(source.name, { exact: true })
  if (await account.getAttribute('aria-expanded') !== 'true') await account.click()
  await account.locator('..').getByRole('button', { name: label, exact: true }).click()
  await expect(page.getByTitle('Switch model', { exact: true })).toHaveCount(0)
  await expect(picker).toHaveAttribute('title', label)
}

async function sendBudget(app: AcceptanceApp, page: Page, model: AcceptanceModel, id: string, budget: Budget, engine: Engine, info: TestInfo) {
  model.respond(() => ({ text: 'Model budget received.' }))
  await selectBudgetModel(app, page, id)
  const marker = `Budget verification ${randomUUID()}`
  const turn = await sendAcceptanceMessage(page, marker)
  await expect(page.locator('.message-assistant').last()).toContainText('Model budget received.', { timeout: 45000 })
  await waitForAcceptanceIdle(page, turn.conversationId)
  const requests = model.exchanges.filter(exchange => exchange.request.lastUserText.includes(marker))
  expect(requests.length).toBeGreaterThan(0)
  for (const { request } of requests) {
    expect(request.body.model).toBe(id)
    expect(request.body.max_tokens).toBe(budget.maxOutputTokens)
  }
  const observations = await app.app.evaluate(() => (globalThis as unknown as { modelBudgetObservations: Array<Budget & { engine: string }> }).modelBudgetObservations)
  await info.attach('engine-budget-boundary', { body: JSON.stringify(observations), contentType: 'application/json' })
  // Extended-context decoration belongs to the engine ID, never the wire or saved selection.
  const engineModel = budget.contextWindow > 200000 ? `${id}[1m]` : id
  expect(observations).toContainEqual(expect.objectContaining({ engine, ...budget, ...(engine === 'halo' ? { model: engineModel } : {}) }))
  const file = join(app.profile, '.halo/temp/conversations', `${turn.conversationId}.json`)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ engineBinding: { engineId: engine }, modelId: id })
  return turn
}

for (const engine of ['halo', 'anthropic'] as const) {
  for (const id of ['unknown-future-model', 'deepseek-future', 'qwen-future', 'kimi-future', 'minimax-future', 'grok-future', 'mistral-future', 'llama-future']) {
    test(`${engine} uses the displayed default budget for ${id}`, acceptance('models.configuration.defaults', { engine, model: id }), async ({ acceptanceApp, model, window }, info) => {
      await addAccount(window, model, id)
      await inspectBudget(window, defaults)
      await saveAccount(window)
      const page = await restartEngine(acceptanceApp, engine)
      await sendBudget(acceptanceApp, page, model, id, defaults, engine, info)
    })
  }

  for (const source of ['legacy-model', 'legacy-generation', 'provider-catalog']) {
    test(`${engine} retains ${source} lower limits`, acceptance('models.configuration.lower-limits', { engine, source }), async ({ acceptanceApp, model, window }, info) => {
      const id = source === 'legacy-model' ? 'deepseek-chat' : source === 'legacy-generation' ? 'claude-3-opus-20240229' : 'deepseek-future'
      const budget = source === 'legacy-generation' ? { contextWindow: 200000, maxOutputTokens: 4096 } : { contextWindow: 128000, maxOutputTokens: 8192 }
      await addAccount(window, model, id)
      if (source !== 'provider-catalog') await inspectBudget(window, budget)
      await saveAccount(window)
      let page = window
      if (source === 'provider-catalog') {
        // A stored provider catalog is an input precondition, not a capability override.
        page = await acceptanceApp.restart(profile => {
          const file = join(profile, '.halo/config.json')
          const config = JSON.parse(readFileSync(file, 'utf8'))
          const account = config.aiSources.sources.find((item: { name: string }) => item.name === 'Budget account')
          account.availableModels = [{ id, name: id, capabilities: budget }]
          writeFileSync(file, JSON.stringify(config))
        })
        await editAccount(page)
        await inspectBudget(page, budget)
        await saveAccount(page, 'Budget account', 'Update')
      }
      page = await restartEngine(acceptanceApp, engine)
      await sendBudget(acceptanceApp, page, model, id, budget, engine, info)
    })
  }

  for (const choice of ['lower', 'higher']) {
    test(`${engine} retains ${choice} explicit budget and disabled capabilities after restart`, acceptance('models.configuration.overrides', { engine, budget: choice }), async ({ acceptanceApp, model, window }, info) => {
      const id = 'deepseek-v4.1-flash'
      const budget = choice === 'lower' ? { contextWindow: 128000, maxOutputTokens: 32000 } : { contextWindow: 300000, maxOutputTokens: 96000 }
      await addAccount(window, model, id)
      await providerField(window, 'Context Window').fill(String(budget.contextWindow))
      await providerField(window, 'Max Output Tokens').fill(String(budget.maxOutputTokens))
      await aiSection(window).getByLabel('Vision', { exact: true }).uncheck()
      await aiSection(window).getByLabel('Thinking', { exact: true }).uncheck()
      await saveAccount(window)
      const saved = readProviderConfiguration(acceptanceApp.profile).sources.find(item => item.name === 'Budget account')!
      const page = await restartEngine(acceptanceApp, engine)
      await editAccount(page)
      await inspectBudget(page, budget)
      await expect(aiSection(page).getByLabel('Vision', { exact: true })).not.toBeChecked()
      await expect(aiSection(page).getByLabel('Thinking', { exact: true })).not.toBeChecked()
      expect(readProviderConfiguration(acceptanceApp.profile).sources.find(item => item.id === saved.id)).toMatchObject({ model: id, modelOverrides: { [id]: { ...budget, vision: false, thinking: false } } })
      await aiSection(page).getByRole('button', { name: 'Cancel', exact: true }).click()
      await sendBudget(acceptanceApp, page, model, id, budget, engine, info)
    })
  }
}

test('the DeepSeek preset creates Flash without rewriting an existing account', acceptance('models.accounts.deepseek-preset'), async ({ acceptanceApp, model }, info) => {
  const seededPage = await acceptanceApp.restart(profile => {
    const file = join(profile, '.halo/config.json')
    const config = JSON.parse(readFileSync(file, 'utf8'))
    // Seed the persisted pre-update account while the application is closed.
    config.aiSources.sources.push({
      id: 'existing-deepseek', name: 'Existing DeepSeek', authType: 'api-key',
      provider: 'openai', providerId: 'deepseek', apiUrl: `${model.url}/v1`,
      apiKey: 'local-scripted-endpoint', model: 'deepseek-v4-flash',
      availableModels: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
      modelOverrides: { 'deepseek-v4-flash': { contextWindow: 208000, maxOutputTokens: 8192, vision: false } },
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z'
    })
    writeFileSync(file, JSON.stringify(config))
  })
  const existing = readProviderConfiguration(acceptanceApp.profile).sources.find(item => item.name === 'Existing DeepSeek')!
  await addAccount(seededPage, model, 'deepseek-flash', 'Budget account', true)
  await inspectBudget(seededPage, defaults)
  await expect(aiSection(seededPage).getByLabel('Vision', { exact: true })).toBeChecked()
  await expect(aiSection(seededPage).getByLabel('Thinking', { exact: true })).toBeChecked()
  await saveAccount(seededPage)
  const page = await restartEngine(acceptanceApp, 'halo')
  expect(readProviderConfiguration(acceptanceApp.profile).sources.find(item => item.id === existing.id)).toMatchObject({ model: 'deepseek-v4-flash', modelOverrides: existing.modelOverrides })
  await editAccount(page, 'Existing DeepSeek')
  await inspectBudget(page, { contextWindow: 208000, maxOutputTokens: 8192 })
  await expect(aiSection(page).getByLabel('Vision', { exact: true })).not.toBeChecked()
  await aiSection(page).getByRole('button', { name: 'Cancel', exact: true }).click()
  await sendBudget(acceptanceApp, page, model, 'deepseek-flash', defaults, 'halo', info)
})

for (const enabled of [true, false]) {
  const models = enabled ? ['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'Pro/deepseek-ai/DeepSeek-V4.1-Flash'] : ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-pro', 'deepseek-v4.1-flash']
  for (const id of models) {
    test(`${id} ${enabled ? 'delivers' : 'excludes'} raw image content`, acceptance(`chat.attachments.${enabled ? 'deepseek-flash' : 'vision-disabled'}`, { model: id }), async ({ acceptanceApp, model, window }) => {
      await addAccount(window, model, id)
      if (!enabled && id === 'deepseek-v4.1-flash') await aiSection(window).getByLabel('Vision', { exact: true }).uncheck()
      await expect(aiSection(window).getByLabel('Vision', { exact: true })).toBeChecked({ checked: enabled })
      await saveAccount(window)
      const page = await restartEngine(acceptanceApp, 'halo')
      model.respond(() => ({ text: 'Attachment request received.' }))
      await selectBudgetModel(acceptanceApp, page, id)
      const marker = `Image ${randomUUID()}`
      const imageData = await page.evaluate(marker => {
        const canvas = document.createElement('canvas')
        canvas.width = 480
        canvas.height = 40
        const context = canvas.getContext('2d')!
        context.fillStyle = 'white'
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.fillStyle = 'black'
        context.fillText(marker, 8, 24)
        return canvas.toDataURL('image/png').split(',')[1]
      }, marker)
      const png = Buffer.from(imageData, 'base64')
      await page.locator('input[type="file"]').setInputFiles({ name: `${marker}.png`, mimeType: 'image/png', buffer: png })
      await expect(page.getByTitle('Remove image', { exact: true })).toBeVisible()
      const guidance = page.getByText('Current model has no vision — images will be read via local OCR (text only)', { exact: true })
      if (enabled) await expect(guidance).toHaveCount(0)
      else await expect(guidance).toBeVisible()
      const turn = await sendAcceptanceMessage(page, marker)
      await expect(page.locator('.message-assistant').last()).toContainText('Attachment request received.', { timeout: 45000 })
      await waitForAcceptanceIdle(page, turn.conversationId)
      const exchanges = model.exchanges.filter(item => item.request.lastUserText.includes(marker))
      expect(exchanges.length).toBeGreaterThan(0)
      const saved = await readAcceptanceConversation(page, turn.spaceId, turn.conversationId)
      const file = join(acceptanceApp.profile, '.halo/temp/conversations', `${turn.conversationId}.json`)
      // Desktop history returns file URLs; the persisted record retains the image bytes.
      const persisted = JSON.parse(readFileSync(file, 'utf8')) as PersistedConversation
      const user = persisted.messages.find(item => item.role === 'user' && item.content.includes(marker))!
      expect(user.images).toHaveLength(1)
      const image = user.images![0]
      expect(image.data).toEqual(expect.any(String))
      expect(image.data!.length).toBeGreaterThan(0)
      expect(saved.messages.find(item => item.id === user.id)?.images).toEqual([
        expect.objectContaining({ id: image.id, mediaType: image.mediaType })
      ])
      for (const { request } of exchanges) {
        expect(request.body.model).toBe(id)
        const images = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'image' || part.type === 'image_url')
        expect(images.length).toBe(enabled ? 1 : 0)
        if (enabled) expect(JSON.stringify(images)).toContain(image.data)
      }
      const reopened = await acceptanceApp.restart()
      expect((await readAcceptanceConversation(reopened, turn.spaceId, turn.conversationId)).messages).toEqual(saved.messages)
      expect(JSON.parse(readFileSync(file, 'utf8')).messages).toEqual(persisted.messages)
      await editAccount(reopened)
      await expect(aiSection(reopened).getByLabel('Vision', { exact: true })).toBeChecked({ checked: enabled })
      const account = readProviderConfiguration(acceptanceApp.profile).sources.find(item => item.name === 'Budget account')!
      expect(account.model).toBe(id)
    })
  }
}
