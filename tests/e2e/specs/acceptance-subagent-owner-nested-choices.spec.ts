import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, sendAcceptanceMessage } from '../fixtures/acceptance-app'
import { startAcceptanceModel, initialUserInput } from '../fixtures/acceptance-model'
import { assignmentCall } from '../fixtures/acceptance-subagent-models'
import { assignmentTool, assignmentResult } from '../fixtures/acceptance-subagent-wire'
import { collaboratorReceipt } from '../fixtures/acceptance-collaboration'
import { prepareOwnerChoice, ownerChoiceScript, assertOwnerChoiceWire, assertOwnerFailure, waitForOwnerChoiceIdle } from '../fixtures/acceptance-subagent-owner-choices'
import { navigateToChat } from '../fixtures/helpers'

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const) test.describe(`Nested owner choices on ${sdkEngine}`, () => {
  test.use({ sdkEngine, aiSource: async ({ model }, use) => {
    await use({ provider: 'openai', apiType: 'chat_completions', apiKey: 'local-scripted-endpoint', apiUrl: model.url, model: 'o3' })
  } })
  for (const choice of ['inherit', 'effort-only', 'provider-failure'] as const) test(`a direct child applies ${choice} independently of its root`, acceptance('models.subagent-profiles.owner-routing', { engine: sdkEngine, entry: 'nested', choice }), async ({ model, window }, info) => {
    test.setTimeout(180000)
    const direct = await startAcceptanceModel()
    const failure = await prepareOwnerChoice(window, choice)
    const script = ownerChoiceScript(choice, { sourceMarker: 'NESTED_OWNER_DIRECT' })
    const rootErrors: string[] = []
    let rootHandle: string | undefined
    direct.respond(script.reply)
    model.respond(request => {
      if (initialUserInput(request).includes('NESTED_OWNER_DIRECT') || initialUserInput(request).includes(script.childMarker)) rootErrors.push('A descendant fell back to the root endpoint')
      const listed = request.toolResults.find(result => result.id === 'nested-owner-directory')
      if (!listed) return assignmentTool(request, 'list_model_profiles', { query: 'Direct owner parent' }, 'nested-owner-directory')
      const ref = assignmentResult(listed.text).profiles?.find((profile: { name: string }) => profile.name === 'Direct owner parent')?.selectionRef
      if (!ref) { rootErrors.push('Direct parent profile missing'); return { text: 'Direct parent unavailable.' } }
      const spawned = request.toolResults.find(result => result.id === 'nested-owner-spawn')
      if (!spawned) return assignmentTool(request, 'spawn_agent', { name: 'Direct owner parent', prompt: 'NESTED_OWNER_DIRECT: Delegate the detail verification.', model_profile: ref }, 'nested-owner-spawn')
      try { rootHandle = collaboratorReceipt(spawned).handle } catch (error) { rootErrors.push(String(error)) }
      return { text: request.text.includes('owner-choice-parent-complete') ? 'nested-owner-root-complete' : 'Waiting for direct parent.' }
    })
    try {
      const added = await window.evaluate(url => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesAddSource({ id: 'nested-owner-local', name: 'Nested direct owner endpoint', provider: 'openai', authType: 'api-key', apiUrl: url, apiKey: 'local-nested-owner', apiType: 'chat_completions', model: 'o3', availableModels: [{ id: 'o3', name: 'o3' }], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }), direct.url)
      expect(added.success, added.error).toBe(true)
      expect((await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesSwitchSource('acceptance-local'))).success).toBe(true)
      const configured = await assignmentCall(window, 'createSubagentModel', { name: 'Direct owner parent', description: 'Delegate detail work from an isolated direct parent', target: { kind: 'model', sourceId: 'nested-owner-local', modelId: 'o3' }, reasoningEffort: 'high' })
      expect(configured.success, configured.error).toBe(true)
      await navigateToChat(window)
      const turn = await sendAcceptanceMessage(window, 'NESTED_OWNER_ROOT: Ask Direct owner parent to delegate verification.')
      await expect(window.locator('.message-assistant').last()).toContainText('nested-owner-root-complete', { timeout: 120000 })
      await waitForOwnerChoiceIdle(window, turn.conversationId, script, choice)
      expect(rootErrors).toEqual([])
      expect(rootHandle).toBeTruthy()
      expect(script.handle).not.toBe(rootHandle)
      assertOwnerChoiceWire(script, choice)
      assertOwnerFailure(failure, script)
      expect(direct.errors).toEqual([])
      expect(model.errors).toEqual([])
      await info.attach('nested-owner-choice', { body: JSON.stringify({ root: model.exchanges, direct: direct.exchanges, rejected: failure?.requests }, null, 2), contentType: 'application/json' })
    } finally { await direct.close(); await failure?.close() }
  })
})
