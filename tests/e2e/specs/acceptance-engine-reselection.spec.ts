import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { openManagedConversation, seedManagedConversation, seedManagedSpace } from '../fixtures/acceptance-management'
import { seedDigitalHumanChat, type SeededDigitalHumanChat } from '../fixtures/seed-digital-human-chat'
import { navigateToChat, openDigitalHumanConversation } from '../fixtures/helpers'
import { test as automationTest, openAutomation, startAutomation, waitForAutomationResult, readAutomationActivity, readAutomationPerson } from '../fixtures/acceptance-automation'
import { modelTool } from '../fixtures/acceptance-model'
import { assertEngineDiscovery, engineDiscoveryObserver, readCcAvailability, reselectAutomaticCcInstallation, seedAutomaticCcInstallation } from '../fixtures/acceptance-engine-upgrade'

const caseId = 'models.engines.reselect-automatic-installation'
test.use({ startupObserver: engineDiscoveryObserver })
automationTest.use({ startupObserver: engineDiscoveryObserver })
test.setTimeout(120000)
automationTest.setTimeout(120000)

async function setPersonOverride(page: Page, appId: string) {
  const result = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appUpdateOverrides({ appId, overrides: { engineId: 'anthropic', notificationLevel: 'none' } }), appId)
  expect(result.success).toBe(true)
}

async function failChatBeforeSelection(page: Page) {
  await expect(page.getByText('Claude Code is selected for this conversation. Select a Claude Code installation once in Settings > Advanced, even if the same installation is already listed. Your history and engine choice are kept.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Select Claude Code in Settings', exact: true })).toBeEnabled()
  await page.locator('textarea').first().fill('Reply without tools before installation selection.')
  await page.locator('[data-onboarding="send-button"]').click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { acceptanceProbe: { errors: unknown[] } }).acceptanceProbe.errors)).not.toEqual([])
  await expect(page.getByRole('button', { name: 'Select Claude Code in Settings', exact: true })).toBeEnabled()
  const errors = await page.evaluate(() => (window as unknown as { acceptanceProbe: { errors: unknown[] } }).acceptanceProbe.errors)
  expect(JSON.stringify(errors)).toContain('Claude Code')
  expect(JSON.stringify(errors)).not.toContain('Engine \\"anthropic\\"')
  return errors
}

for (const entry of ['space-chat', 'digital-human'] as const) {
  test(`reselect the recorded installation from ${entry}`, acceptance(caseId, { entry }), async ({ acceptanceApp, window, model }, info) => {
    let seeded!: SeededDigitalHumanChat
    let space: { id: string; path: string } | undefined
    let target: { id: string; title: string } | undefined
    let selectedPath!: string
    let conversationFile!: string
    let mapFile!: string
    if (entry === 'space-chat') {
      space = await seedManagedSpace(window, 'Installation recovery')
      target = await seedManagedConversation(window, space.id, 'Keep this CC conversation', [{ role: 'user', content: 'Preserve the cedar reference.' }])
      conversationFile = join(space.path, '.halo', 'conversations', `${target.id}.json`)
    }
    let page = await acceptanceApp.restart(profile => {
      selectedPath = seedAutomaticCcInstallation(profile)
      if (entry === 'space-chat') {
        const stored = JSON.parse(readFileSync(conversationFile, 'utf8'))
        stored.engineOverride = 'anthropic'
        writeFileSync(conversationFile, JSON.stringify(stored))
      } else {
        seeded = seedDigitalHumanChat(profile, { name: 'Independent CC recorder', turnCount: 3 })
        mapFile = join(dirname(seeded.transcriptPath), '_session-ids.json')
      }
    })
    if (entry === 'digital-human') {
      await expect.poll(() => page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.appGetOverview().then(result => result.success))).toBe(true)
      await setPersonOverride(page, seeded.appId)
      page = await acceptanceApp.restart()
    }
    const openOriginal = async (returning = false) => {
      if (entry === 'space-chat') await openManagedConversation(page, target!.title, space!.id)
      else {
        await navigateToChat(page)
        if (!returning) await openDigitalHumanConversation(page, seeded.name, seeded.turns[2].reply.slice(0, 20))
        await expect(page.locator('.message-user').first()).toContainText(seeded.turns[0].user)
      }
    }
    await openOriginal()
    const expectedErrors = await failChatBeforeSelection(page)
    expect(model.exchanges).toHaveLength(0)
    await reselectAutomaticCcInstallation(acceptanceApp, page, info, selectedPath, true)
    await openOriginal(true)
    const prompt = 'Continue the original conversation without using tools.'
    model.respond(() => ({ text: 'The original conversation completed on the selected installation.' }))
    const turn = await sendAcceptanceMessage(page, prompt)
    const id = entry === 'space-chat' ? target!.id : seeded.conversationId
    expect(turn.conversationId).toBe(id)
    await expect(page.locator('.message-assistant').last()).toContainText('The original conversation completed on the selected installation.')
    await waitForAcceptanceIdle(page, id, { expectedErrors })
    expect(model.exchanges.some(exchange => exchange.request.lastUserText.includes(prompt))).toBe(true)
    if (entry === 'space-chat') {
      const stored = JSON.parse(readFileSync(conversationFile, 'utf8'))
      expect(stored.engineOverride).toBe('anthropic')
      expect(stored.engineBinding.engineId).toBe('anthropic')
      expect(stored.messages[0].content).toBe('Preserve the cedar reference.')
    } else {
      await expect.poll(() => JSON.parse(readFileSync(mapFile, 'utf8')).chat?.engineId).toBe('anthropic')
      expect((await readAutomationPerson(page, seeded.appId)).userOverrides.engineId).toBe('anthropic')
      expect(readFileSync(seeded.transcriptPath, 'utf8')).toContain(seeded.turns[0].user)
    }
    expect(await readCcAvailability(page)).toMatchObject({ activeEngine: 'anthropic', degradedFrom: null })
    await assertEngineDiscovery(acceptanceApp, info, [selectedPath, realpathSync(selectedPath)])
    await info.attach('installation-reselection', { body: JSON.stringify({ entry, conversationId: id, engine: 'anthropic', localRequests: model.exchanges.length }), contentType: 'application/json' })
  })
}

automationTest('reselect the recorded installation for an independent task', acceptance(caseId, { entry: 'automation' }), async ({ automation, model }, info) => {
  await setPersonOverride(automation.session.window, automation.appId)
  let selectedPath!: string
  const page = await automation.session.restart(profile => { selectedPath = seedAutomaticCcInstallation(profile) })
  await openAutomation(page, automation)
  const failed = await startAutomation(page, automation.appId)
  const failure = await waitForAutomationResult(page, automation.appId, failed.runId, 'error')
  const activity = (await readAutomationActivity(page, automation.appId)).filter(entry => entry.runId === failed.runId && entry.type === 'run_error')
  expect(activity.length).toBeGreaterThan(0)
  expect(JSON.stringify({ failure, activity })).toMatch(/select.*installation|installation.*settings/i)
  expect(JSON.stringify(activity)).toContain('Engine \\"Claude Code\\" is unavailable')
  expect(JSON.stringify(activity)).toContain('Halo desktop app')
  expect(model.exchanges).toHaveLength(0)
  await assertEngineDiscovery(automation.session, info)
  await reselectAutomaticCcInstallation(automation.session, page, info, selectedPath)
  model.respond(request => request.toolResults.some(result => result.id === 'reselection-report')
    ? { text: 'The task completed on the selected installation.' }
    : { tools: [modelTool(request, 'report_to_user', { type: 'run_complete', message: 'The task completed on the selected installation.' }, 'reselection-report')] })
  await openAutomation(page, automation)
  const run = await startAutomation(page, automation.appId)
  await waitForAutomationResult(page, automation.appId, run.runId, 'ok')
  expect(model.exchanges.length).toBeGreaterThan(0)
  const mapFile = join(automation.session.profile, '.halo', 'temp', '.halo', 'apps', automation.appId, 'runs', '_session-ids.json')
  expect(JSON.parse(readFileSync(mapFile, 'utf8'))[run.runId]?.engineId).toBe('anthropic')
  expect((await readAutomationPerson(page, automation.appId)).userOverrides.engineId).toBe('anthropic')
  expect(await readCcAvailability(page)).toMatchObject({ activeEngine: 'anthropic', degradedFrom: null })
  await assertEngineDiscovery(automation.session, info, [selectedPath, realpathSync(selectedPath)])
  await info.attach('task-reselection', { body: JSON.stringify({ failedRunId: failed.runId, runId: run.runId, failure, activity, engine: 'anthropic', localRequests: model.exchanges.length }), contentType: 'application/json' })
})
