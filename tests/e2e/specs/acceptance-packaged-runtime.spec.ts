import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { navigateToSettings, navigateToChat } from '../fixtures/helpers'
import { openManagedConversation } from '../fixtures/acceptance-management'
import { startRuntimeRegistry } from '../fixtures/runtime-registry'

test.use({ isolatedPath: true })

for (const engine of ['anthropic', 'codex'] as const) {
  test(`packaged application installs ${engine} and resumes its conversation`, acceptance('models.engines.packaged-runtime', { engine }), async ({ acceptanceApp, window, model }, info) => {
    test.setTimeout(240000)
    expect(await acceptanceApp.app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    const registry = await startRuntimeRegistry(engine)
    try {
      const name = engine === 'anthropic' ? 'Claude Code' : 'Codex'
      await navigateToChat(window)
      model.respond(() => ({ text: 'The original conversation completed on Halo.' }))
      const original = await sendAcceptanceMessage(window, 'Complete the original Halo turn without tools.')
      await expect(window.locator('.message-assistant').last()).toContainText('The original conversation completed on Halo.')
      await waitForAcceptanceIdle(window, original.conversationId)
      const originalSaved = await window.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.getConversation(input.spaceId, input.conversationId), original)
      expect(originalSaved).toMatchObject({ success: true, data: { engineBinding: { engineId: 'halo' } } })

      await navigateToSettings(window)
      await window.locator('#advanced').scrollIntoViewIfNeeded()
      await window.getByRole('button', { name: `Set up ${name}`, exact: true }).click()
      const panel = window.getByRole('region', { name: `${name} setup`, exact: true })
      await expect(panel.getByText(`No ${name} installations added yet.`, { exact: true })).toBeVisible()
      await panel.getByText(/^Source settings/).click()
      await panel.getByLabel('Download source', { exact: true }).selectOption('custom')
      await panel.getByLabel('Mirror base URL', { exact: true }).fill(registry.baseUrl)
      await panel.getByRole('button', { name: 'Save source', exact: true }).click()
      await expect(panel.getByText('Saved', { exact: true })).toBeVisible()
      await panel.getByRole('button', { name: 'Install recommended version', exact: true }).click()
      await expect.poll(() => JSON.parse(readFileSync(join(acceptanceApp.profile, '.halo', 'config.json'), 'utf8')).agent.sdkEngine, { timeout: 120000 }).toBe(engine)
      const retained = await window.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.getConversation(input.spaceId, input.conversationId), original)
      expect(retained).toMatchObject({ success: true, data: { engineBinding: { engineId: 'halo' } } })

      const reply = 'Packaged external runtime retained the cedar reference.'
      model.respond(request => ({ text: request.text.includes('RESUME_PACKAGED_REFERENCE') ? 'The cedar reference remains available after restarting.' : reply }))
      await navigateToChat(window)
      const beforeCreation = await window.evaluate(spaceId => (window as unknown as { halo: HaloAPI }).halo.listConversations(spaceId), original.spaceId)
      expect(beforeCreation.success).toBe(true)
      const previousIds = (beforeCreation.data as Array<{ id: string }>).map(item => item.id)
      await window.getByRole('button', { name: 'New', exact: true }).click()
      await expect(window.locator('.message-user')).toHaveCount(0, { timeout: 120000 })
      await expect(window.locator('.message-assistant')).toHaveCount(0)
      await expect(window.locator('textarea').first()).toHaveValue('')
      const afterCreation = await window.evaluate(spaceId => (window as unknown as { halo: HaloAPI }).halo.listConversations(spaceId), original.spaceId)
      expect(afterCreation.success).toBe(true)
      const created = (afterCreation.data as Array<{ id: string }>).filter(item => !previousIds.includes(item.id))
      expect(created).toHaveLength(1)
      const target = { spaceId: original.spaceId, conversationId: created[0].id }
      const turn = await sendAcceptanceMessage(window, 'Keep the cedar reference in this conversation without using tools.', { expectedTarget: target })
      expect(turn.conversationId).toBe(target.conversationId)
      expect(turn.conversationId).not.toBe(original.conversationId)
      await expect(window.locator('.message-assistant').last()).toContainText(reply, { timeout: 90000 })
      await waitForAcceptanceIdle(window, turn.conversationId)
      const readConversation = async (page: typeof window) => {
        const result = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.getConversation(input.spaceId, input.conversationId), turn)
        expect(result.success).toBe(true)
        return result.data as { title: string; engineBinding: { engineId: string; sessionId?: string }; messages: Array<{ content: string }> }
      }
      const prior = await readConversation(window)
      expect(prior.engineBinding.engineId).toBe(engine)
      const page = await acceptanceApp.restart()
      expect(await acceptanceApp.app.evaluate(({ app }) => app.isPackaged)).toBe(true)
      await openManagedConversation(page, prior.title, turn.spaceId)
      await sendAcceptanceMessage(page, 'RESUME_PACKAGED_REFERENCE: Continue the cedar reference.', { expectedTarget: turn })
      await expect(page.locator('.message-assistant').last()).toContainText('The cedar reference remains available after restarting.', { timeout: 90000 })
      await waitForAcceptanceIdle(page, turn.conversationId)
      const current = await readConversation(page)
      expect(current.engineBinding).toEqual(prior.engineBinding)
      expect(current.messages.some(message => message.content.includes(reply))).toBe(true)
      expect(model.exchanges.some(exchange => exchange.request.text.includes(reply) && exchange.request.text.includes('RESUME_PACKAGED_REFERENCE'))).toBe(true)
      const availability = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getEngineAvailability())
      expect(availability).toMatchObject({ success: true, data: { activeEngine: engine, degradedFrom: null } })
      await info.attach('packaged-external-runtime', { body: JSON.stringify({ engine, receipt: registry.receipt, requests: registry.requests, binding: current.engineBinding, originalConversation: original.conversationId, externalConversation: turn.conversationId }), contentType: 'application/json' })
    } finally { await registry.close() }
  })
}
