import { fileURLToPath } from 'node:url'
import type { Page, TestInfo } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { AcceptanceApp } from '../fixtures/acceptance-app'
import type { AcceptanceModel } from '../fixtures/acceptance-model'
import { test, expect, acceptance, sendAcceptanceMessage } from '../fixtures/acceptance-app'
import { assignmentCall, assignmentSettings } from '../fixtures/acceptance-subagent-models'
import { assignmentRoutingScript } from '../fixtures/acceptance-subagent-routing'
import { subagentEffects } from '../fixtures/acceptance-subagent-effects'
import { navigateToChat } from '../fixtures/helpers'
import { initialUserInput } from '../fixtures/acceptance-model'

type CredentialState = { tokenRequests: number; sessionRequests: number; sessionResponses: number; inferenceRequests: number; unexpected: string[]; released: boolean }
type CredentialGlobal = { cancellationCredentialGate: { state(): CredentialState; release(): void } }
const observer = fileURLToPath(new URL('../fixtures/subagent-credential-gate.cjs', import.meta.url))

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const) {
  for (const boundary of ['prepare', 'late-oauth-result'] as const) {
    test.describe(`${boundary} credential cancellation on ${sdkEngine}`, () => {
      test.use({ sdkEngine, startupObserver: observer })
      test('cancelled real credential preparation creates no child when its network result arrives', acceptance('models.subagent-profiles.stop', { engine: sdkEngine, boundary }), async ({ window, model, acceptanceApp }, info) => {
        test.setTimeout(180000)
        await exercisePreparation({ window, model, acceptanceApp }, info, 'stop', boundary === 'prepare')
      })
    })
  }
}

for (const change of ['profile-revision', 'account-removal'] as const) {
  test.describe(`Credential preparation ${change}`, () => {
    test.use({ sdkEngine: 'halo', startupObserver: observer })
    test('a delayed credential result cannot commit an obsolete selection', acceptance('models.subagent-profiles.policy-race', { change }), async ({ window, model, acceptanceApp }, info) => {
      test.setTimeout(180000)
      await exercisePreparation({ window, model, acceptanceApp }, info, change)
    })
  })
}

async function exercisePreparation({ window, model, acceptanceApp }: { window: Page; model: AcceptanceModel; acceptanceApp: AcceptanceApp }, info: TestInfo, change: 'stop' | 'profile-revision' | 'account-removal', assertBeforeRelease = false) {
  const script = assignmentRoutingScript()
  model.respond(request => initialUserInput(request).includes('PREPARATION_UNRELATED:') ? { text: 'Unrelated session completed.' } : script.parent(request))
  const created = await assignmentCall(window, 'createSubagentModel', { name: 'Verifier', description: 'Verify cancellation boundaries', target: { kind: 'model', sourceId: 'cancellation-copilot', modelId: 'gpt-4o' } })
  expect(created.success, created.error).toBe(true)
  const before = subagentEffects(acceptanceApp.profile)
  try {
    await navigateToChat(window)
    const parent = await sendAcceptanceMessage(window, 'Delegate this verification to Verifier.')
    await expect.poll(() => model.exchanges.some(exchange => exchange.reply?.tools?.some(tool => tool.id === 'assigned-spawn')), { timeout: 30000, message: 'The real parent must query the directory and issue the selected spawn' }).toBe(true)
    await expect.poll(async () => {
      const failed = model.exchanges.flatMap(exchange => exchange.request.toolResults).find(result => result.id === 'assigned-spawn' && result.error)
      if (failed) throw new Error(`Credential preparation was refused before reaching the gate: ${failed.text}`)
      expect(script.errors, 'The selected profile must remain available in the real directory').toEqual([])
      const state = await acceptanceApp.app.evaluate(() => (globalThis as unknown as CredentialGlobal).cancellationCredentialGate.state())
      return { tokenReached: state.tokenRequests > 0, sessionRequests: state.sessionRequests }
    }, { timeout: 15000, message: 'The real Copilot provider must reach the owned credential HTTP endpoints' }).toEqual({ tokenReached: true, sessionRequests: 1 })
    expect(subagentEffects(acceptanceApp.profile)).toEqual(before)
    if (change === 'stop') {
      const stopped = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.stopGeneration(id), parent.conversationId)
      expect(stopped.success, stopped.error).toBe(true)
    } else if (change === 'account-removal') {
      const removed = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesDeleteSource('cancellation-copilot'))
      expect(removed.success, removed.error).toBe(true)
    } else {
      const profile = (await assignmentSettings(window)).profiles.find(profile => profile.kind === 'custom' && profile.name === 'Verifier')!
      const updated = await assignmentCall(window, 'updateSubagentModel', { id: profile.id, expectedRevision: profile.revision, name: 'Verifier', description: 'Updated while credentials were preparing', target: { kind: 'model', sourceId: 'acceptance-local', modelId: 'gpt-4o' } })
      expect(updated.success, updated.error).toBe(true)
    }
    if (assertBeforeRelease) {
      expect(subagentEffects(acceptanceApp.profile)).toEqual(before)
      expect((await acceptanceApp.app.evaluate(() => (globalThis as unknown as CredentialGlobal).cancellationCredentialGate.state())).inferenceRequests).toBe(0)
    }
    await acceptanceApp.app.evaluate(() => (globalThis as unknown as CredentialGlobal).cancellationCredentialGate.release())
    await expect.poll(() => acceptanceApp.app.evaluate(() => (globalThis as unknown as CredentialGlobal).cancellationCredentialGate.state().sessionResponses), { timeout: 10000 }).toBe(1)
    await expect.poll(() => window.evaluate(async id => {
      const state = await (globalThis as unknown as { halo: HaloAPI }).halo.getSessionState(id)
      if (!state.success) throw new Error('Cannot inspect preparation owner')
      return (state.data as { isActive: boolean }).isActive
    }, parent.conversationId), { timeout: 45000 }).toBe(false)
    const control = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.createConversation('halo-temp', 'Credential preparation control'))
    expect(control.success, control.error).toBe(true)
    const controlId = (control.data as { id: string }).id
    const sent = await window.evaluate(conversationId => (globalThis as unknown as { halo: HaloAPI }).halo.sendMessage({ spaceId: 'halo-temp', conversationId, message: 'PREPARATION_UNRELATED: Complete normally.' }), controlId)
    expect(sent.success, sent.error).toBe(true)
    await expect.poll(() => model.exchanges.some(exchange => exchange.request.text.includes('PREPARATION_UNRELATED:') && exchange.completed), { timeout: 45000 }).toBe(true)
    expect(subagentEffects(acceptanceApp.profile)).toEqual(before)
    expect(script.handle).toBeUndefined()
    expect(script.childRequests).toEqual([])
    const state = await acceptanceApp.app.evaluate(() => (globalThis as unknown as CredentialGlobal).cancellationCredentialGate.state())
    expect(state.sessionRequests).toBe(1)
    expect(state.inferenceRequests).toBe(0)
    expect(state.unexpected.filter(value => !value.startsWith('external:'))).toEqual([])
    await info.attach('real-credential-preparation-boundary', { body: JSON.stringify({ change, assertBeforeRelease, before, after: subagentEffects(acceptanceApp.profile), state }, null, 2), contentType: 'application/json' })
  } finally {
    await acceptanceApp.app.evaluate(() => (globalThis as unknown as CredentialGlobal).cancellationCredentialGate.release())
  }
}
