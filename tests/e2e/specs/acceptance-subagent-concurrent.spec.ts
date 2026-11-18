import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { startAcceptanceModel, createModelGate, initialUserInput, type ModelRequest } from '../fixtures/acceptance-model'
import { assignmentCall } from '../fixtures/acceptance-subagent-models'
import { assignmentTool, assignmentResult } from '../fixtures/acceptance-subagent-wire'

 test('same-name models on concurrent siblings retain separate exact account endpoints', acceptance('models.subagent-profiles.concurrent', { topology: 'siblings-same-model-distinct-accounts' }), async ({ model, window }, info) => {
  test.setTimeout(180000)
  const endpoints = [await startAcceptanceModel(), await startAcceptanceModel()]
  const gate = createModelGate()
  const children: ModelRequest[][] = [[], []]
  const errors: string[] = []
  const names = ['Concurrent amber', 'Concurrent violet']
  const markers = ['CONCURRENT_AMBER_CHILD', 'CONCURRENT_VIOLET_CHILD']
  endpoints.forEach((endpoint, index) => endpoint.respond(request => {
    children[index].push(request)
    if (!initialUserInput(request).includes(markers[index])) errors.push(`Sibling reached wrong endpoint ${index}`)
    return { text: `concurrent-child-${index}-finished`, hold: gate.promise }
  }))
  model.respond(request => {
    if (markers.some(marker => initialUserInput(request).includes(marker))) { errors.push('Sibling fell back to parent account'); return { text: 'Wrong endpoint.' } }
    const listed = request.toolResults.find(result => result.id === 'concurrent-list')
    if (!listed) return assignmentTool(request, 'list_model_profiles', {}, 'concurrent-list')
    let profiles: Array<{ name: string; selectionRef: string }> = []
    try { profiles = assignmentResult(listed.text).profiles } catch (error) { errors.push(String(error)) }
    for (let index = 0; index < 2; index++) {
      if (!request.toolResults.some(result => result.id === `concurrent-spawn-${index}`)) {
        const ref = profiles.find(profile => profile.name === names[index])?.selectionRef
        if (!ref) { errors.push(`Missing concurrent profile ${index}`); return { text: 'Profile unavailable.' } }
        return assignmentTool(request, 'spawn_agent', { name: `Sibling ${index}`, prompt: markers[index], model_profile: ref }, `concurrent-spawn-${index}`)
      }
    }
    return { text: request.text.includes('concurrent-child-0-finished') && request.text.includes('concurrent-child-1-finished') ? 'Both exact-account siblings finished.' : 'Both siblings are preparing.' }
  })
  try {
    for (let index = 0; index < 2; index++) {
      const added = await window.evaluate(({ url, name }) => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesAddSource({ id: `concurrent-${name}`, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', name, provider: 'openai', authType: 'api-key', apiUrl: url, apiKey: `local-${name}`, apiType: 'chat_completions', model: 'gpt-4o', availableModels: [{ id: 'gpt-4o', name: 'gpt-4o' }] }), { url: endpoints[index].url, name: names[index] })
      expect(added.success).toBe(true)
      const config = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.getConfig())
      const source = (config.data as { aiSources: { sources: Array<{ id: string; name: string }> } }).aiSources.sources.find(source => source.name === names[index])!
      expect(source.id).toBe(`concurrent-${names[index]}`)
      const saved = await assignmentCall(window, 'createSubagentModel', { name: names[index], description: `Independent account ${index}`, target: { kind: 'model', sourceId: source.id, modelId: 'gpt-4o' } })
      expect(saved.success, saved.error).toBe(true)
    }
    const switched = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesSwitchSource('acceptance-local'))
    expect(switched.success).toBe(true)
    const created = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.createConversation('halo-temp', 'Concurrent account isolation'))
    expect(created.success).toBe(true)
    const conversationId = (created.data as { id: string }).id
    const sent = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.sendMessage({ spaceId: 'halo-temp', conversationId: id, message: 'Create both configured concurrent workers without waiting for either to finish.' }), conversationId)
    expect(sent.success).toBe(true)
    await expect.poll(() => children.every(requests => requests.length > 0), { timeout: 90000 }).toBe(true)
    expect(endpoints.every(endpoint => endpoint.exchanges.some(exchange => !exchange.completed && !exchange.cancelled)), 'Both account streams must overlap before release').toBe(true)
    gate.release()
    await expect.poll(() => model.exchanges.some(exchange => exchange.request.text.includes('concurrent-child-0-finished') && exchange.request.text.includes('concurrent-child-1-finished')), { timeout: 90000 }).toBe(true)
    await waitForAcceptanceIdle(window, conversationId)
    expect(errors).toEqual([])
    for (const requests of children) for (const request of requests) expect(request.body.model).toBe('gpt-4o')
    for (const endpoint of endpoints) expect(endpoint.errors).toEqual([])
    await info.attach('concurrent-exact-account-exchanges', { body: JSON.stringify(endpoints.map(endpoint => endpoint.exchanges), null, 2), contentType: 'application/json' })
  } finally {
    gate.release()
    await Promise.all(endpoints.map(endpoint => endpoint.close()))
  }
})
