import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { startAcceptanceModel, initialUserInput, type ModelRequest } from '../fixtures/acceptance-model'
import { assignmentCall } from '../fixtures/acceptance-subagent-models'
import { assignmentTool, assignmentResult, reasoningWire } from '../fixtures/acceptance-subagent-wire'

for (const selection of ['inherit', 'effort-only', 'profile-default', 'target-default', 'explicit-effort', 'same-model-profile'] as const) {
  test(`finalized child reasoning follows ${selection} precedence`, acceptance('models.subagent-profiles.reasoning-precedence', { selection }), async ({ window, model }, info) => {
    test.setTimeout(180000)
    const endpoint = await startAcceptanceModel()
    const parents: ModelRequest[] = [], children: ModelRequest[] = []
    const errors: string[] = []
    const marker = `PRECEDENCE_PARENT:${selection}`
    const childMarker = `PRECEDENCE_CHILD:${selection}`
    const profileDefault = selection === 'profile-default' || selection === 'explicit-effort' || selection === 'same-model-profile' ? 'low' : undefined
    const expected = selection === 'inherit' ? 'high' : selection === 'explicit-effort' || selection === 'effort-only' ? 'medium' : 'low'
    const childReply = (request: ModelRequest) => { children.push(request); return { text: 'precedence-child-finished' } }
    endpoint.respond(childReply)
    model.respond(request => {
      if (initialUserInput(request).includes(childMarker)) return childReply(request)
      parents.push(request)
      const catalog = request.toolResults.find(result => result.id === 'precedence-list')
      if (!catalog) return assignmentTool(request, 'list_model_profiles', {}, 'precedence-list')
      let ref: string | undefined
      try { ref = assignmentResult(catalog.text).profiles.find((profile: { name: string }) => profile.name === 'Precedence target')?.selectionRef } catch (error) { errors.push(String(error)) }
      if (!ref) { errors.push('Configured precedence target missing'); return { text: 'Target unavailable.' } }
      const spawn = request.toolResults.find(result => result.id === 'precedence-spawn')
      if (!spawn) return assignmentTool(request, 'spawn_agent', {
        name: 'Precedence worker', prompt: childMarker,
        ...(['inherit', 'effort-only'].includes(selection) ? {} : { model_profile: ref }),
        ...(['effort-only', 'explicit-effort'].includes(selection) ? { reasoning_effort: 'medium' } : {}),
      }, 'precedence-spawn')
      if (spawn.error || /refused|rejected/i.test(spawn.text)) errors.push(spawn.text)
      return { text: request.text.includes('precedence-child-finished') ? 'precedence-parent-finished' : 'Waiting for precedence worker.' }
    })
    try {
      const added = await window.evaluate(url => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesAddSource({ id: 'precedence-local', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', name: 'Precedence account', provider: 'openai', authType: 'api-key', apiUrl: url, apiKey: 'local-precedence', apiType: 'chat_completions', model: 'o3', availableModels: [{ id: 'o3', name: 'o3' }], modelOverrides: { o3: { reasoningEffort: 'low' } } }), endpoint.url)
      expect(added.success, added.error).toBe(true)
      const config = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.getConfig())
      const sourceId = (config.data as { aiSources: { sources: Array<{ id: string; name: string }> } }).aiSources.sources.find(source => source.name === 'Precedence account')!.id
      expect(sourceId).toBe('precedence-local')
      const parentUpdate = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesUpdateSource('acceptance-local', { model: 'o3', availableModels: [{ id: 'o3', name: 'o3' }], modelOverrides: { o3: { reasoningEffort: 'low' } } }))
      expect(parentUpdate.success).toBe(true)
      const switched = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesSwitchSource('acceptance-local'))
      expect(switched.success).toBe(true)
      const saved = await assignmentCall(window, 'createSubagentModel', { name: 'Precedence target', description: 'Reasoning precedence check', target: { kind: 'model', sourceId: selection === 'same-model-profile' ? 'acceptance-local' : sourceId, modelId: 'o3' }, ...(profileDefault ? { reasoningEffort: profileDefault } : {}) })
      expect(saved.success, saved.error).toBe(true)
      const created = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.createConversation('halo-temp', 'Precedence request', 'high'))
      expect(created.success).toBe(true)
      const conversationId = (created.data as { id: string }).id
      const sent = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.sendMessage(input), { spaceId: 'halo-temp', conversationId, message: marker, reasoningEffort: 'high' as const })
      expect(sent.success).toBe(true)
      await expect.poll(() => parents.some(request => request.text.includes('precedence-child-finished')), { timeout: 120000 }).toBe(true)
      await waitForAcceptanceIdle(window, conversationId)
      expect(errors).toEqual([])
      expect(children.length).toBeGreaterThan(0)
      for (const request of children) {
        expect(request.body.model).toBe('o3')
        expect(reasoningWire(request.body).effort).toBe(expected)
        expect(request.body.thinking?.type).not.toBe('disabled')
      }
      if (['inherit', 'effort-only', 'same-model-profile'].includes(selection)) expect(endpoint.exchanges).toHaveLength(0)
      else expect(endpoint.exchanges.length).toBeGreaterThan(0)
      await info.attach('reasoning-precedence-wire', { body: JSON.stringify({ selection, expected, parents: parents.map(request => reasoningWire(request.body)), children: children.map(request => reasoningWire(request.body)), targetExchanges: endpoint.exchanges }, null, 2), contentType: 'application/json' })
    } finally { await endpoint.close() }
  })
}
