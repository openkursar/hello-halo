import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, acceptance } from '../fixtures/acceptance-app'
import type { HaloAPI } from '../../../src/preload'
import { seedManagedSpace, seedManagedConversation, openManagedConversation } from '../fixtures/acceptance-management'

test.setTimeout(90000)

for (const entry of ['default', 'bound'] as const) {
  test(`missing external Codex preserves ${entry} conversation and input`, acceptance('models.engines.codex-missing', { entry }), async ({ acceptanceApp, window, model }, info) => {
    const space = await seedManagedSpace(window, 'Codex recovery')
    let target = await seedManagedConversation(window, space.id, 'Keep Codex history', [{ role: 'user', content: 'Preserve the cedar reference.' }])
    let conversationFile = join(space.path, '.halo', 'conversations', `${target.id}.json`)
    const page = await acceptanceApp.restart(profile => {
      const file = join(profile, '.halo', 'config.json')
      const config = JSON.parse(readFileSync(file, 'utf8'))
      config.agent = { ...config.agent, sdkEngine: entry === 'default' ? 'codex' : 'halo', codexRuntime: { selectedPath: join(profile, 'missing-codex'), selectionOrigin: 'user' } }
      writeFileSync(file, JSON.stringify(config))
      const stored = JSON.parse(readFileSync(conversationFile, 'utf8'))
      if (entry === 'bound') stored.engineOverride = 'codex'
      else {
        delete stored.engineBinding
        delete stored.engineOverride
        delete stored.sessionId
      }
      writeFileSync(conversationFile, JSON.stringify(stored))
    })
    if (entry === 'default') {
      const result = await page.evaluate(spaceId => (window as unknown as { halo: HaloAPI }).halo.createConversation(spaceId, 'New Codex default conversation'), space.id)
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/Codex.*unavailable|compatible Codex installation/i)
      expect(model.exchanges).toHaveLength(0)
      expect(JSON.parse(readFileSync(conversationFile, 'utf8')).messages.map((message: { content: string }) => message.content)).toEqual(['Preserve the cedar reference.'])
      const config = JSON.parse(readFileSync(join(acceptanceApp.profile, '.halo', 'config.json'), 'utf8'))
      expect(config.agent.sdkEngine).toBe('codex')
      await info.attach('missing-codex-default-creation', { body: JSON.stringify({ result, savedDefault: config.agent.sdkEngine, modelRequests: model.exchanges.length }), contentType: 'application/json' })
      return
    }
    await openManagedConversation(page, target.title, space.id)
    const input = 'Continue on Codex without losing this draft.'
    await page.locator('textarea').first().fill(input)
    await page.locator('[data-onboarding="send-button"]').click()
    await expect(page.getByText('Failed to send message', { exact: true })).toBeVisible()
    await expect(page.locator('textarea').first()).toHaveValue(input)
    await expect(page.getByRole('button', { name: /Codex.*Settings|Set up Codex|Install or connect Codex/i })).toBeVisible()
    expect(model.exchanges).toHaveLength(0)
    const stored = JSON.parse(readFileSync(conversationFile, 'utf8'))
    expect(stored.messages.map((message: { content: string }) => message.content)).toEqual(['Preserve the cedar reference.'])
    if (entry === 'bound') expect(stored.engineOverride).toBe('codex')
    const config = JSON.parse(readFileSync(join(acceptanceApp.profile, '.halo', 'config.json'), 'utf8'))
    expect(config.agent.sdkEngine).toBe('halo')
    expect(config.agent.codexRuntime.selectedPath).toContain('missing-codex')
    await info.attach('missing-codex-preservation', { body: JSON.stringify({ entry, modelRequests: model.exchanges.length, messages: stored.messages.length, sdkEngine: config.agent.sdkEngine }), contentType: 'application/json' })
  })
}
