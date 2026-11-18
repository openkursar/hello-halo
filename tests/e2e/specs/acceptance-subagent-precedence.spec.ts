import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { startAcceptanceModel, initialUserInput, type ModelRequest } from '../fixtures/acceptance-model'
import { collaboratorReceipt } from '../fixtures/acceptance-collaboration'
import { assignmentCall } from '../fixtures/acceptance-subagent-models'
import { assignmentTool, parseModelDirectory, reasoningWire, shortModelProfileId, type ModelDirectory } from '../fixtures/acceptance-subagent-wire'

test.use({ sdkEngine: 'halo', aiSource: async ({ model }, use) => {
  const source = { provider: 'openai', apiType: 'chat_completions' as const, apiKey: 'local-scripted-endpoint', apiUrl: model.url, model: 'o3',
    modelOverrides: { o3: { reasoningEffort: 'low' } } }
  await use(source)
} })

for (const selection of ['inherit', 'different-model', 'same-model', 'group'] as const) {
  test(`a ${selection} collaborator uses its parent's high reasoning rather than a model default`, acceptance('models.subagent-profiles.selected-reasoning', { selection }), async ({ window, model }, info) => {
    test.setTimeout(120000)
    const endpoint = await startAcceptanceModel()
    const parents: ModelRequest[] = []
    const children: ModelRequest[] = []
    const errors: string[] = []
    const parentMarker = 'SELECTED_REASONING_PARENT: Delegate a verification.'
    const childMarker = 'SELECTED_REASONING_CHILD: Return the verification result.'
    const childResult = 'selected-reasoning-child-confirmed'
    const separateTarget = selection === 'different-model' || selection === 'group'
    const selectedModel = separateTarget ? 'o4-mini' : 'o3'
    let directory: ModelDirectory | undefined
    let handle: string | undefined
    const childReply = (request: ModelRequest) => {
      children.push(request)
      if (!initialUserInput(request).includes(childMarker)) errors.push('Unexpected actor at target model')
      return { text: childResult }
    }
    endpoint.respond(childReply)
    model.respond(request => {
      if (initialUserInput(request).includes(childMarker)) {
        if (separateTarget) errors.push('Selected child fell back to the parent model endpoint')
        return childReply(request)
      }
      parents.push(request)
      const catalog = request.toolResults.find(result => result.id === 'reasoning-directory')
      if (!catalog) return assignmentTool(request, 'list_model_profiles', {}, 'reasoning-directory')
      try { directory = parseModelDirectory(catalog.text) } catch (error) { errors.push(String(error)) }
      const ref = directory?.profiles.find(profile => profile.name === 'Independent verifier')?.selectionRef
      if (!ref) return { text: 'The named model assignment was missing from the directory.' }
      const spawn = request.toolResults.find(result => result.id === 'reasoning-spawn')
      if (!spawn) return assignmentTool(request, 'spawn_agent', { name: 'Reasoning verifier', prompt: childMarker,
        ...(selection === 'inherit' ? {} : { model_profile: ref }),
      }, 'reasoning-spawn')
      try { handle = collaboratorReceipt(spawn).handle } catch (error) { errors.push(String(error)) }
      return { text: request.text.includes(childResult) ? 'The selected verifier finished.' : 'The verifier is preparing.' }
    })
    try {
      const target = await window.evaluate(async ({ selection, selectedModel, url }) => {
        const api = (globalThis as unknown as { halo: HaloAPI }).halo
        if (selection === 'inherit' || selection === 'same-model') return { kind: 'model', sourceId: 'acceptance-local', modelId: selectedModel }
        const sourceId = 'reasoning-target-local'
        const added = await api.aiSourcesAddSource({ id: sourceId, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          name: 'Isolated reasoning account', provider: 'openai', authType: 'api-key', apiUrl: url, apiKey: 'local-reasoning-target',
          apiType: 'chat_completions', model: selectedModel, availableModels: [{ id: selectedModel, name: selectedModel }],
          modelOverrides: { [selectedModel]: { reasoningEffort: 'low' } } })
        if (!added.success) throw new Error(added.error)
        const switched = await api.aiSourcesSwitchSource('acceptance-local')
        if (!switched.success) throw new Error(switched.error)
        if (selection === 'different-model') return { kind: 'model', sourceId, modelId: selectedModel }
        const group = await api.aiGroupsCreate({ name: 'Isolated reasoning group', members: [{ sourceId, modelId: selectedModel }] })
        if (!group.success || !group.data) throw new Error(group.error)
        return { kind: 'group', groupId: group.data.groupId }
      }, { selection, selectedModel, url: endpoint.url })
      const saved = await assignmentCall(window, 'createSubagentModel', { name: 'Independent verifier', description: 'Verify extracted fields', target })
      expect(saved.success, saved.error).toBe(true)
      const created = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.createConversation('halo-temp', 'Selected child reasoning', 'high'))
      expect(created.success, created.error).toBe(true)
      const conversationId = (created.data as { id: string }).id
      const sent = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.sendMessage(input), { spaceId: 'halo-temp', conversationId, message: parentMarker, reasoningEffort: 'high' as const })
      expect(sent.success, sent.error).toBe(true)
      await expect.poll(() => model.exchanges.some(exchange => exchange.completed && exchange.reply?.text === 'The selected verifier finished.'), { timeout: 75000 }).toBe(true)
      await waitForAcceptanceIdle(window, conversationId)
      expect(errors).toEqual([])
      expect(handle).toBeTruthy()
      expect(directory?.text).toMatch(/^- Independent verifier — Verify extracted fields\n  (?:Model|Load-balancing group): .+\n  model_profile: p[0-9a-z]+$/)
      expect(directory?.profiles).toEqual([expect.objectContaining({ target: { kind: selection === 'group' ? 'group' : 'model', label: expect.any(String) }, selectionRef: expect.stringMatching(shortModelProfileId) })])
      const spawnSchemas = parents.flatMap(request => (request.body.tools ?? []).flatMap((tool: Record<string, any>) => {
        const name = tool.name ?? tool.function?.name
        return name === 'spawn_agent' || name?.endsWith('__spawn_agent')
          ? [tool.input_schema ?? tool.function?.parameters ?? tool.parameters].filter(Boolean) : []
      }))
      const selectionSchemas = spawnSchemas.filter(schema => schema.properties?.model_profile)
      expect(selectionSchemas.length).toBeGreaterThan(0)
      for (const schema of spawnSchemas) expect(schema.properties?.reasoning_effort).toBeUndefined()
      for (const request of parents) {
        expect(request.body.model).toBe('o3')
        expect(request.body.reasoning_effort).toBe('high')
      }
      expect(children.length).toBeGreaterThan(0)
      for (const request of children) {
        expect(request.body.model).toBe(selectedModel)
        expect(request.body.reasoning_effort).toBe(parents[0].body.reasoning_effort)
        expect(request.body.thinking?.type).not.toBe('disabled')
      }
      expect(endpoint.exchanges.length > 0).toBe(separateTarget)
      expect(model.errors).toEqual([])
      expect(endpoint.errors).toEqual([])
      await info.attach('selected-reasoning-wire', { body: JSON.stringify({ selection, directory, spawnSchemas, parents: parents.map(request => reasoningWire(request.body)), children: children.map(request => reasoningWire(request.body)) }, null, 2), contentType: 'application/json' })
    } finally { await endpoint.close() }
  })
}
