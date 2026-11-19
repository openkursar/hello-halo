import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance } from '../fixtures/acceptance-automation'
import { startAcceptanceModel } from '../fixtures/acceptance-model'
import { configureRoutingTarget, assignmentRoutingScript } from '../fixtures/acceptance-subagent-routing'

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const) test.describe(`Digital-human assignment routing on ${sdkEngine}`, () => {
  test.use({ sdkEngine })
  test('an owner chat dispatches its exact configured target', acceptance('models.subagent-profiles.owner-routing', { engine: sdkEngine, entry: 'digital-human', choice: 'profile' }), async ({ model, automation, window }, info) => {
    test.setTimeout(180000)
    const endpoint = await startAcceptanceModel()
    const marker = 'OWNER_PERSON_ASSIGNMENT: Ask Verifier to check this work.'
    const script = assignmentRoutingScript({ sourceMarker: marker })
    model.respond(script.parent)
    endpoint.respond(script.child)
    try {
      await configureRoutingTarget(window, endpoint)
      const session = await window.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.appSessionCreate({ appId }), automation.appId)
      expect(session.success).toBe(true)
      const conversationId = session.data!.conversationId
      const sent = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatSend(input), { appId: automation.appId, spaceId: 'halo-temp', conversationId, message: marker })
      expect(sent.success, sent.error).toBe(true)
      await expect.poll(async () => {
        const transcript = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatTranscript(input), { appId: automation.appId, spaceId: 'halo-temp', conversationId })
        return transcript.data?.messages.some(message => message.role === 'assistant' && message.content.includes('The assignment returned assigned-target-confirmed.')) ?? false
      }, { timeout: 120000 }).toBe(true)
      expect(script.handle).toBeTruthy()
      expect(script.errors).toEqual([])
      expect(script.childRequests.length).toBeGreaterThan(0)
      expect(endpoint.errors).toEqual([])
      for (const request of script.childRequests) expect(request.body.model).toBe('gpt-4o')
    } finally {
      await info.attach('assigned-person-provider-exchanges', { body: JSON.stringify(endpoint.exchanges, null, 2), contentType: 'application/json' })
      await endpoint.close()
    }
  })
})
