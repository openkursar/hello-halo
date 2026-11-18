import { test, expect, OWNER_ID, GROUP_ID, waitForImIdle } from '../fixtures/acceptance-guest'
import { acceptance } from '../fixtures/acceptance-app'
import { startAcceptanceModel } from '../fixtures/acceptance-model'
import { configureRoutingTarget, assignmentRoutingScript } from '../fixtures/acceptance-subagent-routing'

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const) test.describe(`Owner IM assignment routing on ${sdkEngine}`, () => {
  test.use({ sdkEngine, diagnoseShutdown: true })
  test('an owner IM uses the configured endpoint and reviews its result before replying', acceptance('models.subagent-profiles.owner-routing', { engine: sdkEngine, entry: 'owner-im', choice: 'profile' }), async ({ guestApp, wecom, model, window }, info) => {
    test.setTimeout(180000)
    const endpoint = await startAcceptanceModel()
    const marker = 'OWNER_IM_ASSIGNMENT: Ask Verifier to check this work.'
    const script = assignmentRoutingScript()
    model.respond(script.parent)
    endpoint.respond(script.child)
    try {
      await configureRoutingTarget(window, endpoint)
      await wecom.sendText({ senderId: OWNER_ID, senderName: 'Owner', chatId: GROUP_ID, chatType: 'group', text: marker })
      await wecom.waitForReply({ chatId: GROUP_ID, contains: 'The assignment returned assigned-target-confirmed.', timeoutMs: 120000 })
      await waitForImIdle(window, guestApp, GROUP_ID, 'group')
      expect(script.handle).toBeTruthy()
      expect(script.errors).toEqual([])
      expect(script.childRequests.length).toBeGreaterThan(0)
      expect(endpoint.errors).toEqual([])
      for (const request of script.childRequests) expect(request.body.model).toBe('gpt-4o')
      expect(wecom.replies.some(reply => reply.text === 'assigned-target-confirmed')).toBe(false)
    } finally {
      await info.attach('assigned-im-provider-exchanges', { body: JSON.stringify(endpoint.exchanges, null, 2), contentType: 'application/json' })
      await endpoint.close()
    }
  })
})
