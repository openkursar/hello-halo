import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { createModelGate, initialUserInput, modelTool, type ModelRequest } from '../fixtures/acceptance-model'
import { navigateToChat } from '../fixtures/helpers'
import { collaboratorReceipt } from '../fixtures/acceptance-collaboration'

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const) test.describe(`Stop delegated work on ${sdkEngine}`, () => {
  test.use({ sdkEngine })
  test('stopping the parent cancels its held child without disabling another conversation', acceptance('models.subagent-profiles.stop', { boundary: 'parent-stop', engine: sdkEngine }), async ({ window, model }, info) => {
    test.setTimeout(180000)
    const gate = createModelGate()
    const childMarker = 'STOP_BOUND_CHILD: Keep verifying delta until cancelled.'
    const sourceMarker = 'STOP_BOUND_PARENT: Delegate one delta verification.'
    const errors: string[] = []
    let handle: string | undefined
    const childRequests: ModelRequest[] = []
    model.respond(request => {
      const original = initialUserInput(request)
      if (original.includes(childMarker)) {
        childRequests.push(request)
        return { text: 'Delta verification is running.', hold: gate.promise }
      }
      if (original.includes('UNRELATED_SESSION:')) return { text: 'The unrelated session remains usable.' }
      if (!original.includes(sourceMarker)) { errors.push('Unexpected cancellation fixture actor'); return { text: 'No matching work.' } }
      const result = request.toolResults.find(result => result.id === 'stop-spawn')
      if (result) {
        try { handle = collaboratorReceipt(result).handle } catch (error) { errors.push(String(error)) }
        return { text: 'The delta verification is running.' }
      }
      const advertised = request.tools.find(tool => tool === 'spawn_agent' || tool.endsWith('__spawn_agent'))
      const definition = (request.body.tools ?? []).find((tool: Record<string, any>) => (tool.name ?? tool.function?.name) === advertised)
      if (advertised && (!definition?.defer_loading && !definition?.function?.defer_loading || request.toolResults.some(result => result.id === 'discover-spawn'))) return { tools: [modelTool(request, 'spawn_agent', { name: 'Delta checker', prompt: childMarker }, 'stop-spawn')] }
      return { tools: [modelTool(request, 'ToolSearch', { query: 'select:mcp__halo-team__spawn_agent', max_results: 1 }, 'discover-spawn')] }
    })
    try {
      await navigateToChat(window)
      const source = await sendAcceptanceMessage(window, sourceMarker)
      await expect.poll(() => childRequests.length, { timeout: 90000 }).toBeGreaterThan(0)
      const childSequences = childRequests.map(request => request.sequence)
      const stopped = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.stopGeneration(id), source.conversationId)
      expect(stopped.success, stopped.error).toBe(true)
      await expect.poll(() => model.exchanges.filter(exchange => childSequences.includes(exchange.request.sequence)).every(exchange => exchange.cancelled), { timeout: 30000 }).toBe(true)
      gate.release()
      const waitForStoppedIdle = async (conversationId: string) => {
        await expect.poll(() => window.evaluate(async ({ conversationId, handle }) => {
          const api = (globalThis as unknown as { halo: HaloAPI }).halo
          const state = await api.getSessionState(conversationId)
          const errors = (globalThis as unknown as { acceptanceProbe: { errors: Array<{ conversationId: string; error: string; errorType?: string }> } }).acceptanceProbe.errors
          return { active: (state.data as { isActive: boolean }).isActive,
            unexpected: errors.filter(error => !error.conversationId.includes(handle!) ||
              !(error.errorType === 'interrupted' || !error.error || /stopp|interrupt|cancel/i.test(error.error))) }
        }, { conversationId, handle }), { timeout: 30000 }).toEqual({ active: false, unexpected: [] })
      }
      await waitForStoppedIdle(source.conversationId)
      const created = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.createConversation('halo-temp', 'Unrelated stop boundary'))
      expect(created.success).toBe(true)
      const conversationId = (created.data as { id: string }).id
      const sent = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.sendMessage({ spaceId: 'halo-temp', conversationId: id, message: 'UNRELATED_SESSION: Answer normally after stopping another parent.' }), conversationId)
      expect(sent.success).toBe(true)
      await expect.poll(() => model.exchanges.some(exchange => exchange.request.text.includes('UNRELATED_SESSION:') && exchange.completed), { timeout: 45000 }).toBe(true)
      await waitForStoppedIdle(conversationId)
      expect(childRequests).toHaveLength(childSequences.length)
      expect(errors).toEqual([])
      await info.attach('parent-stop-owned-child', { body: JSON.stringify({ engine: sdkEngine, source: source.conversationId, handle, childSequences, cancelled: model.exchanges.filter(exchange => childSequences.includes(exchange.request.sequence)).map(exchange => exchange.cancelled) }, null, 2), contentType: 'application/json' })
    } finally { gate.release() }
  })
})
