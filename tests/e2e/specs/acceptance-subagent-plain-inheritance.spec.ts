import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { createEngineCollaborationScript, engineSourceQuestion, engineSourceAnswer } from '../fixtures/acceptance-engine-collaboration'
import { assignmentCall, assignmentSettings, storedAssignmentConfig } from '../fixtures/acceptance-subagent-models'

for (const variant of ['configured-low', 'supplier-specific', 'group-default', 'native-budget'] as const) {
  test.describe(variant, () => {
    const nativeBudget = variant === 'native-budget'
    const modelId = nativeBudget ? 'claude-sonnet-4-5' : variant === 'configured-low' ? 'gpt-4o' : 'gpt-5-4'
    test.use({ sdkEngine: nativeBudget ? 'dsh' : 'halo', aiSource: async ({ model }, use) => {
      const source = { provider: nativeBudget ? 'anthropic' : 'openai',
        apiType: nativeBudget ? 'anthropic_passthrough' as const : 'chat_completions' as const,
        apiKey: 'local-scripted-endpoint', apiUrl: model.url, model: modelId,
        modelOverrides: { [modelId]: { maxOutputTokens: 32768, ...(variant === 'supplier-specific' ? { reasoningEffort: 'vendor-deep' } : {}) } } }
      await use(source)
    } })
    test('plain delegation preserves the upstream reasoning', acceptance('models.subagent-profiles.plain-inheritance', { case: variant }), async ({ window, model, acceptanceApp }, info) => {
      test.setTimeout(120000)
      const script = createEngineCollaborationScript()
      model.respond(script.reply)
      if (variant === 'configured-low') {
        const slot = (await assignmentSettings(window)).profiles[0]
        const result = await assignmentCall(window, 'updateSubagentModel', { id: slot.id, expectedRevision: slot.revision,
          description: slot.description, target: { kind: 'model', sourceId: 'acceptance-local', modelId } })
        expect(result.success, result.error).toBe(true)
      } else if (variant === 'group-default') {
        await window.evaluate(async modelId => {
          const api = (globalThis as unknown as { halo: HaloAPI }).halo
          const created = await api.aiGroupsCreate({ name: 'Scripted reasoning pool', members: [{ sourceId: 'acceptance-local', modelId }] })
          if (!created.success || !created.data) throw new Error('Could not create fixture group')
          const switched = await api.aiSourcesSwitchSource(created.data.groupId)
          if (!switched.success) throw new Error('Could not select fixture group')
        }, modelId)
      }
      const reasoningEffort = variant === 'configured-low' ? 'low' as const : undefined
      const created = await window.evaluate(effort => (globalThis as unknown as { halo: HaloAPI }).halo.createConversation('halo-temp', 'Plain inheritance', effort), reasoningEffort)
      expect(created.success, created.error).toBe(true)
      const conversationId = (created.data as { id: string }).id
      const sent = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.sendMessage(input), {
        spaceId: 'halo-temp', conversationId, message: engineSourceQuestion, thinkingEnabled: true, reasoningEffort,
      })
      expect(sent.success, sent.error).toBe(true)
      await expect.poll(async () => {
        const history = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.getConversation('halo-temp', id), conversationId)
        return (history.data as { messages: Array<{ content: string }> } | undefined)?.messages.some(message => message.content.includes(engineSourceAnswer)) ?? false
      }, { timeout: 45000 }).toBe(true)
      await waitForAcceptanceIdle(window, conversationId)
      expect(script.errors).toEqual([])
      expect(script.memberRequests.length).toBeGreaterThan(0)
      if (nativeBudget) {
        expect(storedAssignmentConfig(acceptanceApp.profile).settings).toBeUndefined()
        expect(script.created?.handle).toBeTruthy()
        expect(script.followedUp).toBe(true)
        const parent = script.sourceRequests[0].body
        expect(parent.model).toBe(modelId)
        for (const child of script.memberRequests) {
          expect(child.body.model).toBe(modelId)
          expect(child.body.thinking).toEqual(parent.thinking)
          expect(child.body.output_config).toEqual(parent.output_config)
        }
        await info.attach('plain-inheritance-wire', { body: JSON.stringify({ parent: parent.thinking, children: script.memberRequests.map(request => request.body.thinking) }), contentType: 'application/json' })
        return
      }
      const wire = (body: Record<string, unknown>) => ({ model: body.model, effort: body.reasoning_effort })
      const expected = { model: modelId, effort: variant === 'configured-low' ? 'low' : variant === 'supplier-specific' ? 'vendor-deep' : 'high' }
      expect(wire(script.sourceRequests[0].body)).toEqual(expected)
      for (const child of script.memberRequests) expect(wire(child.body)).toEqual(expected)
      await info.attach('plain-inheritance-wire', { body: JSON.stringify({ parent: expected, children: script.memberRequests.map(request => wire(request.body)) }), contentType: 'application/json' })
    })
  })
}
